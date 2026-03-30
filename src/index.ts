import fs from 'fs';
import path from 'path';

import {
  ADMIN_WEB_HOST,
  ADMIN_WEB_PORT,
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  SERVICE_AGENT_TYPE,
  SERVICE_ID,
  SERVICE_ROLE,
  isSessionCommandSenderAllowed,
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  USAGE_UPDATE_INTERVAL,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot } from './agent-runner.js';
import { listAvailableGroups } from './available-groups.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLatestMessageSeqAtOrBefore,
  hasRecentRestartAnnouncement,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { composeDashboardContent } from './dashboard-render.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatOutbound } from './router.js';
import {
  buildDiscordVoiceAliases,
  parseDiscordVoiceChannelIds,
  parseDiscordVoiceRouteMap,
  parseDiscordVoiceValueMap,
} from './discord-voice-routing.js';
import {
  buildRestartAnnouncement,
  buildInterruptedRestartAnnouncement,
  consumeRestartContext,
  getInterruptedRecoveryCandidates,
  inferRecentRestartContext,
  type RestartContext,
  writeShutdownRestartContext,
} from './restart-context.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { createMessageRuntime } from './message-runtime.js';
import { nudgeSchedulerLoop, startSchedulerLoop } from './task-scheduler.js';
import { startUnifiedDashboard } from './unified-dashboard.js';
import { startAdminWebServer } from './admin-web.js';
import { Channel, NewMessage, RegisteredGroup, ServiceRole } from './types.js';
import { logger } from './logger.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import { getEnv } from './env.js';
import { initCodexTokenRotation } from './codex-token-rotation.js';
import { shouldStartInteractiveRuntime } from './service-role.js';
import { initTokenRotation } from './token-rotation.js';
import {
  shouldStartTokenRefreshLoop,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
} from './token-refresh.js';

// Token rotation is initialized lazily on first use or at startup below

export async function sendFormattedChannelMessage(
  channels: Channel[],
  jid: string,
  rawText: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot send message');
    return;
  }
  const text = formatOutbound(rawText);
  if (text) await channel.sendMessage(jid, text);
}

export async function sendFormattedTrackedChannelMessage(
  channels: Channel[],
  jid: string,
  rawText: string,
): Promise<string | null> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot send tracked message');
    return null;
  }
  const text = formatOutbound(rawText);
  if (!text || !channel.sendAndTrack) return null;
  return channel.sendAndTrack(jid, text);
}

export async function editFormattedTrackedChannelMessage(
  channels: Channel[],
  jid: string,
  messageId: string,
  rawText: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot edit tracked message');
    return;
  }
  const text = formatOutbound(rawText);
  if (!text || !channel.editMessage) return;
  await channel.editMessage(jid, messageId, text);
}

