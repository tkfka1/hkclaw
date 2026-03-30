import fs from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import { Readable, Transform } from 'stream';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
const getEnvMock = vi.hoisted(() => vi.fn() as any);

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
  getEnv: getEnvMock,
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/hkclaw-test-data',
  CACHE_DIR: '/tmp/hkclaw-test-cache',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const isPairedRoomJidMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('../db.js', () => ({
  isPairedRoomJid: isPairedRoomJidMock,
}));

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));
const loginBehaviorRef = vi.hoisted(() => ({
  rejectMessageContentIntent: false,
  loginIntents: [] as number[][],
}));
const channelFetchMock = vi.hoisted(() => vi.fn());
const joinVoiceChannelMock = vi.hoisted(() => vi.fn());
const entersStateMock = vi.hoisted(() => vi.fn());
const createAudioPlayerMock = vi.hoisted(() => vi.fn());
const createAudioResourceMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const edgeTtsPromiseMock = vi.hoisted(() => vi.fn());
const voiceConnectionRef = vi.hoisted(() => ({ current: null as any }));
const audioPlayerRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel: joinVoiceChannelMock,
  entersState: entersStateMock,
  createAudioPlayer: createAudioPlayerMock,
  createAudioResource: createAudioResourceMock,
  VoiceConnectionStatus: {
    Ready: 'ready',
    Disconnected: 'disconnected',
  },
  AudioPlayerStatus: {
    Playing: 'playing',
    Idle: 'idle',
  },
  NoSubscriberBehavior: {
    Pause: 'pause',
  },
  StreamType: {
    OggOpus: 'ogg/opus',
  },
  EndBehaviorType: {
    AfterSilence: 1,
  },
}));

vi.mock('prism-media', () => ({
  default: {
    opus: {
      Decoder: class MockDecoder extends Transform {
        _transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: (error?: Error | null) => void,
        ) {
          this.push(chunk);
          callback();
        }
      },
    },
  },
}));

vi.mock('node-edge-tts', () => ({
  EdgeTTS: class MockEdgeTTS {
    ttsPromise(text: string, outputPath: string) {
      return edgeTtsPromiseMock(text, outputPath);
    }
  },
}));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    GuildVoiceStates: 4,
    MessageContent: 8,
    DirectMessages: 16,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;
    private intents: number[];

    constructor(opts: any) {
      this.intents = opts?.intents || [];
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      loginBehaviorRef.loginIntents.push([...this.intents]);
      if (
        loginBehaviorRef.rejectMessageContentIntent &&
        this.intents.includes(GatewayIntentBits.MessageContent)
      ) {
        throw new Error('Used disallowed intents');
      }
      this._ready = true;
      // Fire the ready event
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        h({ user: this.user });
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: channelFetchMock,
    };

    destroy() {
      this._ready = false;
    }
  }

  // Mock TextChannel type
  class TextChannel {}

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    MessageFlags: { SuppressEmbeds: 1 << 2 },
    TextChannel,
  };
});

