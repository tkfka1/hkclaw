import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SERVICE_ID } from './config.js';
import { buildCodexUsageRowsFromState } from './codex-usage-collector.js';
import { InvalidAdminInputError } from './admin-errors.js';
import {
  extractCodexUsageRows,
  type UsageRow,
} from './dashboard-usage-rows.js';
import {
  createAdminWebChatMessage,
  deleteOfficeTeam,
  deleteRegisteredGroup,
  getAdminWebChatMessages,
  getAllChats,
  getOfficeCompanySettings,
  getOfficeTeam,
  getOfficeTeams,
  getOpenWorkItem,
  getRecentMessages,
  getRegisteredGroup,
  getRegisteredGroupAssignments,
  renameGroupFolderReferences,
  setRegisteredGroup,
  upsertOfficeCompanySettings,
  upsertOfficeTeam,
  type ChatInfo,
} from './db.js';
import { upsertEnvFile } from './env-file-editor.js';
import { parseEnvFilePath } from './env.js';
import { parseDiscordChannelId } from './discord-channel-id.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveGroupSessionsPath,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  buildEffectiveServiceEnv as buildEffectiveManagedServiceEnv,
  diagnoseServiceHealth,
  summarizeServiceHealthConfig,
  type ServiceDiagnostic,
} from './service-health.js';
import {
  discoverConfiguredServices,
  type DiscoveredService,
} from './service-discovery.js';
import { getPrimaryServiceOverlayPath } from './service-discovery.js';
import {
  normalizeServiceId,
  parseAgentType,
  parseServiceRole,
} from './service-metadata.js';
import {
  assignServiceTemperament,
  deleteTemperamentDefinition,
  getServiceTemperament,
  listTemperaments,
  upsertTemperamentDefinition,
} from './service-temperament.js';
import { readStatusSnapshots } from './status-dashboard.js';
import type {
  AgentType,
  NewMessage,
  RegisteredGroup,
  ServiceRole,
} from './types.js';

const ADMIN_STATUS_SNAPSHOT_MAX_AGE_MS = 120_000;
const ADMIN_USAGE_SNAPSHOT_MAX_AGE_MS = 600_000;
const ADMIN_CONTROL_LOG = 'admin-control.log';
const TOPOLOGY_RECONCILE_TIMEOUT_MS = 180_000;
const SERVICE_RUNTIME_WAIT_TIMEOUT_MS = 12_000;
const SERVICE_RUNTIME_POLL_INTERVAL_MS = 300;
const TEAM_COLOR_PALETTE = [
  '#ffbf69',
  '#58d4ba',
  '#7cb7ff',
  '#ff8d7b',
  '#f2d58b',
  '#b78cff',
];
const runningAdminChats = new Set<string>();
const PRIMARY_SERVICE_ENV_KEYS = [
  'ASSISTANT_NAME',
  'SERVICE_ID',
  'SERVICE_AGENT_TYPE',
  'SERVICE_ROLE',
  'DISCORD_BOT_TOKEN',
  'STATUS_CHANNEL_ID',
  'USAGE_DASHBOARD',
  'DISCORD_VOICE_CHANNEL_IDS',
  'DISCORD_VOICE_CHANNEL_ID',
  'DISCORD_VOICE_TARGET_JID',
  'DISCORD_VOICE_SESSION_JID',
  'DISCORD_VOICE_ROUTE_MAP',
  'DISCORD_VOICE_GROUP_FOLDER',
  'DISCORD_VOICE_GROUP_NAME',
  'DISCORD_VOICE_RECONNECT_DELAY_MS',
  'DISCORD_LIVE_VOICE_SILENCE_MS',
  'DISCORD_LIVE_VOICE_MIN_PCM_BYTES',
  'DISCORD_EDGE_TTS_RATE',
  'DISCORD_EDGE_TTS_VOICE',
  'DISCORD_EDGE_TTS_LANG',
  'DISCORD_EDGE_TTS_OUTPUT_FORMAT',
  'DISCORD_EDGE_TTS_TIMEOUT_MS',
  'DISCORD_EDGE_TTS_MAX_CHARS',
  'DISCORD_VOICE_OUTPUT_BITRATE',
  'DISCORD_GROQ_TRANSCRIPTION_MODEL',
  'DISCORD_OPENAI_TRANSCRIPTION_MODEL',
  'DISCORD_TRANSCRIPTION_LANGUAGE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKENS',
  'CLAUDE_CODE_USE_CREDENTIAL_FILES',
  'CODEX_AUTH_JSON_B64',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'CODEX_MODEL',
  'CODEX_EFFORT',
  'CODEX_USE_HOME_AUTH',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_CLI_PATH',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_MODEL',
  'LOCAL_LLM_API_KEY',
  'FALLBACK_ENABLED',
  'FALLBACK_PROVIDER_NAME',
  'FALLBACK_BASE_URL',
  'FALLBACK_AUTH_TOKEN',
  'FALLBACK_MODEL',
  'FALLBACK_SMALL_MODEL',
  'FALLBACK_COOLDOWN_MS',
] as const;
export interface ServiceEnvSummary {
  assistantName: string;
  serviceId: string;
  agentType: AgentType;
  role: ServiceRole;
  statusChannelId: string;
  usageDashboard: boolean;
  voiceChannelIds: string;
  voiceTargetJid: string;
  voiceRouteMap: string;
  voiceGroupFolder: string;
  voiceGroupName: string;
  voiceReconnectDelayMs: string;
  liveVoiceSilenceMs: string;
  liveVoiceMinPcmBytes: string;
  edgeTtsRate: string;
  edgeTtsVoice: string;
  edgeTtsLang: string;
  edgeTtsOutputFormat: string;
  edgeTtsTimeoutMs: string;
  edgeTtsMaxChars: string;
  voiceOutputBitrate: string;
  botTokenConfigured: boolean;
  botTokenValue: string;
  anthropicBaseUrl: string;
  anthropicAuthTokenConfigured: boolean;
  anthropicAuthTokenValue: string;
  claudeCodeOauthTokenConfigured: boolean;
  claudeCodeOauthTokenValue: string;
  claudeCodeOauthTokensConfigured: boolean;
  claudeCodeOauthTokensValue: string;
  codexAuthJsonConfigured: boolean;
  codexAuthJsonValue: string;
  geminiApiKeyConfigured: boolean;
  geminiApiKeyValue: string;
  geminiModel: string;
  geminiCliPath: string;
  openAiApiKeyConfigured: boolean;
  openAiApiKeyValue: string;
  groqApiKeyConfigured: boolean;
  groqApiKeyValue: string;
  groqTranscriptionModel: string;
  openAiTranscriptionModel: string;
  transcriptionLanguage: string;
  anthropicApiKeyConfigured: boolean;
  fallbackEnabled: '' | 'true' | 'false';
  fallbackProviderName: string;
  fallbackBaseUrl: string;
  fallbackAuthTokenConfigured: boolean;
  fallbackAuthTokenValue: string;
  fallbackModel: string;
  fallbackSmallModel: string;
  fallbackCooldownMs: string;
  codexModel: string;
  codexEffort: string;
  codexUseHomeAuth: boolean;
  localLlmBaseUrl: string;
  localLlmModel: string;
  localLlmApiKeyConfigured: boolean;
  localLlmApiKeyValue: string;
  temperamentId: string;
  temperamentName: string;
  temperamentPrompt: string;
}

export interface ServiceRuntimeState {
  manager: 'systemd-user' | 'systemd-system' | 'launchd' | 'none';
  activeState: string;
  subState: string;
  running: boolean;
  mainPid: number | null;
  error?: string;
}

export interface AdminServiceState {
  serviceId: string;
  serviceName: string;
  assistantName: string;
  agentType: AgentType;
  role: ServiceRole;
  presence: 'offline' | 'resting' | 'working' | 'monitoring';
  currentJid: string | null;
  source: DiscoveredService['source'];
  envPath: string;
  runtime: ServiceRuntimeState;
  snapshot: {
    updatedAt: string | null;
    roomCount: number;
    activeRooms: number;
    activeJids: string[];
    stale: boolean;
  };
  assignmentCount: number;
  diagnostics: ServiceDiagnostic[];
  config: ServiceEnvSummary;
}

export interface AdminChannelAssignment {
  serviceId: string;
  serviceName: string;
  assistantName: string;
  role: ServiceRole;
  agentType: AgentType;
  kind: 'group' | 'status-dashboard';
  folder?: string;
  requiresTrigger: boolean;
  isMain: boolean;
}

export interface AdminChannelState {
  jid: string;
  name: string;
  channel: string;
  isGroup: boolean;
  lastMessageTime: string | null;
  customerFlow:
    | 'idle'
    | 'customer-arrived'
    | 'order-taking'
    | 'cooking'
    | 'handoff-ready'
    | 'served';
  customerSummary: string;
  latestInboundAt: string | null;
  latestOutboundAt: string | null;
  activeServiceIds: string[];
  openWorkItemCount: number;
  assignments: AdminChannelAssignment[];
}

export interface AdminCounterState {
  counterId: string;
  jid: string;
  name: string;
  stationName: string;
  source: 'manual' | 'channel';
  teamId: string | null;
  folder: string | null;
  requiresMention: boolean;
  layoutLeft: number | null;
  layoutTop: number | null;
  layoutWidth: number | null;
  layoutHeight: number | null;
  color: string;
  customerFlow:
    | 'idle'
    | 'customer-arrived'
    | 'order-taking'
    | 'cooking'
    | 'handoff-ready'
    | 'served';
  customerSummary: string;
  latestInboundAt: string | null;
  latestOutboundAt: string | null;
  activeServiceIds: string[];
  assignedServiceIds: string[];
  memberServiceIds: string[];
  openWorkItemCount: number;
  assignmentCount: number;
  assignments: AdminChannelAssignment[];
}

export interface AdminTeamState {
  teamId: string;
  name: string;
  linkedJid: string | null;
  linkedChannelName: string | null;
  folder: string | null;
  requiresMention: boolean;
  layoutLeft: number | null;
  layoutTop: number | null;
  layoutWidth: number | null;
  layoutHeight: number | null;
  folderMixed: boolean;
  source: 'manual' | 'channel';
  color: string;
  assignedServiceIds: string[];
  memberServiceIds: string[];
  activeServiceIds: string[];
}

export interface AdminChatMessageState {
  id: string | number;
  serviceId: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  createdAt: string;
  senderName?: string;
}

export interface AdminServiceLogsState {
  serviceId: string;
  serviceName: string;
  stdoutPath: string;
  stderrPath: string;
  stdout: string;
  stderr: string;
  loadedAt: string;
}

export interface AdminRoomLayoutState {
  left: number;
  top: number;
  width?: number;
  height?: number;
  name?: string;
}

export interface AdminCodexUsageState {
  rows: UsageRow[];
  fetchedAt: string | null;
  stale: boolean;
}

export interface AdminState {
  generatedAt: string;
  currentServiceId: string;
  company: {
    companyName: string;
    officeTitle: string;
    officeSubtitle: string;
    roomLayouts: Record<string, AdminRoomLayoutState>;
    updatedAt: string | null;
  };
  usage: {
    codex: AdminCodexUsageState;
  };
  services: AdminServiceState[];
  counters: AdminCounterState[];
  channels: AdminChannelState[];
  teams: AdminTeamState[];
  temperaments: Array<{
    temperamentId: string;
    name: string;
    prompt: string;
    updatedAt: string;
    builtin?: boolean;
  }>;
}