export function requiresConnectedChannels(serviceRole: ServiceRole): boolean {
  return shouldStartInteractiveRuntime(serviceRole);
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();
const runtime = createMessageRuntime({
  assistantName: ASSISTANT_NAME,
  idleTimeout: IDLE_TIMEOUT,
  pollInterval: POLL_INTERVAL,
  timezone: TIMEZONE,
  triggerPattern: TRIGGER_PATTERN,
  channels,
  queue,
  getRegisteredGroups: () => registeredGroups,
  getSessions: () => sessions,
  getLastTimestamp: () => lastTimestamp,
  setLastTimestamp: (timestamp) => {
    lastTimestamp = timestamp;
  },
  getLastAgentTimestamps: () => lastAgentTimestamp,
  saveState,
  persistSession: (groupFolder, sessionId) => {
    sessions[groupFolder] = sessionId;
    setSession(groupFolder, sessionId);
  },
  clearSession,
});

function applyDiscordVoiceAliases(): void {
  const voiceChannelIds = parseDiscordVoiceChannelIds(
    getEnv('DISCORD_VOICE_CHANNEL_IDS') || getEnv('DISCORD_VOICE_CHANNEL_ID'),
  );
  if (voiceChannelIds.length === 0) return;

  const routeMap = parseDiscordVoiceRouteMap({
    voiceChannelIds,
    raw: getEnv('DISCORD_VOICE_ROUTE_MAP'),
    defaultTargetJid:
      getEnv('DISCORD_VOICE_TARGET_JID') || getEnv('DISCORD_VOICE_SESSION_JID'),
  });
  if (routeMap.size === 0) return;

  const aliases = buildDiscordVoiceAliases({
    registeredGroups,
    routeMap,
    agentType: SERVICE_AGENT_TYPE,
    folderMap: parseDiscordVoiceValueMap(
      getEnv('DISCORD_VOICE_GROUP_FOLDER_MAP'),
    ),
    nameMap: parseDiscordVoiceValueMap(getEnv('DISCORD_VOICE_GROUP_NAME_MAP')),
    defaultFolder: getEnv('DISCORD_VOICE_GROUP_FOLDER'),
    defaultName: getEnv('DISCORD_VOICE_GROUP_NAME'),
  });
  if (Object.keys(aliases).length === 0) return;

  registeredGroups = {
    ...registeredGroups,
    ...aliases,
  };
  logger.info(
    {
      aliasCount: Object.keys(aliases).length,
      aliases: Object.entries(aliases).map(([voiceJid, group]) => ({
        voiceJid,
        targetFolder: group.folder,
      })),
    },
    'Applied Discord voice routing aliases',
  );
}

function loadState(): void {
  lastTimestamp = normalizeStoredSeqCursor(
    getRouterState('last_seq') || getRouterState('last_timestamp'),
  );
  const agentTs =
    getRouterState('last_agent_seq') || getRouterState('last_agent_timestamp');
  try {
    const parsed = agentTs
      ? (JSON.parse(agentTs) as Record<string, string>)
      : {};
    lastAgentTimestamp = Object.fromEntries(
      Object.entries(parsed).map(([chatJid, cursor]) => [
        chatJid,
        normalizeStoredSeqCursor(cursor, chatJid),
      ]),
    );
  } catch {
    logger.warn('Corrupted last_agent_seq in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  // Load only this service's registrations. The DB can hold both
  // claude-code and codex rows for the same Discord JID.
  registeredGroups = getAllRegisteredGroups({ agentType: SERVICE_AGENT_TYPE });
  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentType: SERVICE_AGENT_TYPE,
    },
    'State loaded',
  );
  applyDiscordVoiceAliases();
}

function saveState(): void {
  setRouterState('last_seq', lastTimestamp);
  setRouterState('last_agent_seq', JSON.stringify(lastAgentTimestamp));
}

function clearSession(groupFolder: string): void {
  delete sessions[groupFolder];
  deleteSession(groupFolder);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./agent-runner.js').AvailableGroup[] {
  return listAvailableGroups(registeredGroups);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

async function announceRestartRecovery(
  processStartedAtMs: number,
): Promise<RestartContext | null> {
  const explicitContext = consumeRestartContext();
  const dedupeSince = new Date(processStartedAtMs - 60_000).toISOString();
  if (explicitContext) {
    if (hasRecentRestartAnnouncement(explicitContext.chatJid, dedupeSince)) {
      logger.info(
        { chatJid: explicitContext.chatJid },
        'Skipped duplicate restart recovery announcement',
      );
      return explicitContext;
    }

    await sendFormattedChannelMessage(
      channels,
      explicitContext.chatJid,
      buildRestartAnnouncement(explicitContext),
    );
    logger.info(
      { chatJid: explicitContext.chatJid },
      'Sent explicit restart recovery announcement',
    );

    for (const interrupted of explicitContext.interruptedGroups ?? []) {
      if (interrupted.chatJid === explicitContext.chatJid) continue;
      if (hasRecentRestartAnnouncement(interrupted.chatJid, dedupeSince)) {
        continue;
      }
      await sendFormattedChannelMessage(
        channels,
        interrupted.chatJid,
        buildInterruptedRestartAnnouncement(interrupted),
      );
    }
    return explicitContext;
  }

  const inferred = inferRecentRestartContext(
    registeredGroups,
    processStartedAtMs,
  );
  if (!inferred) return null;

  if (hasRecentRestartAnnouncement(inferred.chatJid, dedupeSince)) {
    logger.info(
      { chatJid: inferred.chatJid },
      'Skipped duplicate inferred restart recovery announcement',
    );
    return null;
  }

  await sendFormattedChannelMessage(
    channels,
    inferred.chatJid,
    inferred.lines.join('\n'),
  );
  logger.info(
    { chatJid: inferred.chatJid },
    'Sent inferred restart recovery announcement',
  );
  return null;
}

async function main(): Promise<void> {
  const processStartedAtMs = Date.now();
  const interactiveRuntime = shouldStartInteractiveRuntime(SERVICE_ROLE);
  initDatabase();
  logger.info('Database initialized');
  initTokenRotation();
  initCodexTokenRotation();

  // Only the Claude service owns Claude OAuth refresh to avoid
  // cross-service refresh-token races on shared credentials.
  if (interactiveRuntime && shouldStartTokenRefreshLoop(SERVICE_AGENT_TYPE)) {
    startTokenRefreshLoop();
  } else {
    const refreshSkipReason = !interactiveRuntime
      ? 'Skipping Claude OAuth token auto-refresh for non-interactive service role'
      : SERVICE_AGENT_TYPE !== 'claude-code'
        ? 'Skipping Claude OAuth token auto-refresh for non-Claude service'
        : 'Skipping Claude OAuth credential-file refresh; service uses direct tokens only';
    logger.info(
      {
        serviceAgentType: SERVICE_AGENT_TYPE,
        serviceRole: SERVICE_ROLE,
      },
      refreshSkipReason,
    );
  }

  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopTokenRefreshLoop();
    const interruptedGroups = queue
      .getStatuses(Object.keys(registeredGroups))
      .filter(
        (
          status,
        ): status is typeof status & {
          status: 'processing' | 'waiting';
        } => status.status !== 'inactive',
      )
      .map((status) => ({
        chatJid: status.jid,
        groupName: registeredGroups[status.jid]?.name || status.jid,
        status: status.status,
        elapsedMs: status.elapsedMs,
        pendingMessages: status.pendingMessages,
        pendingTasks: status.pendingTasks,
      }));
    const writtenPaths = writeShutdownRestartContext(
      registeredGroups,
      interruptedGroups,
      signal,
    );
    if (writtenPaths.length > 0) {
      logger.info(
        {
          signal,
          interruptedGroupCount: interruptedGroups.length,
          writtenPaths,
        },
        'Stored shutdown restart context for interrupted groups',
      );
    }
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      if (!interactiveRuntime) return;
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      if (!interactiveRuntime) return;
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    if (requiresConnectedChannels(SERVICE_ROLE)) {
      logger.fatal('No channels connected');
      process.exit(1);
    }
    logger.warn(
      { serviceRole: SERVICE_ROLE },
      'No channels connected, continuing in admin-only mode',
    );
  }

  await startUnifiedDashboard({
    assistantName: ASSISTANT_NAME,
    serviceId: SERVICE_ID,
    serviceAgentType: SERVICE_AGENT_TYPE,
    serviceRole: SERVICE_ROLE,
    statusChannelId: STATUS_CHANNEL_ID,
    statusUpdateInterval: STATUS_UPDATE_INTERVAL,
    usageUpdateInterval: USAGE_UPDATE_INTERVAL,
    channels,
    queue,
    registeredGroups: () => registeredGroups,
    onGroupNameSynced: (jid, name) => {
      const group = registeredGroups[jid];
      if (group) {
        group.name = name;
      }
    },
  });

  if (!interactiveRuntime) {
    if (SERVICE_ROLE === 'dashboard') {
      await startAdminWebServer({
        projectRoot: process.cwd(),
        host: ADMIN_WEB_HOST,
        port: ADMIN_WEB_PORT,
      });
    }
    logger.info(
      { serviceRole: SERVICE_ROLE },
      'Interactive runtime disabled for service role',
    );
    return;
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, processName, ipcDir) =>
      queue.registerProcess(groupJid, proc, processName, ipcDir),
    sendMessage: (jid, rawText) =>
      sendFormattedChannelMessage(channels, jid, rawText),
    sendTrackedMessage: (jid, rawText) =>
      sendFormattedTrackedChannelMessage(channels, jid, rawText),
    editTrackedMessage: (jid, messageId, rawText) =>
      editFormattedTrackedChannelMessage(channels, jid, messageId, rawText),
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    nudgeScheduler: nudgeSchedulerLoop,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot,
  });
  queue.setProcessMessagesFn(runtime.processGroupMessages);
  queue.enterRecoveryMode();
  runtime.recoverPendingMessages();
  const restartContext = await announceRestartRecovery(processStartedAtMs);
  for (const candidate of getInterruptedRecoveryCandidates(
    restartContext,
    registeredGroups,
  )) {
    queue.enqueueMessageCheck(
      candidate.chatJid,
      resolveGroupIpcPath(candidate.groupFolder),
    );
    logger.info(
      {
        chatJid: candidate.chatJid,
        groupFolder: candidate.groupFolder,
        status: candidate.status,
        pendingMessages: candidate.pendingMessages,
        pendingTasks: candidate.pendingTasks,
      },
      'Queued interrupted group for restart recovery',
    );
  }
  runtime.startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start HKClaw');
    process.exit(1);
  });
}
