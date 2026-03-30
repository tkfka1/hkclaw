import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAdminWebChatMessage,
  _initTestDatabase,
  getRegisteredGroup,
  setRegisteredGroup,
  storeMessage,
  storeChatMetadata,
  upsertOfficeTeam,
} from './db.js';
import {
  deleteOfficeTeamConfig,
  deleteServiceConfig,
  readAdminChatHistory,
  readAdminState,
  upsertOfficeTeamConfig,
  upsertOfficeTeamLayoutConfig,
  upsertOfficeRoomLayoutConfig,
  upsertServiceConfig,
} from './service-admin.js';

const tempDirs: string[] = [];

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(files?: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-service-admin-'));
  tempDirs.push(dir);

  const entries = {
    '.env': ['ASSISTANT_NAME=Andy', 'SERVICE_ROLE=normal', ''].join('\n'),
    ...files,
  };

  for (const [filePath, content] of Object.entries(entries)) {
    const absolutePath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf-8');
  }

  return dir;
}

describe('upsertServiceConfig', () => {
  it('requires a status channel for dashboard services', () => {
    const projectRoot = createProject();

    expect(() =>
      upsertServiceConfig(projectRoot, {
        assistantName: 'Dashboard',
        serviceId: 'dashboard',
        agentType: 'claude-code',
        role: 'dashboard',
      }),
    ).toThrow('Dashboard role requires a Discord status channel ID');
  });

  it('normalizes dashboard status channel inputs into raw ids', () => {
    const projectRoot = createProject();

    const result = upsertServiceConfig(projectRoot, {
      assistantName: 'Dashboard',
      serviceId: 'dashboard',
      agentType: 'claude-code',
      role: 'dashboard',
      statusChannelId: '<#1486792500814413957>',
    });

    const envFile = fs.readFileSync(result.envPath, 'utf-8');
    expect(envFile).toContain('STATUS_CHANNEL_ID=1486792500814413957');
  });

  it('creates an initial team assignment when teamJid targets a linked team', () => {
    const projectRoot = createProject();
    storeChatMetadata(
      'dc:1486792500814413957',
      new Date().toISOString(),
      'Ops Team',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'ops-team',
      name: 'Ops Team',
      linked_jid: 'dc:1486792500814413957',
      folder: 'ops-team-room',
      requires_mention: true,
      color: '#57d1b7',
    });

    upsertServiceConfig(projectRoot, {
      assistantName: 'Ops Bot',
      serviceId: 'ops-bot',
      agentType: 'claude-code',
      teamJid: 'dc:1486792500814413957',
    });

    const assignment = getRegisteredGroup('dc:1486792500814413957', {
      serviceId: 'ops-bot',
    });
    expect(assignment?.folder).toBe('ops-team-room');
    expect(assignment?.requiresTrigger).toBe(true);
  });

  it('uses each service name as its own mention trigger in shared teams', () => {
    const projectRoot = createProject();
    const teamJid = 'dc:1486792500814413957';
    storeChatMetadata(
      teamJid,
      new Date().toISOString(),
      'Both Team',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'both-team',
      name: 'Both Team',
      linked_jid: teamJid,
      folder: 'both-room',
      requires_mention: true,
      color: '#57d1b7',
    });

    upsertServiceConfig(projectRoot, {
      assistantName: '징징이',
      serviceId: 'jingjing',
      agentType: 'codex',
      teamJid: teamJid,
    });
    upsertServiceConfig(projectRoot, {
      assistantName: '스폰지밥',
      serviceId: 'spongebob',
      agentType: 'codex',
      teamJid: teamJid,
    });

    expect(
      getRegisteredGroup(teamJid, { serviceId: 'jingjing' })?.trigger,
    ).toBe('@징징이');
    expect(
      getRegisteredGroup(teamJid, { serviceId: 'spongebob' })?.trigger,
    ).toBe('@스폰지밥');
  });

  it('refreshes existing assignment triggers when assistant names change', () => {
    const projectRoot = createProject();
    const teamJid = 'dc:1486792500814413957';
    storeChatMetadata(
      teamJid,
      new Date().toISOString(),
      'Both Team',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'both-team',
      name: 'Both Team',
      linked_jid: teamJid,
      folder: 'both-room',
      requires_mention: true,
      color: '#57d1b7',
    });

    upsertServiceConfig(projectRoot, {
      assistantName: 'Old Name',
      serviceId: 'rename-bot',
      agentType: 'codex',
      teamJid: teamJid,
    });
    expect(
      getRegisteredGroup(teamJid, { serviceId: 'rename-bot' })?.trigger,
    ).toBe('@Old Name');

    upsertServiceConfig(projectRoot, {
      existingServiceId: 'rename-bot',
      assistantName: 'New Name',
      agentType: 'codex',
    });

    expect(
      getRegisteredGroup(teamJid, { serviceId: 'rename-bot' })?.trigger,
    ).toBe('@New Name');
  });

  it('includes the current bot token value in admin state config', () => {
    const projectRoot = createProject();

    upsertServiceConfig(projectRoot, {
      assistantName: 'Ops Bot',
      serviceId: 'ops-bot',
      agentType: 'claude-code',
      discordBotToken: 'discord-secret-token',
    });

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'ops-bot',
    );
    expect(service?.config.botTokenConfigured).toBe(true);
    expect(service?.config.botTokenValue).toBe('discord-secret-token');
  });

  it('includes the current codex auth json value in admin state config', () => {
    const projectRoot = createProject();
    const authJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        account_id: 'acct-1',
      },
    });

    upsertServiceConfig(projectRoot, {
      assistantName: 'Codex Bot',
      serviceId: 'codex-bot',
      agentType: 'codex',
      codexAuthJson: authJson,
    });

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'codex-bot',
    );
    expect(service?.config.codexAuthJsonConfigured).toBe(true);
    expect(service?.config.codexAuthJsonValue).toBe(authJson);
  });

  it('keeps only Claude auth for Claude services while preserving per-service fallback', () => {
    const projectRoot = createProject();

    const result = upsertServiceConfig(projectRoot, {
      assistantName: 'Claude Bot',
      serviceId: 'claude-bot',
      agentType: 'claude-code',
      anthropicBaseUrl: 'https://claude.example',
      claudeCodeOauthToken: 'claude-token',
      codexAuthJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { account_id: 'acct-1' },
      }),
      fallbackEnabled: 'true',
      fallbackProviderName: 'kimi',
      fallbackBaseUrl: 'https://fallback.example',
      fallbackAuthToken: 'fallback-token',
      fallbackModel: 'kimi-k2.5',
    });

    const envFile = fs.readFileSync(result.envPath, 'utf-8');
    expect(envFile).toContain('CLAUDE_CODE_OAUTH_TOKEN=claude-token');
    expect(envFile).toContain('FALLBACK_AUTH_TOKEN=fallback-token');
    expect(envFile).not.toContain('CODEX_AUTH_JSON_B64=');

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'claude-bot',
    );
    expect(service?.config.claudeCodeOauthTokenConfigured).toBe(true);
    expect(service?.config.codexAuthJsonConfigured).toBe(false);
    expect(service?.config.fallbackAuthTokenConfigured).toBe(true);
  });

  it('keeps only Codex auth for Codex services while preserving per-service fallback', () => {
    const projectRoot = createProject();
    const authJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { account_id: 'acct-1' },
    });

    const result = upsertServiceConfig(projectRoot, {
      assistantName: 'Codex Bot',
      serviceId: 'codex-only-bot',
      agentType: 'codex',
      anthropicBaseUrl: 'https://claude.example',
      claudeCodeOauthToken: 'claude-token',
      codexAuthJson: authJson,
      fallbackEnabled: 'true',
      fallbackProviderName: 'kimi',
      fallbackBaseUrl: 'https://fallback.example',
      fallbackAuthToken: 'fallback-token',
      fallbackModel: 'kimi-k2.5',
    });

    const envFile = fs.readFileSync(result.envPath, 'utf-8');
    expect(envFile).toContain(
      `CODEX_AUTH_JSON_B64=${Buffer.from(authJson, 'utf-8').toString('base64')}`,
    );
    expect(envFile).toContain('FALLBACK_AUTH_TOKEN=fallback-token');
    expect(envFile).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(envFile).not.toContain('ANTHROPIC_BASE_URL=');

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'codex-only-bot',
    );
    expect(service?.config.codexAuthJsonConfigured).toBe(true);
    expect(service?.config.claudeCodeOauthTokenConfigured).toBe(false);
    expect(service?.config.fallbackAuthTokenConfigured).toBe(true);
  });

  it('does not inherit fallback secrets from base .env into overlay services', () => {
    const projectRoot = createProject({
      '.env': [
        'ASSISTANT_NAME=Andy',
        'SERVICE_ROLE=normal',
        'FALLBACK_ENABLED=true',
        'FALLBACK_PROVIDER_NAME=kimi',
        'FALLBACK_BASE_URL=https://shared-fallback.example',
        'FALLBACK_AUTH_TOKEN=shared-secret',
        'FALLBACK_MODEL=kimi-k2.5',
        '',
      ].join('\n'),
    });

    upsertServiceConfig(projectRoot, {
      assistantName: 'Overlay Bot',
      serviceId: 'overlay-bot',
      agentType: 'codex',
      codexAuthJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { account_id: 'acct-1' },
      }),
    });

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'overlay-bot',
    );
    expect(service?.config.fallbackEnabled).toBe('');
    expect(service?.config.fallbackBaseUrl).toBe('');
    expect(service?.config.fallbackAuthTokenConfigured).toBe(false);
  });

  it('includes raw secret values for visible admin fields', () => {
    const projectRoot = createProject();

    upsertServiceConfig(projectRoot, {
      assistantName: 'Secrets Bot',
      serviceId: 'secrets-bot',
      agentType: 'claude-code',
      anthropicAuthToken: 'anthropic-secret',
      claudeCodeOauthToken: 'claude-oauth-token',
      claudeCodeOauthTokens: 'multi-token-secret',
      openAiApiKey: 'openai-secret',
      groqApiKey: 'groq-secret',
      fallbackAuthToken: 'fallback-secret',
    });

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'secrets-bot',
    );
    expect(service?.config.anthropicAuthTokenConfigured).toBe(true);
    expect(service?.config.anthropicAuthTokenValue).toBe('anthropic-secret');
    expect(service?.config.claudeCodeOauthTokenConfigured).toBe(true);
    expect(service?.config.claudeCodeOauthTokenValue).toBe(
      'claude-oauth-token',
    );
    expect(service?.config.claudeCodeOauthTokensConfigured).toBe(true);
    expect(service?.config.claudeCodeOauthTokensValue).toBe(
      'multi-token-secret',
    );
    expect(service?.config.openAiApiKeyConfigured).toBe(true);
    expect(service?.config.openAiApiKeyValue).toBe('openai-secret');
    expect(service?.config.groqApiKeyConfigured).toBe(true);
    expect(service?.config.groqApiKeyValue).toBe('groq-secret');
    expect(service?.config.fallbackAuthTokenConfigured).toBe(true);
    expect(service?.config.fallbackAuthTokenValue).toBe('fallback-secret');
  });

  it('stores transcription and reply voice settings in env and admin state', () => {
    const projectRoot = createProject();

    const result = upsertServiceConfig(projectRoot, {
      assistantName: 'Voice Bot',
      serviceId: 'voice-bot',
      agentType: 'codex',
      groqTranscriptionModel: 'whisper-large-v3',
      openAiTranscriptionModel: 'whisper-1',
      transcriptionLanguage: 'ko',
      edgeTtsVoice: 'ko-KR-SunHiNeural',
      edgeTtsLang: 'ko-KR',
      edgeTtsRate: '+10%',
    });

    const envFile = fs.readFileSync(result.envPath, 'utf-8');
    expect(envFile).toContain(
      'DISCORD_GROQ_TRANSCRIPTION_MODEL=whisper-large-v3',
    );
    expect(envFile).toContain('DISCORD_OPENAI_TRANSCRIPTION_MODEL=whisper-1');
    expect(envFile).toContain('DISCORD_TRANSCRIPTION_LANGUAGE=ko');
    expect(envFile).toContain('DISCORD_EDGE_TTS_VOICE=ko-KR-SunHiNeural');
    expect(envFile).toContain('DISCORD_EDGE_TTS_LANG=ko-KR');
    expect(envFile).toContain('DISCORD_EDGE_TTS_RATE=+10%');

    const state = readAdminState(projectRoot);
    const service = state.services.find(
      (entry) => entry.serviceId === 'voice-bot',
    );
    expect(service?.config.groqTranscriptionModel).toBe('whisper-large-v3');
    expect(service?.config.openAiTranscriptionModel).toBe('whisper-1');
    expect(service?.config.transcriptionLanguage).toBe('ko');
    expect(service?.config.edgeTtsVoice).toBe('ko-KR-SunHiNeural');
    expect(service?.config.edgeTtsLang).toBe('ko-KR');
    expect(service?.config.edgeTtsRate).toBe('+10%');
  });

  it('stores team layout size and rename updates', () => {
    const projectRoot = createProject();
    const { teamId } = upsertOfficeTeamConfig(projectRoot, {
      name: 'Ops Team',
      color: '#57d1b7',
    });

    upsertOfficeTeamLayoutConfig(projectRoot, {
      teamId,
      name: 'Ops Command',
      left: 12.5,
      top: 34.5,
      width: 21.5,
      height: 17.5,
    });

    const state = readAdminState(projectRoot);
    const team = state.teams.find((entry) => entry.teamId === teamId);
    expect(team?.name).toBe('Ops Command');
    expect(team?.layoutLeft).toBe(12.5);
    expect(team?.layoutTop).toBe(34.5);
    expect(team?.layoutWidth).toBe(21.5);
    expect(team?.layoutHeight).toBe(17.5);
  });

  it('stores room layout size and custom room names', () => {
    const projectRoot = createProject();

    upsertOfficeRoomLayoutConfig(projectRoot, {
      roomId: 'general',
      name: '총무 오퍼레이션',
      left: 14.2,
      top: 48.1,
      width: 19.7,
      height: 22.4,
    });

    const state = readAdminState(projectRoot);
    expect(state.company.roomLayouts.general).toMatchObject({
      name: '총무 오퍼레이션',
      left: 14.2,
      top: 48.1,
      width: 19.7,
      height: 22.4,
    });
  });

  it('allows initial team assignment for a channel-derived team', () => {
    const projectRoot = createProject();
    storeChatMetadata(
      'dc:1486792500814413957',
      new Date().toISOString(),
      'Derived Team',
      'discord',
      true,
    );
    setRegisteredGroup('dc:1486792500814413957', {
      name: 'Derived Team',
      folder: 'derived-team-room',
      trigger: '@Anchor',
      added_at: new Date().toISOString(),
      serviceId: 'anchor-bot',
      agentType: 'claude-code',
      requiresTrigger: true,
    });

    upsertServiceConfig(projectRoot, {
      assistantName: 'New Bot',
      serviceId: 'new-bot',
      agentType: 'claude-code',
      teamJid: 'dc:1486792500814413957',
    });

    expect(
      getRegisteredGroup('dc:1486792500814413957', { serviceId: 'new-bot' })
        ?.folder,
    ).toBe('derived-team-room');
  });

  it('moves assigned staff when a linked team channel changes', () => {
    const projectRoot = createProject();
    storeChatMetadata(
      'dc:1486792500814413957',
      new Date().toISOString(),
      'Ops Team',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:998877665544332211',
      new Date().toISOString(),
      'Ops Team 2',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'ops-team',
      name: 'Ops Team',
      linked_jid: 'dc:1486792500814413957',
      folder: 'ops-team-room',
      requires_mention: true,
      color: '#57d1b7',
    });
    upsertServiceConfig(projectRoot, {
      assistantName: 'Ops Bot',
      serviceId: 'ops-bot',
      agentType: 'claude-code',
      teamJid: 'dc:1486792500814413957',
    });

    upsertOfficeTeamConfig(projectRoot, {
      teamId: 'ops-team',
      name: 'Ops Team',
      linkedJid: 'dc:998877665544332211',
      folder: 'ops-team-room',
      requiresMention: true,
      color: '#57d1b7',
    });

    expect(
      getRegisteredGroup('dc:1486792500814413957', { serviceId: 'ops-bot' }),
    ).toBeUndefined();
    expect(
      getRegisteredGroup('dc:998877665544332211', { serviceId: 'ops-bot' })
        ?.folder,
    ).toBe('ops-team-room');
  });

  it('blocks deleting a team while staff are still assigned', () => {
    const projectRoot = createProject();
    storeChatMetadata(
      'dc:1486792500814413957',
      new Date().toISOString(),
      'Ops Team',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'ops-team',
      name: 'Ops Team',
      linked_jid: 'dc:1486792500814413957',
      folder: 'ops-team-room',
      requires_mention: true,
      color: '#57d1b7',
    });
    upsertServiceConfig(projectRoot, {
      assistantName: 'Ops Bot',
      serviceId: 'ops-bot',
      agentType: 'claude-code',
      teamJid: 'dc:1486792500814413957',
    });

    expect(() => deleteOfficeTeamConfig(projectRoot, 'ops-team')).toThrow(
      'Remove assigned or active staff from this team before deleting it',
    );
  });

  it('shows Discord channel history alongside web chat history in team chat', () => {
    const projectRoot = createProject();
    const chatJid = 'dc:1486805999535783986';
    storeChatMetadata(
      chatJid,
      '2026-03-28T09:00:00.000Z',
      'call',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'call',
      name: 'call',
      linked_jid: chatJid,
      folder: 'call',
      requires_mention: false,
      color: '#ffbf69',
    });
    upsertServiceConfig(projectRoot, {
      assistantName: '뚱이',
      serviceId: 'ddung',
      agentType: 'codex',
      teamJid: chatJid,
    });

    storeMessage({
      id: 'discord-1',
      chat_jid: chatJid,
      sender: 'user-1',
      sender_name: 'han',
      content: '디스코드에서 한 말',
      timestamp: '2026-03-28T09:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'discord-2',
      chat_jid: chatJid,
      sender: 'bot-1',
      sender_name: '뚱이',
      content: '디스코드에 남은 답변',
      timestamp: '2026-03-28T09:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    createAdminWebChatMessage({
      service_id: 'team:call',
      role: 'user',
      content: '웹게임에서 보낸 말',
    });

    const history = readAdminChatHistory(projectRoot, { teamId: 'call' });
    expect(history.map((entry) => entry.content)).toEqual([
      '디스코드에서 한 말',
      '디스코드에 남은 답변',
      '웹게임에서 보낸 말',
    ]);
    expect(history[0]?.senderName).toBe('han');
    expect(history[1]?.role).toBe('assistant');
  });

  it('deletes an overlay service and clears its assignments', () => {
    const projectRoot = createProject();
    const serviceId = 'vitest-delete-worker';
    storeChatMetadata(
      'dc:1486792500814413957',
      new Date().toISOString(),
      'Ops Team',
      'discord',
      true,
    );
    upsertOfficeTeam({
      team_id: 'ops-team',
      name: 'Ops Team',
      linked_jid: 'dc:1486792500814413957',
      folder: 'ops-team-room',
      requires_mention: true,
      color: '#57d1b7',
    });

    const result = upsertServiceConfig(projectRoot, {
      assistantName: 'Delete Bot',
      serviceId,
      agentType: 'claude-code',
      teamJid: 'dc:1486792500814413957',
    });
    expect(fs.existsSync(result.envPath)).toBe(true);

    deleteServiceConfig(projectRoot, serviceId);

    expect(fs.existsSync(result.envPath)).toBe(false);
    expect(
      getRegisteredGroup('dc:1486792500814413957', { serviceId }),
    ).toBeUndefined();
    const state = readAdminState(projectRoot);
    expect(state.services.some((entry) => entry.serviceId === serviceId)).toBe(
      false,
    );
  });
});
