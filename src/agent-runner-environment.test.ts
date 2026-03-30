import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadServiceEnvFile, mockGetActiveCodexAuthPath } = vi.hoisted(() => ({
  mockReadServiceEnvFile: vi.fn<() => Record<string, string>>(),
  mockGetActiveCodexAuthPath: vi.fn<() => string | null>(),
}));

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/hkclaw-test-groups',
  TIMEZONE: 'Asia/Seoul',
}));

vi.mock('./db.js', () => ({
  isPairedRoomJid: vi.fn(() => false),
}));

vi.mock('./env.js', () => ({
  readServiceEnvFile: mockReadServiceEnvFile,
  SERVICE_SCOPED_ENV_KEYS: [],
  getEnv: vi.fn((key: string) => undefined),
}));

vi.mock('./codex-token-rotation.js', () => ({
  getActiveCodexAuthPath: mockGetActiveCodexAuthPath,
}));

vi.mock('./token-rotation.js', () => ({
  getCurrentToken: vi.fn(() => undefined),
}));

vi.mock('./platform-prompts.js', () => ({
  readPlatformPrompt: vi.fn(() => 'platform prompt'),
  readPairedRoomPrompt: vi.fn(() => 'paired room prompt'),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/ipc/${folder}`,
  resolveGroupSessionsPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/sessions/${folder}`,
  resolveTaskRuntimeIpcPath: (folder: string, taskId: string) =>
    `${process.env.EJ_TEST_ROOT}/task-ipc/${folder}/${taskId}`,
  resolveTaskSessionsPath: (folder: string, taskId: string) =>
    `${process.env.EJ_TEST_ROOT}/task-sessions/${folder}/${taskId}`,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => process.env.EJ_TEST_HOME || '/tmp',
    },
    homedir: () => process.env.EJ_TEST_HOME || '/tmp',
  };
});

import { prepareGroupEnvironment } from './agent-runner-environment.js';
import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Codex Test Group',
  folder: 'codex-test-group',
  trigger: '@Codex',
  added_at: new Date().toISOString(),
  agentType: 'codex',
};

describe('prepareGroupEnvironment codex auth handling', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousOpenAiKey: string | undefined;
  let previousCodexOpenAiKey: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'hkclaw-agent-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousCodexOpenAiKey = process.env.CODEX_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_OPENAI_API_KEY;

    fs.mkdirSync(process.env.EJ_TEST_HOME, { recursive: true });
    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadServiceEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    if (previousOpenAiKey) process.env.OPENAI_API_KEY = previousOpenAiKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousCodexOpenAiKey) {
      process.env.CODEX_OPENAI_API_KEY = previousCodexOpenAiKey;
    } else {
      delete process.env.CODEX_OPENAI_API_KEY;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('ignores OPENAI_API_KEY and always uses OAuth auth', () => {
    const embeddedAuth = {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'x' },
    };
    mockReadServiceEnvFile.mockReturnValue({
      OPENAI_API_KEY: 'sk-test-api-key',
      CODEX_AUTH_JSON_B64: Buffer.from(
        JSON.stringify(embeddedAuth),
        'utf-8',
      ).toString('base64'),
      CODEX_MODEL: 'gpt-5.4',
    });

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      auth_mode: string;
      OPENAI_API_KEY?: string;
      tokens?: unknown;
    };

    // API key auth is never used — always OAuth
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(auth.tokens).toEqual({ access_token: 'x' });
  });

  it('does not fall back to rotated OAuth auth when no per-service auth is configured', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    const rotatedAuth = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'oauth-access',
        refresh_token: 'oauth-refresh',
      },
    };
    fs.writeFileSync(rotatedAuthPath, JSON.stringify(rotatedAuth));
    mockGetActiveCodexAuthPath.mockReturnValue(rotatedAuthPath);
    mockReadServiceEnvFile.mockReturnValue({});

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.codex',
      'auth.json',
    );
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it('uses per-service CODEX_AUTH_JSON_B64 when configured', () => {
    const embeddedAuth = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'service-access',
        refresh_token: 'service-refresh',
      },
    };
    mockGetActiveCodexAuthPath.mockReturnValue(null);
    mockReadServiceEnvFile.mockReturnValue({
      CODEX_AUTH_JSON_B64: Buffer.from(
        JSON.stringify(embeddedAuth),
        'utf-8',
      ).toString('base64'),
    });

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));

    expect(auth).toEqual(embeddedAuth);
  });

  it('ensures FALLBACK_ENABLED exists in Claude session settings', () => {
    mockReadServiceEnvFile.mockReturnValue({});

    prepareGroupEnvironment(
      {
        ...group,
        agentType: 'claude-code',
      },
      false,
      'dc:test',
    );

    const settingsPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
    };

    expect(settings.env.FALLBACK_ENABLED).toBe('');
  });

  it('replaces managed Codex MCP tables instead of accumulating duplicates', () => {
    mockReadServiceEnvFile.mockReturnValue({});

    const sessionCodexDir = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.codex',
    );
    fs.mkdirSync(sessionCodexDir, { recursive: true });

    const sessionConfigPath = path.join(sessionCodexDir, 'config.toml');
    fs.writeFileSync(
      sessionConfigPath,
      `model = "gpt-5.4"

[mcp_servers.hkclaw]
command = "node"
args = ["old"]

[mcp_servers.hkclaw.env]
HKCLAW_CHAT_JID = "old"

[mcp_servers.memento-mcp]
command = "stale"

[mcp_servers.hkclaw.env]
HKCLAW_CHAT_JID = "stale"

[mcp_servers.ouroboros]
command = "ouro"

[mcp_servers.ouroboros.env]
OUROBOROS_AGENT_RUNTIME = "codex"
`,
    );

    const mcpServerPath = path.join(
      tempRoot,
      'runners',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    fs.mkdirSync(path.dirname(mcpServerPath), { recursive: true });
    fs.writeFileSync(mcpServerPath, '// test mcp server');

    prepareGroupEnvironment(group, false, 'dc:test');

    const nextToml = fs.readFileSync(sessionConfigPath, 'utf-8');
    expect(nextToml).toContain('[mcp_servers.ouroboros]');
    expect(nextToml).toContain('OUROBOROS_AGENT_RUNTIME = "codex"');
    expect(nextToml).toContain('HKCLAW_CHAT_JID = "dc:test"');
    expect((nextToml.match(/\[mcp_servers\.hkclaw\]/g) || []).length).toBe(1);
    expect((nextToml.match(/\[mcp_servers\.hkclaw\.env\]/g) || []).length).toBe(
      1,
    );
    expect((nextToml.match(/\[mcp_servers\.memento-mcp\]/g) || []).length).toBe(
      0,
    );
    expect(nextToml).not.toContain('HKCLAW_CHAT_JID = "old"');
    expect(nextToml).not.toContain('HKCLAW_CHAT_JID = "stale"');
  });
});