export interface ServiceConfigInput {
  existingServiceId?: string;
  serviceId?: string;
  assistantName: string;
  agentType: string;
  role?: string;
  teamJid?: string;
  statusChannelId?: string;
  usageDashboard?: boolean;
  voiceChannelIds?: string;
  voiceTargetJid?: string;
  voiceRouteMap?: string;
  voiceGroupFolder?: string;
  voiceGroupName?: string;
  voiceReconnectDelayMs?: string;
  liveVoiceSilenceMs?: string;
  liveVoiceMinPcmBytes?: string;
  edgeTtsRate?: string;
  edgeTtsVoice?: string;
  edgeTtsLang?: string;
  edgeTtsOutputFormat?: string;
  edgeTtsTimeoutMs?: string;
  edgeTtsMaxChars?: string;
  voiceOutputBitrate?: string;
  discordBotToken?: string;
  clearDiscordBotToken?: boolean;
  temperamentId?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  clearAnthropicAuthToken?: boolean;
  claudeCodeOauthToken?: string;
  clearClaudeCodeOauthToken?: boolean;
  claudeCodeOauthTokens?: string;
  clearClaudeCodeOauthTokens?: boolean;
  codexAuthJson?: string;
  clearCodexAuthJson?: boolean;
  geminiApiKey?: string;
  clearGeminiApiKey?: boolean;
  geminiModel?: string;
  geminiCliPath?: string;
  openAiApiKey?: string;
  clearOpenAiApiKey?: boolean;
  groqApiKey?: string;
  clearGroqApiKey?: boolean;
  groqTranscriptionModel?: string;
  openAiTranscriptionModel?: string;
  transcriptionLanguage?: string;
  codexModel?: string;
  codexEffort?: string;
  localLlmBaseUrl?: string;
  localLlmModel?: string;
  localLlmApiKey?: string;
  clearLocalLlmApiKey?: boolean;
  fallbackEnabled?: string;
  fallbackProviderName?: string;
  fallbackBaseUrl?: string;
  fallbackAuthToken?: string;
  clearFallbackAuthToken?: boolean;
  fallbackModel?: string;
  fallbackSmallModel?: string;
  fallbackCooldownMs?: string;
}

export interface ServiceTemperamentAssignmentInput {
  serviceId: string;
  temperamentId?: string;
}

export interface TemperamentDefinitionInput {
  temperamentId?: string;
  name: string;
  prompt: string;
}

export interface OfficeTeamInput {
  teamId?: string;
  name: string;
  linkedJid?: string;
  folder?: string;
  requiresMention?: boolean;
  color?: string;
}

export interface OfficeTeamLayoutInput {
  teamId: string;
  left: number;
  top: number;
  width?: number;
  height?: number;
  name?: string;
}

export interface OfficeRoomLayoutInput {
  roomId: string;
  left: number;
  top: number;
  width?: number;
  height?: number;
  name?: string;
}

export interface OfficeCompanySettingsInput {
  companyName?: string;
  officeTitle?: string;
  officeSubtitle?: string;
}

const DEFAULT_STORE_ROOM_LAYOUTS: Record<string, AdminRoomLayoutState> = {};

function normalizeOfficeRoomId(roomId: string): string {
  const normalizedRoomId = roomId.trim();
  return normalizedRoomId === 'assistant' ? 'hr' : normalizedRoomId;
}

function parseRoomLayouts(
  rawValue: string | null | undefined,
): Record<string, AdminRoomLayoutState> {
  if (!rawValue) return {};

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce<Record<string, AdminRoomLayoutState>>(
      (roomLayouts, [roomId, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return roomLayouts;
        }

        const left = Number((value as { left?: unknown }).left);
        const top = Number((value as { top?: unknown }).top);
        const width = Number((value as { width?: unknown }).width);
        const height = Number((value as { height?: unknown }).height);
        const name = String((value as { name?: unknown }).name || '').trim();
        if (!Number.isFinite(left) || !Number.isFinite(top)) {
          return roomLayouts;
        }

        const normalizedRoomId = normalizeOfficeRoomId(roomId);
        if (!normalizedRoomId) {
          return roomLayouts;
        }
        if (normalizedRoomId in roomLayouts && roomId.trim() === 'assistant') {
          return roomLayouts;
        }

        roomLayouts[normalizedRoomId] = {
          left,
          top,
          ...(Number.isFinite(width) ? { width } : {}),
          ...(Number.isFinite(height) ? { height } : {}),
          ...(name ? { name } : {}),
        };
        return roomLayouts;
      },
      {},
    );
  } catch {
    return {};
  }
}

function stringifyRoomLayouts(
  roomLayouts: Record<string, AdminRoomLayoutState>,
): string | null {
  const entries = Object.entries(roomLayouts).filter(
    ([, value]) => Number.isFinite(value?.left) && Number.isFinite(value?.top),
  );
  if (!entries.length) return null;
  return JSON.stringify(
    Object.fromEntries(
      entries.map(([roomId, value]) => [
        roomId,
        {
          left: value.left,
          top: value.top,
          ...(Number.isFinite(value.width) ? { width: value.width } : {}),
          ...(Number.isFinite(value.height) ? { height: value.height } : {}),
          ...(value.name?.trim() ? { name: value.name.trim() } : {}),
        },
      ]),
    ),
  );
}

function buildAdminCodexUsageState(
  now: number = Date.now(),
): AdminCodexUsageState {
  const codexSnapshots = readStatusSnapshots(
    ADMIN_STATUS_SNAPSHOT_MAX_AGE_MS,
  ).filter((snapshot) => snapshot.agentType === 'codex');
  const snapshotRows: UsageRow[] = [];
  let freshestFetchedAt = 0;
  let hasFreshSnapshotRows = false;

  for (const snapshot of codexSnapshots) {
    const extracted = extractCodexUsageRows(
      snapshot,
      ADMIN_USAGE_SNAPSHOT_MAX_AGE_MS,
      now,
    );
    if (extracted.some((row) => row.h5pct >= 0 || row.d7pct >= 0)) {
      hasFreshSnapshotRows = true;
    }
    snapshotRows.push(
      ...extracted.map((row) => ({
        ...row,
        name:
          codexSnapshots.length > 1
            ? `${row.name} (${snapshot.serviceId})`
            : row.name,
      })),
    );

    const fetchedAt = snapshot.usageRowsFetchedAt
      ? new Date(snapshot.usageRowsFetchedAt).getTime()
      : 0;
    if (Number.isFinite(fetchedAt) && fetchedAt > freshestFetchedAt) {
      freshestFetchedAt = fetchedAt;
    }
  }

  const fallbackRows = buildCodexUsageRowsFromState();
  const rows = hasFreshSnapshotRows
    ? snapshotRows
    : fallbackRows.length > 0
      ? fallbackRows
      : snapshotRows;

  return {
    rows,
    fetchedAt:
      freshestFetchedAt > 0 ? new Date(freshestFetchedAt).toISOString() : null,
    stale:
      rows.length > 0 &&
      (freshestFetchedAt <= 0 ||
        now - freshestFetchedAt > ADMIN_USAGE_SNAPSHOT_MAX_AGE_MS),
  };
}

function getServiceManager():
  | 'systemd-user'
  | 'systemd-system'
  | 'launchd'
  | 'none' {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform !== 'linux') return 'none';
  try {
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    if (init !== 'systemd') return 'none';
    return process.getuid?.() === 0 ? 'systemd-system' : 'systemd-user';
  } catch {
    return 'none';
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.trim().toLowerCase() === 'true';
}

function isDiscordChat(chat: {
  jid: string;
  channel?: string | null;
}): boolean {
  return chat.channel === 'discord' || chat.jid.startsWith('dc:');
}

function isValidAdminChannelJid(jid: string): boolean {
  if (jid.startsWith('dc:')) {
    return Boolean(parseDiscordChannelId(jid));
  }
  return true;
}

function summarizeServiceEnv(
  projectRoot: string,
  service: DiscoveredService,
  baseEnvOverride?: Record<string, string>,
): ServiceEnvSummary {
  const effective = buildEffectiveManagedServiceEnv(
    projectRoot,
    service,
    baseEnvOverride,
  );
  const health = summarizeServiceHealthConfig(effective);
  const temperament = getServiceTemperament(projectRoot, service.serviceId);
  const fallbackEnabledRaw = (effective.FALLBACK_ENABLED || '')
    .trim()
    .toLowerCase();
  const fallbackEnabled =
    fallbackEnabledRaw === 'true' || fallbackEnabledRaw === 'false'
      ? (fallbackEnabledRaw as 'true' | 'false')
      : '';

  return {
    assistantName: effective.ASSISTANT_NAME || service.assistantName,
    serviceId: service.serviceId,
    agentType: parseAgentType(
      effective.SERVICE_AGENT_TYPE || service.agentType,
      effective.ASSISTANT_NAME || service.assistantName,
    ),
    role: parseServiceRole(
      effective.SERVICE_ROLE || effective.SERVICE_USAGE || service.role,
      service.role,
    ),
    statusChannelId: parseDiscordChannelId(effective.STATUS_CHANNEL_ID) || '',
    usageDashboard: parseBoolean(effective.USAGE_DASHBOARD, false),
    voiceChannelIds:
      effective.DISCORD_VOICE_CHANNEL_IDS ||
      effective.DISCORD_VOICE_CHANNEL_ID ||
      '',
    voiceTargetJid:
      effective.DISCORD_VOICE_TARGET_JID ||
      effective.DISCORD_VOICE_SESSION_JID ||
      '',
    voiceRouteMap: effective.DISCORD_VOICE_ROUTE_MAP || '',
    voiceGroupFolder: effective.DISCORD_VOICE_GROUP_FOLDER || '',
    voiceGroupName: effective.DISCORD_VOICE_GROUP_NAME || '',
    voiceReconnectDelayMs: effective.DISCORD_VOICE_RECONNECT_DELAY_MS || '',
    liveVoiceSilenceMs: effective.DISCORD_LIVE_VOICE_SILENCE_MS || '',
    liveVoiceMinPcmBytes: effective.DISCORD_LIVE_VOICE_MIN_PCM_BYTES || '',
    edgeTtsRate: effective.DISCORD_EDGE_TTS_RATE || '',
    edgeTtsVoice: effective.DISCORD_EDGE_TTS_VOICE || '',
    edgeTtsLang: effective.DISCORD_EDGE_TTS_LANG || '',
    edgeTtsOutputFormat: effective.DISCORD_EDGE_TTS_OUTPUT_FORMAT || '',
    edgeTtsTimeoutMs: effective.DISCORD_EDGE_TTS_TIMEOUT_MS || '',
    edgeTtsMaxChars: effective.DISCORD_EDGE_TTS_MAX_CHARS || '',
    voiceOutputBitrate: effective.DISCORD_VOICE_OUTPUT_BITRATE || '',
    botTokenConfigured: health.botTokenConfigured,
    botTokenValue: effective.DISCORD_BOT_TOKEN || '',
    anthropicApiKeyConfigured: health.anthropicApiKeyConfigured,
    anthropicBaseUrl: effective.ANTHROPIC_BASE_URL || '',
    anthropicAuthTokenConfigured: health.anthropicAuthTokenConfigured,
    anthropicAuthTokenValue: effective.ANTHROPIC_AUTH_TOKEN || '',
    claudeCodeOauthTokenConfigured: health.claudeCodeOauthTokenConfigured,
    claudeCodeOauthTokenValue: effective.CLAUDE_CODE_OAUTH_TOKEN || '',
    claudeCodeOauthTokensConfigured: health.claudeCodeOauthTokensConfigured,
    claudeCodeOauthTokensValue: effective.CLAUDE_CODE_OAUTH_TOKENS || '',
    codexAuthJsonConfigured: health.codexAuthJsonConfigured,
    codexAuthJsonValue: decodeCodexAuthEnvValue(effective.CODEX_AUTH_JSON_B64),
    geminiApiKeyConfigured: health.geminiApiKeyConfigured,
    geminiApiKeyValue: effective.GEMINI_API_KEY || '',
    geminiModel: effective.GEMINI_MODEL || '',
    geminiCliPath: effective.GEMINI_CLI_PATH || '',
    openAiApiKeyConfigured: Boolean(effective.OPENAI_API_KEY),
    openAiApiKeyValue: effective.OPENAI_API_KEY || '',
    groqApiKeyConfigured: Boolean(effective.GROQ_API_KEY),
    groqApiKeyValue: effective.GROQ_API_KEY || '',
    groqTranscriptionModel: effective.DISCORD_GROQ_TRANSCRIPTION_MODEL || '',
    openAiTranscriptionModel:
      effective.DISCORD_OPENAI_TRANSCRIPTION_MODEL || '',
    transcriptionLanguage: effective.DISCORD_TRANSCRIPTION_LANGUAGE || '',
    fallbackEnabled,
    fallbackProviderName: effective.FALLBACK_PROVIDER_NAME || '',
    fallbackBaseUrl: effective.FALLBACK_BASE_URL || '',
    fallbackAuthTokenConfigured: Boolean(effective.FALLBACK_AUTH_TOKEN),
    fallbackAuthTokenValue: effective.FALLBACK_AUTH_TOKEN || '',
    fallbackModel: effective.FALLBACK_MODEL || '',
    fallbackSmallModel: effective.FALLBACK_SMALL_MODEL || '',
    fallbackCooldownMs: effective.FALLBACK_COOLDOWN_MS || '',
    codexModel: effective.CODEX_MODEL || '',
    codexEffort: effective.CODEX_EFFORT || '',
    codexUseHomeAuth: health.codexUseHomeAuth,
    localLlmBaseUrl:
      effective.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1',
    localLlmModel: effective.LOCAL_LLM_MODEL || '',
    localLlmApiKeyConfigured: health.localLlmApiKeyConfigured,
    localLlmApiKeyValue: effective.LOCAL_LLM_API_KEY || '',
    temperamentId: temperament.temperamentId,
    temperamentName: temperament.temperamentName,
    temperamentPrompt: temperament.prompt,
  };
}