import { DiscordChannel, DiscordChannelOpts } from './discord.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
  mentionedUsers?: Array<{
    id: string;
    username?: string;
    displayName?: string;
  }>;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, {
      id: botId,
      username: 'Andy',
      displayName: 'Andy',
    });
  }
  for (const mentionedUser of overrides.mentionedUsers || []) {
    mentionsMap.set(mentionedUser.id, {
      id: mentionedUser.id,
      username:
        mentionedUser.username ?? mentionedUser.displayName ?? mentionedUser.id,
      displayName: mentionedUser.displayName ?? mentionedUser.username,
    });
  }

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName ? { name: overrides.guildName } : null,
    channel: {
      name: overrides.channelName ?? 'general',
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginBehaviorRef.rejectMessageContentIntent = false;
    loginBehaviorRef.loginIntents = [];
    isPairedRoomJidMock.mockReturnValue(false);
    getEnvMock.mockReset();
    getEnvMock.mockReturnValue(undefined);
    channelFetchMock.mockReset();
    channelFetchMock.mockResolvedValue({
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
    });
    joinVoiceChannelMock.mockReset();
    createAudioPlayerMock.mockReset();
    createAudioResourceMock.mockReset();
    entersStateMock.mockReset();
    execFileMock.mockReset();
    edgeTtsPromiseMock.mockReset();
    edgeTtsPromiseMock.mockImplementation(
      async (_text: string, outputPath: string) => {
        fs.mkdirSync('/tmp/hkclaw-test-cache/voice-tts', { recursive: true });
        fs.writeFileSync(outputPath, Buffer.from([1, 2, 3, 4]));
      },
    );
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[] = [],
        options:
          | ((err: Error | null, stdout: string, stderr: string) => void)
          | {
              env?: Record<string, string>;
            }
          | undefined,
        callback?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const done =
          typeof options === 'function'
            ? options
            : callback || (() => undefined);
        const outputPath =
          typeof options === 'function'
            ? args.at(-1)
            : options?.env?.HKCLAW_TTS_OUTPUT || args.at(-1);

        if (outputPath) {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, Buffer.from([1, 2, 3, 4]));
        }

        done(null, '', '');
        return {} as any;
      },
    );

    const audioPlayer = {
      on: vi.fn().mockReturnThis(),
      play: vi.fn(),
      stop: vi.fn(),
    };
    audioPlayerRef.current = audioPlayer;
    createAudioPlayerMock.mockReturnValue(audioPlayer);
    createAudioResourceMock.mockImplementation((input: any, options: any) => ({
      input,
      options,
    }));

    const speaking = new EventEmitter();
    const voiceConnection = {
      joinConfig: { channelId: '1486805999535783986' },
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      removeAllListeners: vi.fn(),
      destroy: vi.fn(),
      receiver: {
        speaking,
        subscribe: vi.fn(() => Readable.from([])),
      },
    };
    voiceConnectionRef.current = voiceConnection;
    joinVoiceChannelMock.mockReturnValue(voiceConnection);
    entersStateMock.mockImplementation(async (target: any) => target);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('auto-joins configured voice channel on ready', async () => {
      getEnvMock.mockImplementation((key: string) =>
        key === 'DISCORD_VOICE_CHANNEL_ID' ? '1486805999535783986' : undefined,
      );

      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      const voiceAdapterCreator = {};
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'voice-room',
        guild: { id: 'guild-1', voiceAdapterCreator },
        isVoiceBased: () => true,
      });

      await channel.connect();

      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalled());

      expect(joinVoiceChannelMock).toHaveBeenCalledWith({
        channelId: '1486805999535783986',
        guildId: 'guild-1',
        adapterCreator: voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
        group: 'discord',
      });
      expect(entersStateMock).toHaveBeenCalled();
    });

    it('auto-joins a registered Discord voice group without legacy voice env config', async () => {
      const voiceAdapterCreator = {};
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1486805999535783986': {
            name: 'Call Room',
            folder: 'call',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            requiresTrigger: false,
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'call',
        guild: { id: 'guild-1', voiceAdapterCreator },
        isVoiceBased: () => true,
      });

      await channel.connect();

      await vi.waitFor(() =>
        expect(joinVoiceChannelMock).toHaveBeenCalledWith({
          channelId: '1486805999535783986',
          guildId: 'guild-1',
          adapterCreator: voiceAdapterCreator,
          selfDeaf: false,
          selfMute: true,
          group: 'discord',
        }),
      );
    });

    it('retries without MessageContent intent when Discord rejects it', async () => {
      loginBehaviorRef.rejectMessageContentIntent = true;
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(loginBehaviorRef.loginIntents).toHaveLength(2);
      expect(loginBehaviorRef.loginIntents[0]).toContain(8);
      expect(loginBehaviorRef.loginIntents[1]).not.toContain(8);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
        'discord',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
        'discord',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores its own bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        authorId: '999888777',
        isBot: true,
        content: 'I am the connected bot',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores other bot messages in normal rooms', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        authorId: '111222333',
        isBot: true,
        content: 'I am another bot',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers addressed bot messages in normal rooms', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        authorId: '111222333',
        isBot: true,
        content: '<@999888777> review this',
        mentionsBotId: true,
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy review this',
          is_bot_message: true,
        }),
      );
    });

    it('delivers other bot messages in paired rooms', async () => {
      isPairedRoomJidMock.mockReturnValue(true);

      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        authorId: '111222333',
        isBot: true,
        content: 'I am another bot',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'I am another bot',
          is_bot_message: true,
        }),
      );
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
        'discord',
        false,
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
        'discord',
        true,
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('normalizes a leading bot mention inline', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('normalizes incidental mentions inline without prepending a trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello @Andy',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });

    it('normalizes all mentioned users consistently across bots', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> ask <@111222333> to review this',
        mentionsBotId: true,
        mentionedUsers: [
          { id: '111222333', username: '징징이', displayName: '징징이' },
        ],
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy ask @징징이 to review this',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
          text: () => Promise.resolve('Hello from text file'),
        }),
      );
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            id: 'att1',
            name: 'photo.png',
            contentType: 'image/png',
            url: 'https://cdn.example.com/photo.png',
          },
        ],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: expect.stringMatching(/^\[Image: .+\.png\]$/),
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[File: report.pdf]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            id: 'att1',
            name: 'photo.jpg',
            contentType: 'image/jpeg',
            url: 'https://cdn.example.com/photo.jpg',
          },
        ],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: expect.stringMatching(
            /^Check this out\n\[Image: .+\.jpg\]$/,
          ),
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            id: 'att1',
            name: 'a.png',
            contentType: 'image/png',
            url: 'https://cdn.example.com/a.png',
          },
        ],
        [
          'att2',
          {
            id: 'att2',
            name: 'b.txt',
            contentType: 'text/plain',
            url: 'https://cdn.example.com/b.txt',
          },
        ],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: expect.stringMatching(
            /^\[Image: .+\.png\]\n\[File: b\.txt\]\nHello from text file$/,
          ),
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Reply to Bob] I agree with that',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('voice conversation', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('turns live voice input into a synthetic inbound message', async () => {
      getEnvMock.mockImplementation((key: string) => {
        if (key === 'DISCORD_VOICE_CHANNEL_ID') return '1486805999535783986';
        if (key === 'GROQ_API_KEY') return 'test-groq-key';
        return undefined;
      });

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1486805999535783986': {
            name: 'Voice Room',
            folder: 'voice-room',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);

      const pcm = Buffer.alloc(64_000, 1);
      voiceConnectionRef.current.receiver.subscribe.mockReturnValueOnce(
        Readable.from([pcm]),
      );
      const sendMock = vi.fn().mockResolvedValue(undefined);
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'voice-room',
        send: sendMock,
        guild: {
          id: 'guild-1',
          name: 'Test Server',
          voiceAdapterCreator: {},
          members: {
            fetch: vi.fn().mockResolvedValue({
              displayName: 'Alice Voice',
              user: { displayName: 'Alice Voice', username: 'alice' },
            }),
          },
        },
        isVoiceBased: () => true,
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: '안녕 코덱스' }),
      } as any);

      await channel.connect();

      voiceConnectionRef.current.receiver.speaking.emit('start', 'user-1');
      await vi.waitFor(() =>
        expect(opts.onMessage).toHaveBeenCalledWith(
          'dc:1486805999535783986',
          expect.objectContaining({
            sender: 'user-1',
            sender_name: 'Alice Voice',
            content: '@Andy 안녕 코덱스',
          }),
        ),
      );
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('passes configured transcription model and language to Groq live voice', async () => {
      getEnvMock.mockImplementation((key: string) => {
        if (key === 'DISCORD_VOICE_CHANNEL_ID') return '1486805999535783986';
        if (key === 'GROQ_API_KEY') return 'test-groq-key';
        if (key === 'DISCORD_GROQ_TRANSCRIPTION_MODEL')
          return 'whisper-large-v3';
        if (key === 'DISCORD_TRANSCRIPTION_LANGUAGE') return 'ko';
        return undefined;
      });

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1486805999535783986': {
            name: 'Voice Room',
            folder: 'voice-room',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);

      const pcm = Buffer.alloc(64_000, 1);
      voiceConnectionRef.current.receiver.subscribe.mockReturnValueOnce(
        Readable.from([pcm]),
      );
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'voice-room',
        send: vi.fn().mockResolvedValue(undefined),
        guild: {
          id: 'guild-1',
          name: 'Test Server',
          voiceAdapterCreator: {},
          members: {
            fetch: vi.fn().mockResolvedValue({
              displayName: 'Alice Voice',
              user: { displayName: 'Alice Voice', username: 'alice' },
            }),
          },
        },
        isVoiceBased: () => true,
      });

      let requestBody: any = null;
      globalThis.fetch = vi.fn().mockImplementation(async (_url, init: any) => {
        requestBody = init?.body as FormData;
        return {
          ok: true,
          json: async () => ({ text: '안녕 코덱스' }),
        } as any;
      });

      await channel.connect();
      voiceConnectionRef.current.receiver.speaking.emit('start', 'user-1');

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      expect(requestBody?.get('model')).toBe('whisper-large-v3');
      expect(requestBody?.get('language')).toBe('ko');
    });

    it('plays synthesized voice replies and writes text in joined voice channels', async () => {
      getEnvMock.mockImplementation((key: string) => {
        if (key === 'DISCORD_VOICE_CHANNEL_ID') return '1486805999535783986';
        if (key === 'DISCORD_TTS_PROVIDERS') return 'edge';
        if (key === 'DISCORD_EDGE_TTS_RATE') return '+25%';
        return undefined;
      });

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1486805999535783986': {
            name: 'Voice Room',
            folder: 'voice-room',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);

      const sendMock = vi.fn().mockResolvedValue(undefined);
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'voice-room',
        send: sendMock,
        guild: {
          id: 'guild-1',
          name: 'Test Server',
          voiceAdapterCreator: {},
          members: { fetch: vi.fn() },
        },
        isVoiceBased: () => true,
      });

      await channel.connect();
      await channel.sendMessage('dc:1486805999535783986', '안녕하세요');

      expect(execFileMock).toHaveBeenCalled();
      const synthCall = execFileMock.mock.calls.find(
        ([file]) => file === process.execPath,
      );
      expect(synthCall?.[2]).toMatchObject({
        env: expect.objectContaining({
          HKCLAW_TTS_RATE: '+25%',
        }),
      });
      expect(createAudioResourceMock).toHaveBeenCalled();
      expect(audioPlayerRef.current.play).toHaveBeenCalled();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '안녕하세요',
        }),
      );
    });

    it('sends a text log and plays a voice reply in a unified call room after voice input', async () => {
      getEnvMock.mockImplementation((key: string) => {
        if (key === 'DISCORD_VOICE_CHANNEL_ID') return '1486805999535783986';
        if (key === 'GROQ_API_KEY') return 'test-groq-key';
        if (key === 'DISCORD_TTS_PROVIDERS') return 'edge';
        return undefined;
      });

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1486805999535783986': {
            name: 'Voice Room',
            folder: 'voice-room',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            requiresTrigger: false,
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);

      const pcm = Buffer.alloc(64_000, 1);
      voiceConnectionRef.current.receiver.subscribe.mockReturnValueOnce(
        Readable.from([pcm]),
      );
      const sendMock = vi.fn().mockResolvedValue(undefined);
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'voice-room',
        send: sendMock,
        guild: {
          id: 'guild-1',
          name: 'Test Server',
          voiceAdapterCreator: {},
          members: {
            fetch: vi.fn().mockResolvedValue({
              displayName: 'Alice Voice',
              user: { displayName: 'Alice Voice', username: 'alice' },
            }),
          },
        },
        isVoiceBased: () => true,
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: '안녕 코덱스' }),
      } as any);

      await channel.connect();
      voiceConnectionRef.current.receiver.speaking.emit('start', 'user-1');
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      sendMock.mockClear();

      await channel.sendMessage('dc:1486805999535783986', '안녕하세요');

      expect(audioPlayerRef.current.play).toHaveBeenCalled();
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '안녕하세요',
        }),
      );
    });

    it('sends a text-only reply in a unified call room after text input', async () => {
      getEnvMock.mockImplementation((key: string) =>
        key === 'DISCORD_VOICE_CHANNEL_ID' ? '1486805999535783986' : undefined,
      );

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1486805999535783986': {
            name: 'Voice Room',
            folder: 'voice-room',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            requiresTrigger: false,
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);

      const sendMock = vi.fn().mockResolvedValue(undefined);
      channelFetchMock.mockResolvedValue({
        id: '1486805999535783986',
        name: 'voice-room',
        send: sendMock,
        guild: {
          id: 'guild-1',
          name: 'Test Server',
          voiceAdapterCreator: {},
          members: { fetch: vi.fn() },
        },
        isVoiceBased: () => true,
      });

      await channel.connect();
      const msg = createMessage({
        channelId: '1486805999535783986',
        content: '텍스트로 질문',
        guildName: 'Test Server',
        channelName: 'call',
      });
      await triggerMessage(msg);
      sendMock.mockClear();
      audioPlayerRef.current.play.mockClear();

      await channel.sendMessage('dc:1486805999535783986', '텍스트 답변');

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '텍스트 답변',
        }),
      );
      expect(audioPlayerRef.current.play).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      const fetchedChannel =
        await currentClient().channels.fetch('1234567890123456');
      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Test');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('propagates send failure to the caller', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).rejects.toThrow('Channel not found');
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessage('dc:1234567890123456', 'No client');

      // No error, no API call
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, {
        content: 'x'.repeat(2000),
        files: undefined,
        flags: 1 << 2,
      });
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, {
        content: 'x'.repeat(1000),
        files: undefined,
        flags: 1 << 2,
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();
      currentClient().channels.fetch.mockClear();

      await channel.setTyping('dc:1234567890123456', false);

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('dc:1234567890123456', true);

      // No error
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });
});
