import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { isPairedRoomJid } from './db.js';
import { readServiceEnvFile, SERVICE_SCOPED_ENV_KEYS } from './env.js';
import { getActiveCodexAuthPath } from './codex-token-rotation.js';
import { getCurrentToken } from './token-rotation.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveGroupSessionsPath,
  resolveTaskRuntimeIpcPath,
  resolveTaskSessionsPath,
} from './group-folder.js';
import {
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';
import type { AgentType, RegisteredGroup } from './types.js';

// writeCodexApiKeyAuth removed — Codex uses OAuth only.
// API key auth caused unintended billing.

function syncDirectoryEntries(sources: string[], destination: string): void {
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    for (const entry of fs.readdirSync(source)) {
      const srcPath = path.join(source, entry);
      const dstPath = path.join(destination, entry);
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

function ensureClaudeSessionSettings(groupSessionsDir: string): void {
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const defaultEnv = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    FALLBACK_ENABLED: '',
  };
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      settings = {};
    }
  }

  const existingEnv =
    settings.env &&
    typeof settings.env === 'object' &&
    !Array.isArray(settings.env)
      ? (settings.env as Record<string, string>)
      : {};
  const mergedEnv = { ...defaultEnv, ...existingEnv };
  const nextSettings = {
    ...settings,
    env: mergedEnv,
  };

  fs.writeFileSync(settingsFile, JSON.stringify(nextSettings, null, 2) + '\n');
}

function buildBaseRunnerEnv(args: {
  group: RegisteredGroup;
  chatJid: string;
  isMain: boolean;
  groupDir: string;
  groupIpcDir: string;
  hostIpcDir: string;
  globalDir: string;
  groupSessionsDir: string;
  agentType: AgentType;
  envVars: Record<string, string>;
  runtimeTaskId?: string;
}): Record<string, string> {
  const cleanEnv = { ...(process.env as Record<string, string>) };
  for (const key of SERVICE_SCOPED_ENV_KEYS) {
    delete cleanEnv[key];
  }
  for (const [key, value] of Object.entries(args.envVars)) {
    if (value) cleanEnv[key] = value;
  }
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  const nodeBin = path.dirname(process.execPath);
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin');
  const currentPath = cleanEnv.PATH || '/usr/local/bin:/usr/bin:/bin';
  const extraPaths = [nodeBin, npmGlobalBin].filter(
    (candidate) => !currentPath.includes(candidate) && fs.existsSync(candidate),
  );

  return {
    ...cleanEnv,
    PATH:
      extraPaths.length > 0
        ? `${extraPaths.join(':')}:${currentPath}`
        : currentPath,
    TZ: TIMEZONE,
    HOME: os.homedir(),
    HKCLAW_GROUP_DIR: args.groupDir,
    HKCLAW_IPC_DIR: args.groupIpcDir,
    HKCLAW_HOST_IPC_DIR: args.hostIpcDir,
    HKCLAW_GLOBAL_DIR: args.globalDir,
    ...(args.group.workDir ? { HKCLAW_WORK_DIR: args.group.workDir } : {}),
    HKCLAW_CHAT_JID: args.chatJid,
    HKCLAW_GROUP_FOLDER: args.group.folder,
    HKCLAW_IS_MAIN: args.isMain ? '1' : '0',
    HKCLAW_AGENT_TYPE: args.agentType,
    CLAUDE_CONFIG_DIR: args.groupSessionsDir,
    ...(args.runtimeTaskId
      ? { HKCLAW_RUNTIME_TASK_ID: args.runtimeTaskId }
      : {}),
  };
}