function buildEffectiveServiceEnv(
  projectRoot: string,
  service: DiscoveredService,
): Record<string, string> {
  return buildEffectiveManagedServiceEnv(projectRoot, service);
}

function pickPrimaryServiceEnv(
  effectiveEnv: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    PRIMARY_SERVICE_ENV_KEYS.flatMap((key) => {
      const value = effectiveEnv[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function stripPrimaryServiceKeysFromBaseEnv(projectRoot: string): void {
  upsertEnvFile(
    path.join(projectRoot, '.env'),
    Object.fromEntries(PRIMARY_SERVICE_ENV_KEYS.map((key) => [key, null])),
  );
}

function ensurePrimaryServiceOverlay(
  projectRoot: string,
  service: DiscoveredService,
): string {
  const overlayPath =
    service.envOverlayPath || getPrimaryServiceOverlayPath(projectRoot);
  if (!fs.existsSync(overlayPath)) {
    upsertEnvFile(
      overlayPath,
      pickPrimaryServiceEnv(buildEffectiveServiceEnv(projectRoot, service)),
    );
  }
  stripPrimaryServiceKeysFromBaseEnv(projectRoot);
  return overlayPath;
}

function normalizeOptionalEnvValue(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeSecretEnvValue(
  value: string | undefined,
  clear?: boolean,
): string | null | undefined {
  if (clear) return null;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeCodexAuthEnvValue(
  value: string | undefined,
  clear?: boolean,
): string | null | undefined {
  if (clear) return null;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  JSON.parse(trimmed);
  return Buffer.from(trimmed, 'utf-8').toString('base64');
}

function decodeCodexAuthEnvValue(value: string | undefined): string {
  if (!value) return '';
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    JSON.parse(decoded);
    return decoded;
  } catch {
    return '';
  }
}

function normalizeStatusChannelId(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = parseDiscordChannelId(trimmed);
  if (!normalized) {
    throw new InvalidAdminInputError('Invalid Discord status channel ID');
  }
  return normalized;
}

function normalizeTeamId(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

function pickTeamColor(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return TEAM_COLOR_PALETTE[hash % TEAM_COLOR_PALETTE.length];
}

function inspectSystemdService(
  serviceName: string,
  userScope: boolean,
): ServiceRuntimeState {
  const args = [
    ...(userScope ? ['--user'] : []),
    'show',
    serviceName,
    '--property=ActiveState,SubState,MainPID',
  ];

  try {
    const raw = execFileSync('systemctl', args, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const values = Object.fromEntries(
      raw
        .trim()
        .split('\n')
        .map((line) => {
          const [key, ...rest] = line.split('=');
          return [key, rest.join('=')];
        }),
    );
    const mainPid = parseInt(values.MainPID || '0', 10);
    return {
      manager: userScope ? 'systemd-user' : 'systemd-system',
      activeState: values.ActiveState || 'unknown',
      subState: values.SubState || 'unknown',
      running: values.ActiveState === 'active',
      mainPid: Number.isFinite(mainPid) && mainPid > 0 ? mainPid : null,
    };
  } catch (err) {
    return {
      manager: userScope ? 'systemd-user' : 'systemd-system',
      activeState: 'unknown',
      subState: 'unknown',
      running: false,
      mainPid: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function inspectLaunchdService(label: string): ServiceRuntimeState {
  try {
    const output = execFileSync('launchctl', ['list'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const running = output.includes(label);
    return {
      manager: 'launchd',
      activeState: running ? 'active' : 'inactive',
      subState: running ? 'running' : 'stopped',
      running,
      mainPid: null,
    };
  } catch (err) {
    return {
      manager: 'launchd',
      activeState: 'unknown',
      subState: 'unknown',
      running: false,
      mainPid: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function inspectServiceRuntime(
  service: DiscoveredService,
): ServiceRuntimeState {
  const manager = getServiceManager();
  switch (manager) {
    case 'systemd-user':
      return inspectSystemdService(service.serviceName, true);
    case 'systemd-system':
      return inspectSystemdService(service.serviceName, false);
    case 'launchd':
      return inspectLaunchdService(service.launchdLabel);
    default:
      return {
        manager: 'none',
        activeState: 'unknown',
        subState: 'unknown',
        running: false,
        mainPid: null,
      };
  }
}

function shellEscape(value: string): string {
  return JSON.stringify(value);
}

function scheduleShellCommand(projectRoot: string, args: string[]): void {
  const logsDir = path.join(projectRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, ADMIN_CONTROL_LOG);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(
    '/bin/bash',
    ['-lc', `sleep 1; ${args.map(shellEscape).join(' ')}`],
    {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
}

function appendAdminControlLog(projectRoot: string, chunk: string): void {
  if (!chunk) return;
  const logsDir = path.join(projectRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, ADMIN_CONTROL_LOG);
  const text = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
  fs.appendFileSync(logPath, text, 'utf8');
}

function runTopologyReconcileCommand(projectRoot: string): void {
  const startedAt = new Date().toISOString();
  appendAdminControlLog(
    projectRoot,
    `[${startedAt}] sync reconcile start: npm run setup -- --step service`,
  );

  try {
    const stdout = execFileSync(
      'npm',
      ['run', 'setup', '--', '--step', 'service'],
      {
        cwd: projectRoot,
        env: process.env,
        encoding: 'utf8',
        timeout: TOPOLOGY_RECONCILE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (stdout.trim()) {
      appendAdminControlLog(projectRoot, stdout);
    }
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: string | Buffer }).stdout || '')
        : '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: string | Buffer }).stderr || '')
        : '';
    if (stdout.trim()) appendAdminControlLog(projectRoot, stdout);
    if (stderr.trim()) appendAdminControlLog(projectRoot, stderr);
    throw new Error(
      `Service reconcile failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    appendAdminControlLog(
      projectRoot,
      `[${new Date().toISOString()}] sync reconcile end`,
    );
  }
}

function execServiceCommand(
  service: DiscoveredService,
  action: 'restart' | 'start' | 'stop',
): void {
  const manager = getServiceManager();

  if (manager === 'systemd-user' || manager === 'systemd-system') {
    execFileSync(
      'systemctl',
      [
        ...(manager === 'systemd-user' ? ['--user'] : []),
        action,
        service.serviceName,
      ],
      {
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() || 0);
    const domain = `gui/${uid}/${service.launchdLabel}`;
    const command =
      action === 'restart'
        ? ['kickstart', '-k', domain]
        : action === 'start'
          ? ['kickstart', domain]
          : ['bootout', `gui/${uid}`, service.launchdLabel];
    execFileSync('launchctl', command, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  }

  throw new Error('No supported service manager detected');
}

export function buildSuggestedGroupFolder(
  roomName: string,
  serviceId: string,
  takenFolders: Iterable<string>,
): string {
  const taken = new Set(
    [...takenFolders].map((folder) => folder.toLowerCase()),
  );
  const serviceSlug = normalizeServiceId(serviceId, 'service');
  const roomSlug = roomName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  let base = `${serviceSlug}-${roomSlug || 'room'}`.slice(0, 64);
  base = base.replace(/-+$/g, '');
  if (!isValidGroupFolder(base)) {
    base = `${serviceSlug}-room`.slice(0, 64);
  }

  let candidate = base;
  let counter = 2;
  while (!isValidGroupFolder(candidate) || taken.has(candidate.toLowerCase())) {
    const suffix = `-${counter++}`;
    candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }

  return candidate;
}

function buildChannelAssignments(
  services: DiscoveredService[],
  serviceConfigById: Map<string, ServiceEnvSummary>,
): AdminChannelState[] {
  const serviceById = new Map(
    services.map((service) => [service.serviceId, service]),
  );
  const assignments = getRegisteredGroupAssignments({
    allServices: true,
  }).filter((assignment) =>
    isDiscordChat({ jid: assignment.jid, channel: assignment.channel }) &&
    isValidAdminChannelJid(assignment.jid),
  );
  const chats = getAllChats().filter(
    (chat) => isDiscordChat(chat) && isValidAdminChannelJid(chat.jid),
  );
  const chatsByJid = new Map(chats.map((chat) => [chat.jid, chat]));
  const channels = new Map<string, AdminChannelState>();

  for (const chat of chats) {
    channels.set(chat.jid, {
      jid: chat.jid,
      name: chat.name || chat.jid,
      channel: chat.channel || (chat.jid.startsWith('dc:') ? 'discord' : ''),
      isGroup: chat.is_group === 1,
      lastMessageTime: chat.last_message_time || null,
      customerFlow: 'idle',
      customerSummary: '',
      latestInboundAt: null,
      latestOutboundAt: null,
      activeServiceIds: [],
      openWorkItemCount: 0,
      assignments: [],
    });
  }

  for (const assignment of assignments) {
    const existing = channels.get(assignment.jid) || {
      jid: assignment.jid,
      name: assignment.name || assignment.jid,
      channel:
        assignment.channel ||
        (assignment.jid.startsWith('dc:') ? 'discord' : ''),
      isGroup: assignment.isGroup,
      lastMessageTime: assignment.lastMessageTime,
      customerFlow: 'idle',
      customerSummary: '',
      latestInboundAt: null,
      latestOutboundAt: null,
      activeServiceIds: [],
      openWorkItemCount: 0,
      assignments: [],
    };
    const service = serviceById.get(assignment.serviceId || '');
    existing.name = existing.name || assignment.name || assignment.jid;
    existing.lastMessageTime =
      existing.lastMessageTime || assignment.lastMessageTime;
    existing.assignments.push({
      serviceId: assignment.serviceId || service?.serviceId || 'unknown',
      serviceName: service?.serviceName || `hkclaw-${assignment.serviceId}`,
      assistantName: service?.assistantName || assignment.name,
      role: service?.role || 'normal',
      agentType:
        (assignment.agentType as AgentType | undefined) ||
        service?.agentType ||
        'claude-code',
      kind: 'group',
      folder: assignment.folder,
      requiresTrigger: assignment.requiresTrigger !== false,
      isMain: assignment.isMain === true,
    });
    channels.set(assignment.jid, existing);
  }

  for (const service of services) {
    const config = serviceConfigById.get(service.serviceId);
    if (!config?.statusChannelId || service.role !== 'dashboard') {
      continue;
    }

    const jid = `dc:${config.statusChannelId}`;
    const chat = chatsByJid.get(jid);
    const existing = channels.get(jid) || {
      jid,
      name: chat?.name || `discord #${config.statusChannelId}`,
      channel: chat?.channel || 'discord',
      isGroup: chat?.is_group === 1,
      lastMessageTime: chat?.last_message_time || null,
      customerFlow: 'idle',
      customerSummary: '',
      latestInboundAt: null,
      latestOutboundAt: null,
      activeServiceIds: [],
      openWorkItemCount: 0,
      assignments: [],
    };

    const hasStatusAssignment = existing.assignments.some(
      (assignment) =>
        assignment.serviceId === service.serviceId &&
        assignment.kind === 'status-dashboard',
    );
    if (!hasStatusAssignment) {
      existing.assignments.push({
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        assistantName: service.assistantName,
        role: service.role,
        agentType: service.agentType,
        kind: 'status-dashboard',
        requiresTrigger: false,
        isMain: false,
      });
    }
    channels.set(jid, existing);
  }

  return [...channels.values()]
    .map((channel) => ({
      ...channel,
      assignments: channel.assignments.sort((a, b) =>
        a.serviceName.localeCompare(b.serviceName),
      ),
    }))
    .sort((a, b) => {
      const timeA = a.lastMessageTime
        ? new Date(a.lastMessageTime).getTime()
        : 0;
      const timeB = b.lastMessageTime
        ? new Date(b.lastMessageTime).getTime()
        : 0;
      if (timeA !== timeB) return timeB - timeA;
      return a.name.localeCompare(b.name);
    });
}

function deriveChannelCustomerFlow(args: {
  channel: AdminChannelState;
  services: AdminServiceState[];
}): Pick<
  AdminChannelState,
  | 'customerFlow'
  | 'customerSummary'
  | 'latestInboundAt'
  | 'latestOutboundAt'
  | 'activeServiceIds'
  | 'openWorkItemCount'
> {
  const recentMessages = getRecentMessages(args.channel.jid, 40);
  const latestInbound =
    [...recentMessages]
      .reverse()
      .find((message) => !message.is_bot_message && !message.is_from_me) || null;
  const latestOutbound =
    [...recentMessages]
      .reverse()
      .find((message) => message.is_bot_message || message.is_from_me) || null;
  const activeServices = args.services.filter(
    (service) =>
      service.role !== 'dashboard' &&
      service.runtime.running &&
      service.currentJid === args.channel.jid,
  );
  const activeServiceIds = activeServices.map((service) => service.serviceId);
  const openWorkItems = args.channel.assignments
    .filter((assignment) => assignment.kind === 'group')
    .map((assignment) =>
      getOpenWorkItem(
        args.channel.jid,
        assignment.agentType,
        assignment.serviceId,
      ),
    )
    .filter(Boolean);
  const openWorkItemCount = openWorkItems.length;

  if (openWorkItemCount > 0) {
    return {
      customerFlow: 'handoff-ready',
      customerSummary:
        '음식은 완성됐고 손님에게 건네기 직전입니다. 응답 전달을 기다리는 상태입니다.',
      latestInboundAt: latestInbound?.timestamp || null,
      latestOutboundAt: latestOutbound?.timestamp || null,
      activeServiceIds,
      openWorkItemCount,
    };
  }

  if (activeServices.length > 0) {
    return {
      customerFlow: latestOutbound ? 'cooking' : 'order-taking',
      customerSummary: latestOutbound
        ? `${activeServices.map((service) => service.assistantName).join(', ')} 직원이 주문을 이어받아 조리 중입니다.`
        : `${activeServices.map((service) => service.assistantName).join(', ')} 직원이 손님 주문을 받고 있습니다.`,
      latestInboundAt: latestInbound?.timestamp || null,
      latestOutboundAt: latestOutbound?.timestamp || null,
      activeServiceIds,
      openWorkItemCount,
    };
  }

  if (
    latestInbound &&
    (!latestOutbound ||
      new Date(latestInbound.timestamp).getTime() >
        new Date(latestOutbound.timestamp).getTime())
  ) {
    return {
      customerFlow: 'customer-arrived',
      customerSummary:
        '손님이 주문을 남겼고 아직 직원이 응답을 건네지 않았습니다.',
      latestInboundAt: latestInbound.timestamp,
      latestOutboundAt: latestOutbound?.timestamp || null,
      activeServiceIds,
      openWorkItemCount,
    };
  }

  if (latestOutbound) {
    return {
      customerFlow: 'served',
      customerSummary:
        '주문 응답이 이미 전달됐습니다. 손님은 음식 받고 나간 상태로 봅니다.',
      latestInboundAt: latestInbound?.timestamp || null,
      latestOutboundAt: latestOutbound.timestamp,
      activeServiceIds,
      openWorkItemCount,
    };
  }

  return {
    customerFlow: 'idle',
    customerSummary:
      '아직 손님이 없거나 새 주문이 들어오지 않았습니다. 창구 대기 상태입니다.',
    latestInboundAt: null,
    latestOutboundAt: null,
    activeServiceIds,
    openWorkItemCount,
  };
}

function countAssignmentsByServiceId(
  channels: AdminChannelState[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const channel of channels) {
    for (const assignment of channel.assignments) {
      counts.set(
        assignment.serviceId,
        (counts.get(assignment.serviceId) || 0) + 1,
      );
    }
  }

  return counts;
}

function buildAdminTeams(args: {
  services: AdminServiceState[];
  channels: AdminChannelState[];
}): AdminTeamState[] {
  const manualTeams = getOfficeTeams();
  const channelsByJid = new Map(
    args.channels.map((channel) => [channel.jid, channel]),
  );
  const groupAssignmentsByJid = new Map(
    args.channels.map((channel) => [
      channel.jid,
      channel.assignments.filter((assignment) => assignment.kind === 'group'),
    ]),
  );
  const activeServiceIdsByJid = new Map<string, string[]>();
  for (const service of args.services) {
    if (service.role === 'dashboard' || !service.currentJid) {
      continue;
    }
    const activeServiceIds =
      activeServiceIdsByJid.get(service.currentJid) || [];
    activeServiceIds.push(service.serviceId);
    activeServiceIdsByJid.set(service.currentJid, activeServiceIds);
  }
  const teams = new Map<string, AdminTeamState>();
  const linkedJids = new Set<string>();

  const buildTeam = (
    teamId: string,
    name: string,
    linkedJid: string | null,
    source: 'manual' | 'channel',
    color?: string | null,
    configuredFolder?: string | null,
    configuredRequiresMention?: boolean | null,
    configuredLayoutLeft?: number | null,
    configuredLayoutTop?: number | null,
    configuredLayoutWidth?: number | null,
    configuredLayoutHeight?: number | null,
  ): AdminTeamState => {
    const linkedChannel = linkedJid ? channelsByJid.get(linkedJid) : undefined;
    const groupAssignments = linkedJid
      ? groupAssignmentsByJid.get(linkedJid) || []
      : [];
    const assignmentServiceIds = groupAssignments.map(
      (assignment) => assignment.serviceId,
    );
    const assignmentFolders = [
      ...new Set(
        groupAssignments
          .map((assignment) => assignment.folder?.trim() || '')
          .filter(Boolean),
      ),
    ];
    const assignmentRequiresMention = [
      ...new Set(
        groupAssignments.map(
          (assignment) => assignment.requiresTrigger !== false,
        ),
      ),
    ];
    const activeServiceIds = linkedJid
      ? activeServiceIdsByJid.get(linkedJid) || []
      : [];
    const assignedServiceIds = [...new Set(assignmentServiceIds)];
    const memberServiceIds = [
      ...new Set([...assignedServiceIds, ...activeServiceIds]),
    ];

    return {
      teamId,
      name,
      linkedJid,
      linkedChannelName: linkedChannel?.name || null,
      folder:
        configuredFolder?.trim() ||
        (assignmentFolders.length === 1 ? assignmentFolders[0] : null),
      requiresMention:
        configuredRequiresMention === null ||
        configuredRequiresMention === undefined
          ? assignmentRequiresMention.length === 1
            ? assignmentRequiresMention[0]
            : true
          : configuredRequiresMention,
      layoutLeft:
        configuredLayoutLeft === null || configuredLayoutLeft === undefined
          ? null
          : configuredLayoutLeft,
      layoutTop:
        configuredLayoutTop === null || configuredLayoutTop === undefined
          ? null
          : configuredLayoutTop,
      layoutWidth:
        configuredLayoutWidth === null || configuredLayoutWidth === undefined
          ? null
          : configuredLayoutWidth,
      layoutHeight:
        configuredLayoutHeight === null || configuredLayoutHeight === undefined
          ? null
          : configuredLayoutHeight,
      folderMixed: assignmentFolders.length > 1,
      source,
      color: color || pickTeamColor(teamId || name),
      assignedServiceIds,
      memberServiceIds,
      activeServiceIds,
    };
  };

  for (const team of manualTeams) {
    const normalizedLinkedJid = normalizeLinkedJid(team.linked_jid);
    if (normalizedLinkedJid) {
      linkedJids.add(normalizedLinkedJid);
    }
    teams.set(
      team.team_id,
      buildTeam(
        team.team_id,
        team.name,
        normalizedLinkedJid,
        'manual',
        team.color,
        team.folder,
        team.requires_mention === null ? null : team.requires_mention === 1,
        team.layout_left,
        team.layout_top,
        team.layout_width,
        team.layout_height,
      ),
    );
  }

  const activeJids = new Set(
    args.services
      .filter((service) => service.role !== 'dashboard' && service.currentJid)
      .map((service) => service.currentJid as string),
  );

  const sortedChannels = [...args.channels].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const channel of sortedChannels) {
    const hasGroupAssignments = channel.assignments.some(
      (assignment) => assignment.kind === 'group',
    );
    if (!hasGroupAssignments && !activeJids.has(channel.jid)) {
      continue;
    }

    if (linkedJids.has(channel.jid)) {
      continue;
    }

    const teamId = normalizeTeamId(channel.name, `team-${teams.size + 1}`);
    teams.set(
      teamId,
      buildTeam(teamId, channel.name || channel.jid, channel.jid, 'channel'),
    );
    linkedJids.add(channel.jid);
  }

  return [...teams.values()];
}

function buildAdminCounters(args: {
  channels: AdminChannelState[];
  teams: AdminTeamState[];
}): AdminCounterState[] {
  const teamByJid = new Map<string, AdminTeamState>();
  for (const team of args.teams) {
    if (!team.linkedJid || teamByJid.has(team.linkedJid)) continue;
    teamByJid.set(team.linkedJid, team);
  }

  const counters = new Map<string, AdminCounterState>();

  const buildCounter = (
    channel: Pick<
      AdminChannelState,
      | 'jid'
      | 'name'
      | 'customerFlow'
      | 'customerSummary'
      | 'latestInboundAt'
      | 'latestOutboundAt'
      | 'activeServiceIds'
      | 'openWorkItemCount'
      | 'assignments'
    >,
  ): AdminCounterState => {
      const configuredTeam = teamByJid.get(channel.jid);
      const assignedServiceIds = [
        ...new Set(
          channel.assignments
            .filter((assignment) => assignment.kind === 'group')
            .map((assignment) => assignment.serviceId),
        ),
      ];
      const memberServiceIds =
        configuredTeam?.memberServiceIds ||
        [
          ...new Set([
            ...assignedServiceIds,
            ...channel.activeServiceIds,
          ]),
        ];
      const assignmentRequiresMention = [
        ...new Set(
          channel.assignments
            .filter((assignment) => assignment.kind === 'group')
            .map((assignment) => assignment.requiresTrigger !== false),
        ),
      ];

      return {
        counterId: configuredTeam?.teamId || channel.jid,
        jid: channel.jid,
        name: channel.name,
        stationName: configuredTeam?.name || channel.name,
        source: configuredTeam?.source || 'channel',
        teamId: configuredTeam?.teamId || null,
        folder: configuredTeam?.folder || null,
        requiresMention:
          configuredTeam?.requiresMention ??
          (assignmentRequiresMention.length === 1
            ? assignmentRequiresMention[0]
            : true),
        layoutLeft: configuredTeam?.layoutLeft ?? null,
        layoutTop: configuredTeam?.layoutTop ?? null,
        layoutWidth: configuredTeam?.layoutWidth ?? null,
        layoutHeight: configuredTeam?.layoutHeight ?? null,
        color: configuredTeam?.color || pickTeamColor(channel.jid),
        customerFlow: channel.customerFlow,
        customerSummary: channel.customerSummary,
        latestInboundAt: channel.latestInboundAt,
        latestOutboundAt: channel.latestOutboundAt,
        activeServiceIds: [...channel.activeServiceIds],
        assignedServiceIds:
          configuredTeam?.assignedServiceIds || assignedServiceIds,
        memberServiceIds,
        openWorkItemCount: channel.openWorkItemCount,
        assignmentCount: channel.assignments.length,
        assignments: [...channel.assignments],
      };
    };

  for (const channel of args.channels) {
    counters.set(channel.jid, buildCounter(channel));
  }

  for (const team of args.teams) {
    if (!team.linkedJid || counters.has(team.linkedJid)) continue;
    counters.set(
      team.linkedJid,
      buildCounter({
        jid: team.linkedJid,
        name: team.linkedChannelName || team.name,
        customerFlow: 'idle',
        customerSummary:
          '아직 손님이 없거나 새 주문이 들어오지 않았습니다. 창구 대기 상태입니다.',
        latestInboundAt: null,
        latestOutboundAt: null,
        activeServiceIds: [...team.activeServiceIds],
        openWorkItemCount: 0,
        assignments: [],
      }),
    );
  }

  return [...counters.values()].sort((a, b) => {
      const activityWeight = (counter: AdminCounterState): number =>
        counter.customerFlow === 'handoff-ready'
          ? 0
          : counter.customerFlow === 'cooking'
            ? 1
            : counter.customerFlow === 'order-taking'
              ? 2
              : counter.customerFlow === 'customer-arrived'
                ? 3
                : counter.customerFlow === 'served'
                  ? 4
                  : 5;
      const weightDiff = activityWeight(a) - activityWeight(b);
      if (weightDiff !== 0) return weightDiff;
      const timeA = a.latestInboundAt ?? a.latestOutboundAt;
      const timeB = b.latestInboundAt ?? b.latestOutboundAt;
      const timestampA = timeA ? new Date(timeA).getTime() : 0;
      const timestampB = timeB ? new Date(timeB).getTime() : 0;
      if (timestampA !== timestampB) return timestampB - timestampA;
      return a.stationName.localeCompare(b.stationName);
    });
}

export function readAdminState(projectRoot: string): AdminState {
  const companySettings = getOfficeCompanySettings();
  const roomLayouts = {
    ...DEFAULT_STORE_ROOM_LAYOUTS,
    ...parseRoomLayouts(companySettings?.room_layouts_json),
  };
  const codexUsage = buildAdminCodexUsageState();
  const services = discoverConfiguredServices(projectRoot);
  const baseEnv = parseEnvFilePath(path.join(projectRoot, '.env'));
  const serviceConfigById = new Map(
    services.map((service) => [
      service.serviceId,
      summarizeServiceEnv(projectRoot, service, baseEnv),
    ]),
  );
  const snapshots = new Map(
    readStatusSnapshots(ADMIN_STATUS_SNAPSHOT_MAX_AGE_MS).map((snapshot) => [
      snapshot.serviceId,
      snapshot,
    ]),
  );
  const channels = buildChannelAssignments(services, serviceConfigById);
  const assignmentCountByServiceId = countAssignmentsByServiceId(channels);
  const serviceStates = services.map((service) => {
    const snapshot = snapshots.get(service.serviceId);
    const runtime = inspectServiceRuntime(service);
    const config = serviceConfigById.get(service.serviceId);
    if (!config) {
      throw new Error(
        `Missing service config summary for ${service.serviceId}`,
      );
    }
    const activeEntries = (snapshot?.entries || [])
      .filter((entry) => entry.status !== 'inactive')
      .sort((a, b) => {
        const weight = (status: typeof a.status): number =>
          status === 'processing' ? 0 : status === 'waiting' ? 1 : 2;
        return weight(a.status) - weight(b.status);
      });
    const activeJids = [...new Set(activeEntries.map((entry) => entry.jid))];
    const dashboardJid = config.statusChannelId
      ? `dc:${config.statusChannelId}`
      : null;
    const currentJid =
      activeJids[0] ||
      (service.role === 'dashboard' && dashboardJid ? dashboardJid : null);
    const presence: AdminServiceState['presence'] = !runtime.running
      ? 'offline'
      : activeJids.length > 0
        ? 'working'
        : service.role === 'dashboard' && dashboardJid
          ? 'monitoring'
          : 'resting';
    const assignmentCount =
      assignmentCountByServiceId.get(service.serviceId) || 0;
    const diagnostics = diagnoseServiceHealth({
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      assistantName: service.assistantName,
      agentType: service.agentType,
      role: service.role,
      envPath: service.envOverlayPath || path.join(projectRoot, '.env'),
      config,
      runtime,
      snapshotStale: !snapshot,
      assignmentCount,
    });

    return {
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      assistantName: service.assistantName,
      agentType: service.agentType,
      role: service.role,
      presence,
      currentJid,
      source: service.source,
      envPath: service.envOverlayPath || path.join(projectRoot, '.env'),
      runtime,
      snapshot: {
        updatedAt: snapshot?.updatedAt || null,
        roomCount: snapshot?.entries.length || 0,
        activeRooms:
          snapshot?.entries.filter((entry) => entry.status === 'processing')
            .length || 0,
        activeJids,
        stale: !snapshot,
      },
      assignmentCount,
      diagnostics,
      config,
    };
  });
  const enrichedChannels = channels.map((channel) => ({
    ...channel,
    ...deriveChannelCustomerFlow({
      channel,
      services: serviceStates,
    }),
  }));
  const teams = buildAdminTeams({
    services: serviceStates,
    channels: enrichedChannels,
  });
  const counters = buildAdminCounters({
    channels: enrichedChannels,
    teams,
  });

  return {
    generatedAt: new Date().toISOString(),
    currentServiceId: SERVICE_ID,
    company: {
      companyName: companySettings?.company_name || '',
      officeTitle: companySettings?.office_title || '',
      officeSubtitle: companySettings?.office_subtitle || '',
      roomLayouts,
      updatedAt: companySettings?.updated_at || null,
    },
    usage: {
      codex: codexUsage,
    },
    services: serviceStates,
    counters,
    channels: enrichedChannels,
    teams,
    temperaments: listTemperaments(projectRoot),
  };
}

function findService(
  projectRoot: string,
  serviceId: string,
): DiscoveredService {
  const normalizedServiceId = normalizeServiceId(serviceId, serviceId);
  const service = discoverConfiguredServices(projectRoot).find(
    (item) => item.serviceId === normalizedServiceId,
  );
  if (!service) {
    throw new Error(`Unknown service: ${normalizedServiceId}`);
  }
  return service;
}

function readLogTail(
  filePath: string,
  options: { maxBytes?: number; maxLines?: number } = {},
): string {
  const maxBytes = Math.max(options.maxBytes || 64 * 1024, 1024);
  const maxLines = Math.max(options.maxLines || 120, 1);
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const stats = fs.statSync(filePath);
  const readStart = Math.max(0, stats.size - maxBytes);
  const readLength = Math.max(stats.size - readStart, 0);
  if (readLength === 0) {
    return '';
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readLength);
    fs.readSync(fd, buffer, 0, readLength, readStart);
    let text = buffer.toString('utf8');
    if (readStart > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

export function readServiceLogs(
  projectRoot: string,
  serviceId: string,
  options: { maxBytes?: number; maxLines?: number } = {},
): AdminServiceLogsState {
  const service = findService(projectRoot, serviceId);
  const logsDir = path.join(projectRoot, 'logs');
  const stdoutPath = path.join(logsDir, `${service.logName}.log`);
  const stderrPath = path.join(logsDir, `${service.logName}.error.log`);

  return {
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    stdoutPath,
    stderrPath,
    stdout: readLogTail(stdoutPath, options),
    stderr: readLogTail(stderrPath, options),
    loadedAt: new Date().toISOString(),
  };
}

function buildUniqueTeamId(name: string, requestedTeamId?: string): string {
  const existingIds = new Set(getOfficeTeams().map((team) => team.team_id));
  const base = normalizeTeamId(requestedTeamId || name, 'team');
  if (!existingIds.has(base) || requestedTeamId) {
    return base;
  }

  let candidate = base;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${index++}`;
  }
  return candidate;
}

function normalizeLinkedJid(value?: string | null): string | null {
  const trimmed = value?.trim() || '';
  if (!trimmed) return null;
  const discordChannelId = parseDiscordChannelId(trimmed);
  if (discordChannelId) {
    return `dc:${discordChannelId}`;
  }
  if (trimmed.startsWith('dc:')) {
    return null;
  }
  if (/^[a-z]+:.+$/i.test(trimmed) || trimmed.includes('@')) {
    return trimmed;
  }
  return trimmed;
}

function normalizeLayoutCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Invalid team layout coordinate');
  }
  return Math.min(100, Math.max(0, Number(value)));
}

function normalizeLayoutSize(
  value: number | undefined,
  origin: number,
): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    throw new Error('Invalid team layout size');
  }
  const remaining = Math.max(100 - origin, 4);
  return Math.min(remaining, Math.max(4, Number(value)));
}

function adminConversationKey(scope: string): string {
  return `team:${normalizeTeamId(scope, scope)}`;
}

function renameGroupPathIfPresent(oldPath: string, newPath: string): void {
  if (oldPath === newPath || !fs.existsSync(oldPath)) {
    return;
  }
  if (fs.existsSync(newPath)) {
    throw new Error(
      `Destination already exists for group folder: ${path.basename(newPath)}`,
    );
  }
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
}

function renameGroupRuntimePaths(oldFolder: string, newFolder: string): void {
  if (oldFolder === newFolder) {
    return;
  }

  renameGroupPathIfPresent(
    resolveGroupFolderPath(oldFolder),
    resolveGroupFolderPath(newFolder),
  );
  renameGroupPathIfPresent(
    resolveGroupIpcPath(oldFolder),
    resolveGroupIpcPath(newFolder),
  );
  renameGroupPathIfPresent(
    resolveGroupSessionsPath(oldFolder),
    resolveGroupSessionsPath(newFolder),
  );
}

function syncTeamAssignmentsToFolder(args: {
  linkedJid: string;
  folder: string;
}): string[] {
  ensureGroupFolder(args.folder);
  const assignments = getRegisteredGroupAssignments({
    allServices: true,
  }).filter((assignment) => assignment.jid === args.linkedJid);
  const groupAssignments = assignments.filter(
    (assignment) => assignment.folder,
  );
  if (!groupAssignments.length) {
    return [];
  }

  const serviceIds = [
    ...new Set(
      groupAssignments
        .map((assignment) => assignment.serviceId)
        .filter(Boolean),
    ),
  ] as string[];
  const folders = [
    ...new Set(
      groupAssignments.map((assignment) => assignment.folder).filter(Boolean),
    ),
  ];

  if (folders.length > 1) {
    throw new Error(
      'This team already uses multiple group folders. Unify assignments first, then set a team folder.',
    );
  }

  const currentFolder = folders[0];
  if (!currentFolder || currentFolder === args.folder) {
    return serviceIds;
  }

  renameGroupRuntimePaths(currentFolder, args.folder);
  renameGroupFolderReferences({
    oldFolder: currentFolder,
    newFolder: args.folder,
    serviceIds,
    chatJid: args.linkedJid,
  });
  return serviceIds;
}

function syncTeamRequiresTrigger(args: {
  linkedJid: string;
  requiresMention: boolean;
}): string[] {
  const assignments = getRegisteredGroupAssignments({
    allServices: true,
  }).filter((assignment) => assignment.jid === args.linkedJid);
  const serviceIds = [
    ...new Set(
      assignments.map((assignment) => assignment.serviceId).filter(Boolean),
    ),
  ] as string[];
  assignments.forEach((assignment) => {
    setRegisteredGroup(args.linkedJid, {
      ...assignment,
      requiresTrigger: args.requiresMention,
    });
  });
  return serviceIds;
}

function moveTeamAssignmentsToLinkedJid(args: {
  fromLinkedJid: string;
  toLinkedJid: string;
}): string[] {
  if (args.fromLinkedJid === args.toLinkedJid) {
    return [];
  }

  const assignments = getRegisteredGroupAssignments({
    allServices: true,
  }).filter((assignment) => assignment.jid === args.fromLinkedJid);
  if (!assignments.length) {
    return [];
  }

  for (const assignment of assignments) {
    const serviceId = assignment.serviceId || SERVICE_ID;
    if (getRegisteredGroup(args.toLinkedJid, { serviceId })) {
      throw new InvalidAdminInputError(
        `Target channel already has an assignment for service ${serviceId}`,
      );
    }
  }

  const destinationChat = findChatInfo(args.toLinkedJid);
  const movedServiceIds = new Set<string>();
  assignments.forEach((assignment) => {
    const serviceId = assignment.serviceId || SERVICE_ID;
    setRegisteredGroup(args.toLinkedJid, {
      ...assignment,
      name: destinationChat?.name || assignment.name,
      serviceId,
    });
    deleteRegisteredGroup(args.fromLinkedJid, serviceId);
    movedServiceIds.add(serviceId);
  });

  return [...movedServiceIds];
}

function findTeamChatContext(
  projectRoot: string,
  input: { teamId: string; serviceId?: string },
): {
  conversationId: string;
  linkedJid: string;
  service: DiscoveredService;
  group: RegisteredGroup & { jid: string };
} {
  const adminState = readAdminState(projectRoot);
  const team = adminState.teams.find(
    (entry) => entry.teamId === normalizeTeamId(input.teamId, input.teamId),
  );
  if (!team) {
    throw new Error(`Unknown team: ${input.teamId}`);
  }
  if (!team.linkedJid) {
    throw new Error('This team is not linked to a Discord channel yet.');
  }

  const candidateServiceIds = [
    input.serviceId?.trim() || '',
    ...team.assignedServiceIds,
  ].filter(Boolean);

  const targetGroup = candidateServiceIds
    .map((serviceId) => ({
      serviceId,
      group: getRegisteredGroup(team.linkedJid as string, { serviceId }),
    }))
    .find((entry) => entry.group);

  if (!targetGroup?.group) {
    throw new Error('No assigned staff is ready for this team channel yet.');
  }

  return {
    conversationId: adminConversationKey(team.teamId),
    linkedJid: team.linkedJid,
    service: findService(projectRoot, targetGroup.serviceId),
    group: targetGroup.group,
  };
}

function mapAdminChatMessage(message: {
  id: number;
  service_id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  created_at: string;
}): AdminChatMessageState {
  return {
    id: message.id,
    serviceId: message.service_id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
  };
}

function mapStoredChatMessage(message: NewMessage): AdminChatMessageState {
  return {
    id: message.id,
    serviceId: message.chat_jid,
    role: message.is_from_me || message.is_bot_message ? 'assistant' : 'user',
    content: message.content,
    createdAt: message.timestamp,
    senderName: message.sender_name || undefined,
  };
}

function buildTeamChatHistory(context: {
  conversationId: string;
  linkedJid: string;
}): AdminChatMessageState[] {
  const channelHistory = getRecentMessages(context.linkedJid).map(
    mapStoredChatMessage,
  );
  const webHistory = getAdminWebChatMessages(context.conversationId).map(
    mapAdminChatMessage,
  );

  return [...channelHistory, ...webHistory]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(-120);
}

function resolveAdminChatWorker(projectRoot: string): {
  command: string;
  args: string[];
} {
  const builtEntry = path.join(projectRoot, 'dist', 'admin-chat-worker.js');
  if (fs.existsSync(builtEntry)) {
    return { command: process.execPath, args: [builtEntry] };
  }

  const tsxEntry = path.join(projectRoot, 'src', 'admin-chat-worker.ts');
  const tsxBinary = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(tsxBinary) && fs.existsSync(tsxEntry)) {
    return { command: tsxBinary, args: [tsxEntry] };
  }

  throw new Error('Admin chat worker is unavailable. Run npm run build first.');
}

async function runAdminChatWorker(args: {
  projectRoot: string;
  service: DiscoveredService;
  prompt: string;
  chatJid?: string;
  group?: RegisteredGroup;
}): Promise<{ status: 'success' | 'error'; reply?: string; error?: string }> {
  const worker = resolveAdminChatWorker(args.projectRoot);
  const env = {
    ...buildEffectiveServiceEnv(args.projectRoot, args.service),
    LOG_LEVEL: 'silent',
    FORCE_COLOR: '0',
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(worker.command, worker.args, {
      cwd: args.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      try {
        const lastLine = trimmed.split('\n').filter(Boolean).pop() || '{}';
        const parsed = JSON.parse(lastLine) as {
          status: 'success' | 'error';
          reply?: string;
          error?: string;
        };
        if (code && code !== 0 && parsed.status !== 'success') {
          parsed.error =
            parsed.error || stderr.trim() || `Worker exited with code ${code}`;
        }
        resolve(parsed);
      } catch (err) {
        reject(
          new Error(
            stderr.trim() ||
              trimmed ||
              (err instanceof Error ? err.message : String(err)),
          ),
        );
      }
    });

    child.stdin.write(
      JSON.stringify({
        prompt: args.prompt,
        chatJid: args.chatJid,
        group: args.group,
      }),
    );
    child.stdin.end();
  });
}

export function upsertOfficeTeamConfig(
  projectRoot: string,
  input: OfficeTeamInput,
): { teamId: string } {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Team name is required');
  }

  const teamId = buildUniqueTeamId(name, input.teamId?.trim() || undefined);
  const existingTeam = input.teamId?.trim() ? getOfficeTeam(teamId) : undefined;
  const previousLinkedJid = normalizeLinkedJid(existingTeam?.linked_jid);
  const linkedJid = normalizeLinkedJid(input.linkedJid);
  const folder = input.folder?.trim() || null;
  const requiresMention = input.requiresMention ?? true;
  if (folder && !isValidGroupFolder(folder)) {
    throw new Error(`Invalid team folder "${folder}"`);
  }
  const conflicting = getOfficeTeams().find(
    (team) => team.linked_jid === linkedJid && team.team_id !== teamId,
  );
  if (linkedJid && conflicting) {
    throw new Error(`Channel is already linked to team ${conflicting.name}`);
  }

  const affectedServiceIds = new Set<string>();
  if (previousLinkedJid && linkedJid && previousLinkedJid !== linkedJid) {
    moveTeamAssignmentsToLinkedJid({
      fromLinkedJid: previousLinkedJid,
      toLinkedJid: linkedJid,
    }).forEach((serviceId) => affectedServiceIds.add(serviceId));
  }
  if (previousLinkedJid && !linkedJid) {
    const remainingAssignments = getRegisteredGroupAssignments({
      allServices: true,
    }).filter((assignment) => assignment.jid === previousLinkedJid);
    if (remainingAssignments.length) {
      throw new InvalidAdminInputError(
        'Unlink the team only after clearing its assigned staff',
      );
    }
  }
  if (linkedJid && folder) {
    syncTeamAssignmentsToFolder({ linkedJid, folder }).forEach((serviceId) =>
      affectedServiceIds.add(serviceId),
    );
  }
  if (linkedJid) {
    syncTeamRequiresTrigger({ linkedJid, requiresMention }).forEach(
      (serviceId) => affectedServiceIds.add(serviceId),
    );
  }

  upsertOfficeTeam({
    team_id: teamId,
    name,
    linked_jid: linkedJid,
    folder,
    requires_mention: requiresMention,
    layout_left: existingTeam?.layout_left ?? null,
    layout_top: existingTeam?.layout_top ?? null,
    layout_width: existingTeam?.layout_width ?? null,
    layout_height: existingTeam?.layout_height ?? null,
    color: input.color?.trim() || null,
  });

  for (const serviceId of affectedServiceIds) {
    restartServiceAfterConfigChange(projectRoot, serviceId);
  }

  return { teamId };
}

export function upsertOfficeTeamLayoutConfig(
  projectRoot: string,
  input: OfficeTeamLayoutInput,
): {
  teamId: string;
  name: string;
  left: number;
  top: number;
  width: number | null;
  height: number | null;
} {
  const teamId = normalizeTeamId(input.teamId, input.teamId);
  const state = readAdminState(projectRoot);
  const team = state.teams.find((entry) => entry.teamId === teamId);
  if (!team) {
    throw new Error(`Unknown team: ${input.teamId}`);
  }

  const requestedName = input.name?.trim();
  const name = requestedName || team.name;
  const left = normalizeLayoutCoordinate(input.left);
  const top = normalizeLayoutCoordinate(input.top);
  const width = normalizeLayoutSize(input.width, left);
  const height = normalizeLayoutSize(input.height, top);
  upsertOfficeTeam({
    team_id: team.teamId,
    name,
    linked_jid: team.linkedJid,
    folder: team.folder,
    requires_mention: team.requiresMention,
    layout_left: left,
    layout_top: top,
    layout_width: width ?? team.layoutWidth ?? null,
    layout_height: height ?? team.layoutHeight ?? null,
    color: team.color,
  });

  return {
    teamId: team.teamId,
    name,
    left,
    top,
    width: width ?? team.layoutWidth ?? null,
    height: height ?? team.layoutHeight ?? null,
  };
}

export function upsertOfficeRoomLayoutConfig(
  _projectRoot: string,
  input: OfficeRoomLayoutInput,
): {
  roomId: string;
  name: string | null;
  left: number;
  top: number;
  width: number | null;
  height: number | null;
} {
  const companySettings = getOfficeCompanySettings();
  const roomId = normalizeOfficeRoomId(input.roomId);
  if (!roomId) {
    throw new Error('roomId is required');
  }

  const left = normalizeLayoutCoordinate(input.left);
  const top = normalizeLayoutCoordinate(input.top);
  const roomLayouts = parseRoomLayouts(companySettings?.room_layouts_json);
  const currentLayout = roomLayouts[roomId] || null;
  const width = normalizeLayoutSize(input.width, left);
  const height = normalizeLayoutSize(input.height, top);
  const name = input.name?.trim() || null;
  roomLayouts[roomId] = {
    left,
    top,
    ...(width !== null
      ? { width }
      : currentLayout?.width
        ? { width: currentLayout.width }
        : {}),
    ...(height !== null
      ? { height }
      : currentLayout?.height
        ? { height: currentLayout.height }
        : {}),
    ...(name ? { name } : {}),
  };
  if (!name && roomLayouts[roomId]) {
    delete roomLayouts[roomId].name;
  }

  upsertOfficeCompanySettings({
    company_name: companySettings?.company_name || null,
    office_title: companySettings?.office_title || null,
    office_subtitle: companySettings?.office_subtitle || null,
    room_layouts_json: stringifyRoomLayouts(roomLayouts),
  });

  return {
    roomId,
    name,
    left,
    top,
    width: width ?? currentLayout?.width ?? null,
    height: height ?? currentLayout?.height ?? null,
  };
}

export function upsertOfficeCompanySettingsConfig(
  _projectRoot: string,
  input: OfficeCompanySettingsInput,
): void {
  const companySettings = getOfficeCompanySettings();
  const roomLayouts = parseRoomLayouts(companySettings?.room_layouts_json);
  upsertOfficeCompanySettings({
    company_name: input.companyName?.trim() || null,
    office_title: input.officeTitle?.trim() || null,
    office_subtitle: input.officeSubtitle?.trim() || null,
    room_layouts_json: stringifyRoomLayouts(roomLayouts),
  });
}

export function deleteOfficeTeamConfig(
  projectRoot: string,
  teamId: string,
): void {
  const team = getOfficeTeam(teamId);
  if (!team) {
    throw new Error(`Unknown team: ${teamId}`);
  }
  const state = readAdminState(projectRoot);
  const adminTeam = state.teams.find((entry) => entry.teamId === teamId);
  if (!adminTeam || adminTeam.source !== 'manual') {
    throw new InvalidAdminInputError(
      'Only manually created teams can be deleted',
    );
  }
  if (adminTeam.assignedServiceIds.length > 0) {
    throw new InvalidAdminInputError(
      'Remove assigned staff from this team before deleting it',
    );
  }
  deleteOfficeTeam(teamId);
}

function removeOwnedServiceFile(filePath: string, projectRoot: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(projectRoot)) {
      return;
    }
  } catch {
    return;
  }

  fs.rmSync(filePath, { force: true });
}

function removeNohupServiceArtifacts(
  projectRoot: string,
  service: DiscoveredService,
): void {
  const pidPath = path.join(projectRoot, `${service.serviceName}.pid`);
  if (fs.existsSync(pidPath)) {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      logger.warn(
        { serviceId: service.serviceId },
        'Failed to stop nohup service pid',
      );
    }
  }
  fs.rmSync(pidPath, { force: true });
  removeOwnedServiceFile(
    path.join(projectRoot, `start-${service.serviceName}.sh`),
    projectRoot,
  );
}

function cleanupDeletedServiceRuntime(
  projectRoot: string,
  service: DiscoveredService,
): void {
  const manager = getServiceManager();

  if (manager === 'systemd-user' || manager === 'systemd-system') {
    const systemctlArgs = manager === 'systemd-user' ? ['--user'] : [];
    try {
      execFileSync(
        'systemctl',
        [...systemctlArgs, 'stop', service.serviceName],
        { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      logger.warn(
        { serviceId: service.serviceId },
        'Failed to stop service before deletion',
      );
    }
    try {
      execFileSync(
        'systemctl',
        [...systemctlArgs, 'disable', service.serviceName],
        { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      logger.warn(
        { serviceId: service.serviceId },
        'Failed to disable service before deletion',
      );
    }
    const unitPath =
      manager === 'systemd-user'
        ? path.join(
            os.homedir(),
            '.config',
            'systemd',
            'user',
            `${service.serviceName}.service`,
          )
        : `/etc/systemd/system/${service.serviceName}.service`;
    removeOwnedServiceFile(unitPath, projectRoot);
    try {
      execFileSync('systemctl', [...systemctlArgs, 'daemon-reload'], {
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      logger.warn(
        { serviceId: service.serviceId },
        'Failed to reload systemd after deletion',
      );
    }
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() || 0);
    try {
      execFileSync(
        'launchctl',
        ['bootout', `gui/${uid}`, service.launchdLabel],
        { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      logger.warn(
        { serviceId: service.serviceId },
        'Failed to boot out launchd service',
      );
    }
    removeOwnedServiceFile(
      path.join(
        os.homedir(),
        'Library',
        'LaunchAgents',
        `${service.launchdLabel}.plist`,
      ),
      projectRoot,
    );
    return;
  }

  removeNohupServiceArtifacts(projectRoot, service);
}

export function deleteServiceConfig(
  projectRoot: string,
  serviceId: string,
): void {
  const service = findService(projectRoot, serviceId);
  if (service.source === 'primary') {
    throw new InvalidAdminInputError(
      'Primary service cannot be deleted from the admin web',
    );
  }
  if (service.serviceId === SERVICE_ID) {
    throw new InvalidAdminInputError(
      'Current service cannot delete itself from the admin web',
    );
  }
  if (!service.envOverlayPath) {
    throw new Error(`Missing env overlay for service ${service.serviceId}`);
  }

  cleanupDeletedServiceRuntime(projectRoot, service);
  getRegisteredGroupAssignments({ serviceId: service.serviceId }).forEach(
    (assignment) => {
      deleteRegisteredGroup(assignment.jid, service.serviceId);
    },
  );
  assignServiceTemperament({
    projectRoot,
    serviceId: service.serviceId,
    temperamentId: 'normal',
  });
  fs.rmSync(service.envOverlayPath, { force: true });
  logger.info({ serviceId: service.serviceId }, 'Deleted service config');
}

export function readAdminChatHistory(
  projectRoot: string,
  input: { teamId: string },
): AdminChatMessageState[] {
  const context = findTeamChatContext(projectRoot, { teamId: input.teamId });
  return buildTeamChatHistory(context);
}

export async function runAdminChat(
  projectRoot: string,
  input: { teamId: string; serviceId?: string; message: string },
): Promise<{
  history: AdminChatMessageState[];
  reply: AdminChatMessageState;
}> {
  const context = findTeamChatContext(projectRoot, {
    teamId: input.teamId,
    serviceId: input.serviceId,
  });
  const message = input.message.trim();
  if (!message) {
    throw new Error('Message is required');
  }
  if (context.service.role === 'dashboard') {
    throw new Error('Dashboard role does not support team chat');
  }
  if (runningAdminChats.has(context.conversationId)) {
    throw new Error('This team is already handling another web chat turn');
  }

  runningAdminChats.add(context.conversationId);
  createAdminWebChatMessage({
    service_id: context.conversationId,
    role: 'user',
    content: message,
  });

  try {
    const result = await runAdminChatWorker({
      projectRoot,
      service: context.service,
      prompt: message,
      chatJid: context.linkedJid,
      group: {
        ...context.group,
        serviceId: context.service.serviceId,
        agentType: context.service.agentType,
      },
    });
    const reply = createAdminWebChatMessage({
      service_id: context.conversationId,
      role: result.status === 'success' ? 'assistant' : 'error',
      content:
        (result.status === 'success' ? result.reply : result.error)?.trim() ||
        (result.status === 'success'
          ? '응답이 비어 있습니다.'
          : '응답 생성에 실패했습니다.'),
    });

    return {
      history: buildTeamChatHistory(context),
      reply: mapAdminChatMessage(reply),
    };
  } catch (err) {
    const reply = createAdminWebChatMessage({
      service_id: context.conversationId,
      role: 'error',
      content: err instanceof Error ? err.message : String(err),
    });
    return {
      history: buildTeamChatHistory(context),
      reply: mapAdminChatMessage(reply),
    };
  } finally {
    runningAdminChats.delete(context.conversationId);
  }
}

function scheduleServiceAction(
  projectRoot: string,
  service: DiscoveredService,
  action: 'restart' | 'start' | 'stop',
): void {
  const manager = getServiceManager();
  if (manager === 'systemd-user' || manager === 'systemd-system') {
    scheduleShellCommand(projectRoot, [
      'systemctl',
      ...(manager === 'systemd-user' ? ['--user'] : []),
      action,
      service.serviceName,
    ]);
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() || 0);
    const domain = `gui/${uid}/${service.launchdLabel}`;
    const command =
      action === 'restart'
        ? ['launchctl', 'kickstart', '-k', domain]
        : action === 'start'
          ? ['launchctl', 'kickstart', domain]
          : ['launchctl', 'bootout', `gui/${uid}`, service.launchdLabel];
    scheduleShellCommand(projectRoot, command);
    return;
  }

  throw new Error('No supported service manager detected');
}

export function runServiceAction(
  projectRoot: string,
  serviceId: string,
  action: 'restart' | 'start' | 'stop',
): { scheduled: boolean } {
  const service = findService(projectRoot, serviceId);
  if (service.serviceId === SERVICE_ID) {
    scheduleServiceAction(projectRoot, service, action);
    return { scheduled: true };
  }

  execServiceCommand(service, action);
  return { scheduled: false };
}

function restartServiceAfterConfigChange(
  projectRoot: string,
  serviceId: string,
): { scheduled: boolean } {
  try {
    return runServiceAction(projectRoot, serviceId, 'restart');
  } catch (error) {
    logger.warn(
      {
        serviceId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Config change applied but service restart failed',
    );
    return { scheduled: false };
  }
}

export function scheduleTopologyReconcile(projectRoot: string): void {
  scheduleShellCommand(projectRoot, [
    'npm',
    'run',
    'setup',
    '--',
    '--step',
    'service',
  ]);
}

interface TopologyApplyResult {
  applied: true;
  restartScheduled: boolean;
  runtime?: ServiceRuntimeState;
}

async function waitForServiceRuntimeState(
  projectRoot: string,
  serviceId: string,
): Promise<ServiceRuntimeState> {
  const deadline = Date.now() + SERVICE_RUNTIME_WAIT_TIMEOUT_MS;
  let lastRuntime: ServiceRuntimeState | null = null;

  while (Date.now() < deadline) {
    const service = discoverConfiguredServices(projectRoot).find(
      (entry) => entry.serviceId === serviceId,
    );
    if (service) {
      const runtime = inspectServiceRuntime(service);
      lastRuntime = runtime;
      if (runtime.running || runtime.activeState === 'activating') {
        return runtime;
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SERVICE_RUNTIME_POLL_INTERVAL_MS),
    );
  }

  if (lastRuntime) {
    return lastRuntime;
  }

  throw new Error(`Service not found after reconcile: ${serviceId}`);
}

export async function applyTopologyReconcile(
  projectRoot: string,
  options: {
    verifyServiceId?: string;
    restartServiceId?: string;
  } = {},
): Promise<TopologyApplyResult> {
  runTopologyReconcileCommand(projectRoot);

  let restartScheduled = false;
  if (options.restartServiceId) {
    const restart = restartServiceAfterConfigChange(
      projectRoot,
      options.restartServiceId,
    );
    restartScheduled = restart.scheduled;
  }

  if (!options.verifyServiceId) {
    return {
      applied: true,
      restartScheduled,
    };
  }

  const runtime = restartScheduled
    ? inspectServiceRuntime(findService(projectRoot, options.verifyServiceId))
    : await waitForServiceRuntimeState(projectRoot, options.verifyServiceId);

  return {
    applied: true,
    restartScheduled,
    runtime,
  };
}

export function upsertServiceConfig(
  projectRoot: string,
  input: ServiceConfigInput,
): { serviceId: string; envPath: string } {
  const services = discoverConfiguredServices(projectRoot);
  const existing = input.existingServiceId
    ? services.find(
        (service) =>
          service.serviceId ===
          normalizeServiceId(input.existingServiceId, input.existingServiceId),
      )
    : undefined;

  const requestedServiceId = normalizeServiceId(
    input.serviceId || existing?.serviceId,
    input.assistantName || existing?.assistantName || 'service',
  );
  if (!requestedServiceId) {
    throw new Error('SERVICE_ID is required');
  }

  if (existing && requestedServiceId !== existing.serviceId) {
    throw new Error(
      'Renaming an existing SERVICE_ID is not supported yet. Create a new service instead.',
    );
  }

  if (
    !existing &&
    services.some((service) => service.serviceId === requestedServiceId)
  ) {
    throw new Error(`SERVICE_ID already exists: ${requestedServiceId}`);
  }

  const assistantName = input.assistantName.trim() || requestedServiceId;
  const agentType = parseAgentType(input.agentType, assistantName);
  const role = parseServiceRole(input.role, existing?.role || 'normal');
  const statusChannelId =
    role === 'dashboard'
      ? normalizeStatusChannelId(input.statusChannelId)
      : null;
  if (role === 'dashboard' && !statusChannelId) {
    throw new InvalidAdminInputError(
      'Dashboard role requires a Discord status channel ID',
    );
  }
  const targetPath = existing
    ? existing.source === 'primary'
      ? ensurePrimaryServiceOverlay(projectRoot, existing)
      : existing.envOverlayPath ||
        path.join(projectRoot, `.env.agent.${existing.serviceId}`)
    : path.join(projectRoot, `.env.agent.${requestedServiceId}`);
  const claudeAuthBaseUrl =
    agentType === 'claude-code'
      ? normalizeOptionalEnvValue(input.anthropicBaseUrl)
      : null;
  const claudeAuthToken =
    agentType === 'claude-code'
      ? normalizeSecretEnvValue(
          input.anthropicAuthToken,
          input.clearAnthropicAuthToken,
        )
      : null;
  const claudeOauthToken =
    agentType === 'claude-code'
      ? normalizeSecretEnvValue(
          input.claudeCodeOauthToken,
          input.clearClaudeCodeOauthToken,
        )
      : null;
  const claudeOauthTokens =
    agentType === 'claude-code'
      ? normalizeSecretEnvValue(
          input.claudeCodeOauthTokens,
          input.clearClaudeCodeOauthTokens,
        )
      : null;
  const codexAuthJson =
    agentType === 'codex'
      ? normalizeCodexAuthEnvValue(
          input.codexAuthJson,
          input.clearCodexAuthJson,
        )
      : null;
  const geminiApiKey =
    agentType === 'gemini-cli'
      ? normalizeSecretEnvValue(input.geminiApiKey, input.clearGeminiApiKey)
      : null;
  const geminiModel =
    agentType === 'gemini-cli'
      ? normalizeOptionalEnvValue(input.geminiModel)
      : null;
  const geminiCliPath =
    agentType === 'gemini-cli'
      ? normalizeOptionalEnvValue(input.geminiCliPath)
      : null;
  const localLlmBaseUrl =
    agentType === 'local-llm'
      ? normalizeOptionalEnvValue(input.localLlmBaseUrl)
      : null;
  const localLlmModel =
    agentType === 'local-llm'
      ? normalizeOptionalEnvValue(input.localLlmModel)
      : null;
  const localLlmApiKey =
    agentType === 'local-llm'
      ? normalizeSecretEnvValue(
          input.localLlmApiKey,
          input.clearLocalLlmApiKey,
        )
      : null;

  upsertEnvFile(targetPath, {
    ASSISTANT_NAME: assistantName,
    SERVICE_ID: requestedServiceId,
    SERVICE_AGENT_TYPE: agentType,
    SERVICE_ROLE: role,
    STATUS_CHANNEL_ID: statusChannelId,
    USAGE_DASHBOARD: input.usageDashboard ? 'true' : 'false',
    DISCORD_VOICE_CHANNEL_IDS: normalizeOptionalEnvValue(input.voiceChannelIds),
    DISCORD_VOICE_TARGET_JID: normalizeOptionalEnvValue(input.voiceTargetJid),
    DISCORD_VOICE_ROUTE_MAP: normalizeOptionalEnvValue(input.voiceRouteMap),
    DISCORD_VOICE_GROUP_FOLDER: normalizeOptionalEnvValue(
      input.voiceGroupFolder,
    ),
    DISCORD_VOICE_GROUP_NAME: normalizeOptionalEnvValue(input.voiceGroupName),
    DISCORD_VOICE_RECONNECT_DELAY_MS: normalizeOptionalEnvValue(
      input.voiceReconnectDelayMs,
    ),
    DISCORD_LIVE_VOICE_SILENCE_MS: normalizeOptionalEnvValue(
      input.liveVoiceSilenceMs,
    ),
    DISCORD_LIVE_VOICE_MIN_PCM_BYTES: normalizeOptionalEnvValue(
      input.liveVoiceMinPcmBytes,
    ),
    DISCORD_EDGE_TTS_RATE: normalizeOptionalEnvValue(input.edgeTtsRate),
    DISCORD_EDGE_TTS_VOICE: normalizeOptionalEnvValue(input.edgeTtsVoice),
    DISCORD_EDGE_TTS_LANG: normalizeOptionalEnvValue(input.edgeTtsLang),
    DISCORD_EDGE_TTS_OUTPUT_FORMAT: normalizeOptionalEnvValue(
      input.edgeTtsOutputFormat,
    ),
    DISCORD_EDGE_TTS_TIMEOUT_MS: normalizeOptionalEnvValue(
      input.edgeTtsTimeoutMs,
    ),
    DISCORD_EDGE_TTS_MAX_CHARS: normalizeOptionalEnvValue(
      input.edgeTtsMaxChars,
    ),
    DISCORD_VOICE_OUTPUT_BITRATE: normalizeOptionalEnvValue(
      input.voiceOutputBitrate,
    ),
    ANTHROPIC_BASE_URL: claudeAuthBaseUrl,
    ANTHROPIC_AUTH_TOKEN: claudeAuthToken,
    CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken,
    CLAUDE_CODE_OAUTH_TOKENS: claudeOauthTokens,
    CLAUDE_CODE_USE_CREDENTIAL_FILES: null,
    CODEX_AUTH_JSON_B64: codexAuthJson,
    CODEX_USE_HOME_AUTH: null,
    GEMINI_API_KEY: geminiApiKey,
    GEMINI_MODEL: geminiModel,
    GEMINI_CLI_PATH: geminiCliPath,
    LOCAL_LLM_BASE_URL: localLlmBaseUrl,
    LOCAL_LLM_MODEL: localLlmModel,
    LOCAL_LLM_API_KEY: localLlmApiKey,
    OPENAI_API_KEY: normalizeSecretEnvValue(
      input.openAiApiKey,
      input.clearOpenAiApiKey,
    ),
    GROQ_API_KEY: normalizeSecretEnvValue(
      input.groqApiKey,
      input.clearGroqApiKey,
    ),
    DISCORD_GROQ_TRANSCRIPTION_MODEL: normalizeOptionalEnvValue(
      input.groqTranscriptionModel,
    ),
    DISCORD_OPENAI_TRANSCRIPTION_MODEL: normalizeOptionalEnvValue(
      input.openAiTranscriptionModel,
    ),
    DISCORD_TRANSCRIPTION_LANGUAGE: normalizeOptionalEnvValue(
      input.transcriptionLanguage,
    ),
    CODEX_MODEL: normalizeOptionalEnvValue(input.codexModel),
    CODEX_EFFORT: normalizeOptionalEnvValue(input.codexEffort),
    FALLBACK_ENABLED: normalizeOptionalEnvValue(input.fallbackEnabled),
    FALLBACK_PROVIDER_NAME: normalizeOptionalEnvValue(
      input.fallbackProviderName,
    ),
    FALLBACK_BASE_URL: normalizeOptionalEnvValue(input.fallbackBaseUrl),
    FALLBACK_AUTH_TOKEN: normalizeSecretEnvValue(
      input.fallbackAuthToken,
      input.clearFallbackAuthToken,
    ),
    FALLBACK_MODEL: normalizeOptionalEnvValue(input.fallbackModel),
    FALLBACK_SMALL_MODEL: normalizeOptionalEnvValue(input.fallbackSmallModel),
    FALLBACK_COOLDOWN_MS: normalizeOptionalEnvValue(input.fallbackCooldownMs),
    DISCORD_BOT_TOKEN: normalizeSecretEnvValue(
      input.discordBotToken,
      input.clearDiscordBotToken,
    ),
  });
  syncRequestedServiceAssignments(
    projectRoot,
    {
      serviceId: requestedServiceId,
      assistantName,
      agentType,
      role,
    },
    input.teamJid,
  );
  syncServiceAssignmentTriggers({
    serviceId: requestedServiceId,
    assistantName,
    agentType,
    role,
  });

  return {
    serviceId: requestedServiceId,
    envPath: targetPath,
  };
}

export function assignServiceTemperamentConfig(
  projectRoot: string,
  input: ServiceTemperamentAssignmentInput,
): { serviceId: string; temperamentId: string } {
  const service = findService(projectRoot, input.serviceId);
  const assignment = assignServiceTemperament({
    projectRoot,
    serviceId: service.serviceId,
    temperamentId: input.temperamentId,
  });
  return {
    serviceId: service.serviceId,
    temperamentId: assignment.temperamentId,
  };
}

export function upsertTemperamentConfig(
  projectRoot: string,
  input: TemperamentDefinitionInput,
): { temperamentId: string } {
  const definition = upsertTemperamentDefinition({
    projectRoot,
    temperamentId: input.temperamentId,
    name: input.name,
    prompt: input.prompt,
  });
  return { temperamentId: definition.temperamentId };
}

export function deleteTemperamentConfig(
  projectRoot: string,
  temperamentId: string,
): void {
  deleteTemperamentDefinition(projectRoot, temperamentId);
}

function ensureGroupFolder(folder: string): void {
  const groupPath = resolveGroupFolderPath(folder);
  fs.mkdirSync(path.join(groupPath, 'logs'), { recursive: true });
}

function findChatInfo(jid: string): ChatInfo | undefined {
  return getAllChats().find((chat) => chat.jid === jid);
}

type AssignmentManagedService = Pick<
  DiscoveredService,
  'serviceId' | 'assistantName' | 'agentType'
> & { role: ServiceRole };

function roleUsesTeamAssignments(role: ServiceRole): boolean {
  return role !== 'dashboard';
}

function expectedAssignmentTrigger(service: AssignmentManagedService): string {
  return `@${service.assistantName}`;
}

function syncServiceAssignmentTriggers(
  service: AssignmentManagedService,
): boolean {
  const expectedTrigger = expectedAssignmentTrigger(service);
  const assignments = getRegisteredGroupAssignments({
    serviceId: service.serviceId,
  });
  let changed = false;

  assignments.forEach((assignment) => {
    if (
      assignment.trigger === expectedTrigger &&
      assignment.agentType === service.agentType
    ) {
      return;
    }
    setRegisteredGroup(assignment.jid, {
      name: assignment.name,
      folder: assignment.folder,
      trigger: expectedTrigger,
      added_at: assignment.added_at,
      agentConfig: assignment.agentConfig,
      requiresTrigger: assignment.requiresTrigger,
      isMain: assignment.isMain,
      serviceId: service.serviceId,
      agentType: service.agentType,
      workDir: assignment.workDir,
    });
    changed = true;
    logger.info(
      {
        jid: assignment.jid,
        serviceId: service.serviceId,
        trigger: expectedTrigger,
      },
      'Synchronized assignment trigger for service',
    );
  });

  return changed;
}

function createRegisteredGroupAssignment(
  service: AssignmentManagedService,
  jid: string,
): boolean {
  const existing = getRegisteredGroup(jid, { serviceId: service.serviceId });
  if (existing) {
    return false;
  }

  const template = getRegisteredGroupAssignments({ allServices: true }).find(
    (assignment) => assignment.jid === jid,
  );
  const chat = findChatInfo(jid);
  const linkedTeam = getOfficeTeams().find((team) => team.linked_jid === jid);
  const displayName = chat?.name || template?.name || linkedTeam?.name || jid;
  const allFolders = getRegisteredGroupAssignments({ allServices: true }).map(
    (assignment) => assignment.folder,
  );
  const folder =
    linkedTeam?.folder?.trim() ||
    template?.folder ||
    buildSuggestedGroupFolder(displayName, service.serviceId, allFolders);
  const defaultRequiresTrigger = jid.startsWith('dc:') ? false : true;
  const group: RegisteredGroup = {
    name: displayName,
    folder,
    trigger: expectedAssignmentTrigger(service),
    added_at: new Date().toISOString(),
    agentConfig: template?.agentConfig,
    requiresTrigger:
      linkedTeam?.requires_mention === null ||
      linkedTeam?.requires_mention === undefined
        ? (template?.requiresTrigger ?? defaultRequiresTrigger)
        : linkedTeam.requires_mention === 1,
    isMain: template?.isMain,
    serviceId: service.serviceId,
    agentType: service.agentType,
    workDir: template?.workDir,
  };
  ensureGroupFolder(group.folder);
  setRegisteredGroup(jid, group);
  logger.info(
    { jid, serviceId: service.serviceId, folder: group.folder },
    'Assigned channel to service',
  );
  return true;
}

function syncRequestedServiceAssignments(
  projectRoot: string,
  service: AssignmentManagedService,
  requestedJid?: string,
): boolean {
  if (service.role === 'dashboard') {
    const assignments = getRegisteredGroupAssignments({
      serviceId: service.serviceId,
    });
    let changed = false;

    assignments.forEach((assignment) => {
      deleteRegisteredGroup(assignment.jid, service.serviceId);
      changed = true;
      logger.info(
        { jid: assignment.jid, serviceId: service.serviceId },
        'Removed channel assignment from exclusive-role service',
      );
    });

    return changed;
  }

  const normalizedRequestedJid = normalizeLinkedJid(requestedJid);
  if (!normalizedRequestedJid) {
    return false;
  }

  const counter = readAdminState(projectRoot).counters.find(
    (entry) => entry.jid === normalizedRequestedJid,
  );
  if (!counter) {
    throw new InvalidAdminInputError(
      'Initial staff assignment must target a configured or discovered order counter',
    );
  }

  return createRegisteredGroupAssignment(service, normalizedRequestedJid);
}

export function toggleChannelAssignment(
  projectRoot: string,
  input: { jid: string; serviceId: string; enabled: boolean },
): { scheduled: boolean } {
  const service = findService(projectRoot, input.serviceId);
  if (!roleUsesTeamAssignments(service.role)) {
    throw new Error('이 역할은 직원 관리에서 따로 설정합니다.');
  }

  const existing = getRegisteredGroup(input.jid, {
    serviceId: service.serviceId,
  });

  if (input.enabled && !existing) {
    createRegisteredGroupAssignment(service, input.jid);
  }

  if (!input.enabled && existing) {
    deleteRegisteredGroup(input.jid, service.serviceId);
    logger.info(
      { jid: input.jid, serviceId: service.serviceId },
      'Removed channel assignment from service',
    );
  }

  return restartServiceAfterConfigChange(projectRoot, service.serviceId);
}

export function replaceServiceAssignments(
  projectRoot: string,
  input: { serviceId: string; jids?: string[] },
): { scheduled: boolean } {
  const service = findService(projectRoot, input.serviceId);
  if (!roleUsesTeamAssignments(service.role)) {
    throw new Error('이 역할은 직원 관리에서 따로 설정합니다.');
  }

  const desiredJids = [
    ...new Set(
      (input.jids || [])
        .map((jid) => normalizeLinkedJid(jid))
        .filter(Boolean) as string[],
    ),
  ];
  const knownCounterJids = new Set(
    readAdminState(projectRoot).counters.map((counter) => counter.jid),
  );
  for (const jid of desiredJids) {
    if (!knownCounterJids.has(jid)) {
      throw new InvalidAdminInputError(
        `Unknown order counter: ${jid}`,
      );
    }
  }

  const existingAssignments = getRegisteredGroupAssignments({
    serviceId: service.serviceId,
  });
  const existingJids = new Set(existingAssignments.map((assignment) => assignment.jid));
  let changed = false;

  for (const assignment of existingAssignments) {
    if (desiredJids.includes(assignment.jid)) continue;
    deleteRegisteredGroup(assignment.jid, service.serviceId);
    changed = true;
    logger.info(
      { jid: assignment.jid, serviceId: service.serviceId },
      'Removed channel assignment from service',
    );
  }

  for (const jid of desiredJids) {
    if (existingJids.has(jid)) continue;
    changed = createRegisteredGroupAssignment(service, jid) || changed;
  }

  if (!changed) {
    return { scheduled: false };
  }

  return restartServiceAfterConfigChange(projectRoot, service.serviceId);
}