function prepareClaudeEnvironment(args: {
  env: Record<string, string>;
  envVars: Record<string, string>;
  group: RegisteredGroup;
}): void {
  if (args.envVars.ANTHROPIC_API_KEY) {
    args.env.ANTHROPIC_API_KEY = args.envVars.ANTHROPIC_API_KEY;
  }
  if (args.envVars.ANTHROPIC_AUTH_TOKEN) {
    args.env.ANTHROPIC_AUTH_TOKEN = args.envVars.ANTHROPIC_AUTH_TOKEN;
  }
  if (args.envVars.ANTHROPIC_BASE_URL) {
    args.env.ANTHROPIC_BASE_URL = args.envVars.ANTHROPIC_BASE_URL;
  }
  {
    // Token rotation takes priority over static .env value
    const oauthToken =
      getCurrentToken() || args.envVars.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      args.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  for (const key of [
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
  ]) {
    const value = args.envVars[key as keyof typeof args.envVars];
    if (value) args.env[key] = value;
  }
  if (args.group.agentConfig?.claudeModel) {
    args.env.CLAUDE_MODEL = args.group.agentConfig.claudeModel;
  }
  if (args.group.agentConfig?.claudeEffort) {
    args.env.CLAUDE_EFFORT = args.group.agentConfig.claudeEffort;
  }
  if (args.group.agentConfig?.claudeThinking) {
    args.env.CLAUDE_THINKING = args.group.agentConfig.claudeThinking;
  }
  if (args.group.agentConfig?.claudeThinkingBudget) {
    args.env.CLAUDE_THINKING_BUDGET = String(
      args.group.agentConfig.claudeThinkingBudget,
    );
  }
}

function prepareCodexSessionEnvironment(args: {
  env: Record<string, string>;
  envVars: Record<string, string>;
  projectRoot: string;
  group: RegisteredGroup;
  groupDir: string;
  sessionRootDir: string;
  chatJid: string;
  isMain: boolean;
  isPairedRoom: boolean;
  memoryBriefing?: string;
}): void {
  // API key auth intentionally removed — Codex uses OAuth only.
  // Never pass any API key to Codex child process to prevent API billing.
  delete args.env.OPENAI_API_KEY;
  delete args.env.CODEX_OPENAI_API_KEY;

  const codexModel =
    args.group.agentConfig?.codexModel || args.envVars.CODEX_MODEL;
  if (codexModel) args.env.CODEX_MODEL = codexModel;

  const codexEffort =
    args.group.agentConfig?.codexEffort || args.envVars.CODEX_EFFORT;
  if (codexEffort) args.env.CODEX_EFFORT = codexEffort;

  const hostCodexDir = path.join(os.homedir(), '.codex');
  const sessionCodexDir = path.join(args.sessionRootDir, '.codex');
  fs.mkdirSync(sessionCodexDir, { recursive: true });

  const authDst = path.join(sessionCodexDir, 'auth.json');
  const allowHomeCodexAuth =
    args.envVars.CODEX_USE_HOME_AUTH?.trim().toLowerCase() === 'true';
  {
    const embeddedAuth = args.envVars.CODEX_AUTH_JSON_B64;
    if (embeddedAuth) {
      const authJson = Buffer.from(embeddedAuth, 'base64').toString('utf-8');
      JSON.parse(authJson);
      fs.writeFileSync(authDst, authJson);
    } else if (allowHomeCodexAuth) {
      const rotatedAuthSrc = getActiveCodexAuthPath();
      const authSrc =
        rotatedAuthSrc && fs.existsSync(rotatedAuthSrc)
          ? rotatedAuthSrc
          : path.join(hostCodexDir, 'auth.json');
      if (fs.existsSync(authSrc)) {
        fs.copyFileSync(authSrc, authDst);
      } else if (fs.existsSync(authDst)) {
        fs.unlinkSync(authDst);
      }
    } else if (fs.existsSync(authDst)) {
      fs.unlinkSync(authDst);
    }
  }
  for (const file of ['config.toml', 'config.json']) {
    const src = path.join(hostCodexDir, file);
    const dst = path.join(sessionCodexDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  const overlayPath = path.join(args.groupDir, '.codex', 'config.toml');
  const sessionConfigPath = path.join(sessionCodexDir, 'config.toml');
  if (fs.existsSync(overlayPath)) {
    const overlayToml = fs.readFileSync(overlayPath, 'utf-8').trim();
    if (overlayToml) {
      const baseToml = fs.existsSync(sessionConfigPath)
        ? fs.readFileSync(sessionConfigPath, 'utf-8').trimEnd()
        : '';
      fs.writeFileSync(
        sessionConfigPath,
        [baseToml, overlayToml].filter(Boolean).join('\n\n') + '\n',
      );
    }
  }

  const sessionAgentsPath = path.join(sessionCodexDir, 'AGENTS.md');
  const sessionAgents = [
    readPlatformPrompt('codex', args.projectRoot),
    args.isPairedRoom
      ? readPairedRoomPrompt('codex', args.projectRoot)
      : undefined,
    args.memoryBriefing,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n---\n\n')
    .trim();
  if (sessionAgents) {
    fs.writeFileSync(sessionAgentsPath, sessionAgents + '\n');
  } else if (fs.existsSync(sessionAgentsPath)) {
    fs.unlinkSync(sessionAgentsPath);
  }

  syncDirectoryEntries(
    [
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(args.projectRoot, 'runners', 'skills'),
    ],
    path.join(sessionCodexDir, 'skills'),
  );

  const mcpServerPath = path.join(
    args.projectRoot,
    'runners',
    'agent-runner',
    'dist',
    'ipc-mcp-stdio.js',
  );
  if (fs.existsSync(mcpServerPath)) {
    let toml = fs.existsSync(sessionConfigPath)
      ? fs.readFileSync(sessionConfigPath, 'utf-8')
      : '';
    toml = stripManagedTomlTables(toml, [
      'mcp_servers.hkclaw',
      'mcp_servers.memento-mcp',
    ]);
    const mcpSection = `
[mcp_servers.hkclaw]
command = "node"
args = [${JSON.stringify(mcpServerPath)}]

[mcp_servers.hkclaw.env]
HKCLAW_IPC_DIR = ${JSON.stringify(args.env.HKCLAW_IPC_DIR)}
HKCLAW_HOST_IPC_DIR = ${JSON.stringify(args.env.HKCLAW_HOST_IPC_DIR)}
HKCLAW_CHAT_JID = ${JSON.stringify(args.chatJid)}
HKCLAW_GROUP_FOLDER = ${JSON.stringify(args.group.folder)}
HKCLAW_IS_MAIN = ${JSON.stringify(args.isMain ? '1' : '0')}
HKCLAW_AGENT_TYPE = ${JSON.stringify(args.env.HKCLAW_AGENT_TYPE)}
`;
    const mementoSseUrl =
      args.envVars.MEMENTO_MCP_SSE_URL || process.env.MEMENTO_MCP_SSE_URL;
    const mementoAccessKey = args.envVars.MEMENTO_ACCESS_KEY || '';
    const mementoRemotePath =
      args.envVars.MEMENTO_MCP_REMOTE_PATH ||
      process.env.MEMENTO_MCP_REMOTE_PATH ||
      'mcp-remote';
    const mementoSection = mementoSseUrl
      ? `
[mcp_servers.memento-mcp]
command = ${JSON.stringify(mementoRemotePath)}
args = [${JSON.stringify(mementoSseUrl)}, "--header", ${JSON.stringify(`Authorization:Bearer ${mementoAccessKey}`)}]
`
      : '';
    fs.writeFileSync(
      sessionConfigPath,
      [toml.trim(), mcpSection.trim(), mementoSection.trim()]
        .filter(Boolean)
        .join('\n\n') + '\n',
    );
  }

  delete args.env.ANTHROPIC_API_KEY;
  delete args.env.ANTHROPIC_AUTH_TOKEN;
  delete args.env.ANTHROPIC_BASE_URL;
  delete args.env.CLAUDE_CODE_OAUTH_TOKEN;
  args.env.CODEX_HOME = sessionCodexDir;
}

function stripManagedTomlTables(
  toml: string,
  managedPrefixes: string[],
): string {
  if (!toml.trim()) return '';

  const shouldSkipTable = (tableName: string): boolean =>
    managedPrefixes.some(
      (prefix) => tableName === prefix || tableName.startsWith(`${prefix}.`),
    );

  const keptLines: string[] = [];
  let skipCurrentTable = false;

  for (const line of toml.split('\n')) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      skipCurrentTable = shouldSkipTable(headerMatch[1].trim());
    }
    if (!skipCurrentTable) {
      keptLines.push(line);
    }
  }

  return keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PreparedGroupEnvironment {
  env: Record<string, string>;
  groupDir: string;
  runnerDir: string;
}

export function prepareGroupEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
  options?: {
    memoryBriefing?: string;
    runtimeTaskId?: string;
    useTaskScopedSession?: boolean;
  },
): PreparedGroupEnvironment {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runtimeTaskId = options?.runtimeTaskId;
  const useTaskScopedSession =
    options?.useTaskScopedSession === true && Boolean(runtimeTaskId);
  const sessionRootDir =
    runtimeTaskId && useTaskScopedSession
      ? resolveTaskSessionsPath(group.folder, runtimeTaskId)
      : resolveGroupSessionsPath(group.folder);

  const groupSessionsDir = path.join(sessionRootDir, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  ensureClaudeSessionSettings(groupSessionsDir);

  const workDirClaude = group.workDir
    ? path.join(group.workDir, '.claude')
    : null;
  const skillSources = [
    path.join(os.homedir(), '.claude', 'skills'),
    ...(workDirClaude ? [path.join(workDirClaude, 'skills')] : []),
    path.join(projectRoot, 'runners', 'skills'),
  ];
  syncDirectoryEntries(skillSources, path.join(groupSessionsDir, 'skills'));

  const groupIpcDir = runtimeTaskId
    ? resolveTaskRuntimeIpcPath(group.folder, runtimeTaskId)
    : resolveGroupIpcPath(group.folder);
  const hostIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  const isPairedRoom = isPairedRoomJid(chatJid);

  const claudePlatformPrompt = readPlatformPrompt('claude-code', projectRoot);
  const claudePairedRoomPrompt = isPairedRoom
    ? readPairedRoomPrompt('claude-code', projectRoot)
    : undefined;
  const globalClaudeMemory =
    !isMain && fs.existsSync(globalClaudeMdPath)
      ? fs.readFileSync(globalClaudeMdPath, 'utf-8').trim()
      : undefined;
  const sessionClaudeMd = [
    claudePlatformPrompt,
    claudePairedRoomPrompt,
    globalClaudeMemory,
    options?.memoryBriefing,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n---\n\n')
    .trim();
  const sessionClaudeMdPath = path.join(groupSessionsDir, 'CLAUDE.md');
  if (sessionClaudeMd) {
    fs.writeFileSync(sessionClaudeMdPath, sessionClaudeMd + '\n');
  } else if (fs.existsSync(sessionClaudeMdPath)) {
    fs.unlinkSync(sessionClaudeMdPath);
  }

  const agentType = group.agentType || 'claude-code';
  const runnerDirName = agentType === 'codex' ? 'codex-runner' : 'agent-runner';
  const runnerDir = path.join(projectRoot, 'runners', runnerDirName);

  const envVars = readServiceEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKENS',
    'CLAUDE_CODE_USE_CREDENTIAL_FILES',
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
    'CODEX_AUTH_JSON_B64',
    'CODEX_USE_HOME_AUTH',
    'CODEX_MODEL',
    'CODEX_EFFORT',
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
    'FALLBACK_ENABLED',
    'FALLBACK_PROVIDER_NAME',
    'FALLBACK_BASE_URL',
    'FALLBACK_AUTH_TOKEN',
    'FALLBACK_MODEL',
    'FALLBACK_SMALL_MODEL',
    'FALLBACK_COOLDOWN_MS',
    'MEMENTO_MCP_SSE_URL',
    'MEMENTO_ACCESS_KEY',
    'MEMENTO_MCP_REMOTE_PATH',
  ]);

  const env = buildBaseRunnerEnv({
    group,
    chatJid,
    isMain,
    groupDir,
    groupIpcDir,
    hostIpcDir,
    globalDir,
    groupSessionsDir,
    agentType,
    envVars,
    runtimeTaskId,
  });

  if (agentType === 'codex') {
    prepareCodexSessionEnvironment({
      env,
      envVars,
      projectRoot,
      group,
      groupDir,
      sessionRootDir,
      chatJid,
      isMain,
      isPairedRoom,
      memoryBriefing: options?.memoryBriefing,
    });
  } else {
    prepareClaudeEnvironment({ env, envVars, group });
  }

  return { env, groupDir, runnerDir };
}
