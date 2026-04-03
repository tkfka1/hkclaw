import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { promisify } from 'util';

import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import {
  Attachment,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  TextChannel,
} from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import prism from 'prism-media';

import {
  ASSISTANT_NAME,
  CACHE_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { isPairedRoomJid } from '../db.js';
import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import { formatOutbound } from '../router.js';
import {
  parseDiscordVoiceChannelIds,
  parseDiscordVoiceRouteMap,
} from '../discord-voice-routing.js';
import { hasExplicitTriggerMessage } from '../message-runtime-rules.js';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const TRANSCRIPTION_CACHE_DIR = path.join(CACHE_DIR, 'transcriptions');
const VOICE_TTS_DIR = path.join(CACHE_DIR, 'voice-tts');
const DEFAULT_VOICE_RECONNECT_DELAY_MS = 5000;
const DEFAULT_LIVE_VOICE_SILENCE_MS = 1200;
const DEFAULT_LIVE_VOICE_MIN_PCM_BYTES = 48_000;
const GROQ_TRANSCRIPTION_DEFAULT_MODEL = 'whisper-large-v3';
const OPENAI_TRANSCRIPTION_DEFAULT_MODEL = 'whisper-1';
const EDGE_TTS_DEFAULT_LANG = 'ko-KR';
const EDGE_TTS_DEFAULT_VOICE = 'ko-KR-SunHiNeural';
const EDGE_TTS_DEFAULT_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const EDGE_TTS_DEFAULT_RATE = 'default';
const EDGE_TTS_DEFAULT_TIMEOUT_MS = 30_000;
const EDGE_TTS_DEFAULT_MAX_CHARS = 140;
const EDGE_TTS_RETRY_BACKOFF_MS = 750;
const DISCORD_VOICE_OUTPUT_BITRATE = '48k';
const execFileAsync = promisify(execFile);
const BASE_DISCORD_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.DirectMessages,
] as const;

function getNumberEnv(key: string, fallback: number, min?: number): number {
  const raw = getEnv(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof min === 'number') return Math.max(min, parsed);
  return parsed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNamedMentionMap(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  return Object.fromEntries(
    raw
      .split(/[\r\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.search(/[:=]/);
        if (separatorIndex <= 0) return null;
        const name = entry.slice(0, separatorIndex).trim();
        const id = entry.slice(separatorIndex + 1).trim();
        if (!name || !/^\d{8,21}$/.test(id)) return null;
        return [name, id] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
}

function getVoiceReconnectDelayMs(): number {
  return getNumberEnv(
    'DISCORD_VOICE_RECONNECT_DELAY_MS',
    DEFAULT_VOICE_RECONNECT_DELAY_MS,
    1000,
  );
}

function buildDiscordIntents(includeMessageContent: boolean): number[] {
  return includeMessageContent
    ? [...BASE_DISCORD_INTENTS, GatewayIntentBits.MessageContent]
    : [...BASE_DISCORD_INTENTS];
}

function isDisallowedDiscordIntentError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : error ? String(error) : '';
  return /disallowed intents/i.test(message);
}

function getLiveVoiceSilenceMs(): number {
  return getNumberEnv(
    'DISCORD_LIVE_VOICE_SILENCE_MS',
    DEFAULT_LIVE_VOICE_SILENCE_MS,
    300,
  );
}

function getLiveVoiceMinPcmBytes(): number {
  return getNumberEnv(
    'DISCORD_LIVE_VOICE_MIN_PCM_BYTES',
    DEFAULT_LIVE_VOICE_MIN_PCM_BYTES,
    4096,
  );
}

function getSpeechTimeoutMs(): number {
  const timeoutMs = Number(
    getEnv('DISCORD_EDGE_TTS_TIMEOUT_MS') || EDGE_TTS_DEFAULT_TIMEOUT_MS,
  );
  return Number.isFinite(timeoutMs)
    ? Math.max(5000, timeoutMs)
    : EDGE_TTS_DEFAULT_TIMEOUT_MS;
}

function getSpeechRate(): string {
  return getEnv('DISCORD_EDGE_TTS_RATE')?.trim() || EDGE_TTS_DEFAULT_RATE;
}

interface TranscriptionConfig {
  apiUrl: string;
  apiKey: string;
  provider: 'groq' | 'openai';
  model: string;
  language: string | null;
}

function getTranscriptionConfig(): TranscriptionConfig | null {
  const groqKey = getEnv('GROQ_API_KEY') || '';
  if (groqKey) {
    return {
      apiUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
      apiKey: groqKey,
      provider: 'groq',
      model:
        getEnv('DISCORD_GROQ_TRANSCRIPTION_MODEL') ||
        GROQ_TRANSCRIPTION_DEFAULT_MODEL,
      language: getEnv('DISCORD_TRANSCRIPTION_LANGUAGE')?.trim() || null,
    };
  }

  const openaiKey = getEnv('OPENAI_API_KEY') || '';
  if (openaiKey) {
    return {
      apiUrl: 'https://api.openai.com/v1/audio/transcriptions',
      apiKey: openaiKey,
      provider: 'openai',
      model:
        getEnv('DISCORD_OPENAI_TRANSCRIPTION_MODEL') ||
        OPENAI_TRANSCRIPTION_DEFAULT_MODEL,
      language: getEnv('DISCORD_TRANSCRIPTION_LANGUAGE')?.trim() || null,
    };
  }

  return null;
}

async function synthesizeSpeechWithEdge(
  input: string,
  outputPath: string,
  timeoutMs: number,
): Promise<void> {
  const ffmpegBinary = ffmpegPath as unknown as string | null;
  if (!ffmpegBinary) {
    throw new Error('ffmpeg-static binary not available');
  }

  const voice = getEnv('DISCORD_EDGE_TTS_VOICE') || EDGE_TTS_DEFAULT_VOICE;
  const lang = getEnv('DISCORD_EDGE_TTS_LANG') || EDGE_TTS_DEFAULT_LANG;
  const outputFormat =
    getEnv('DISCORD_EDGE_TTS_OUTPUT_FORMAT') || EDGE_TTS_DEFAULT_OUTPUT_FORMAT;
  const rate = getSpeechRate();
  const proxy = getEnv('HTTPS_PROXY') || getEnv('HTTP_PROXY') || '';
  const sourceExt = outputFormat.includes('mp3') ? '.mp3' : '.audio';
  const sourcePath = path.join(
    VOICE_TTS_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}${sourceExt}`,
  );
  const ttsScript = `
    import { EdgeTTS } from 'node-edge-tts';

    const tts = new EdgeTTS({
      voice: process.env.HKCLAW_TTS_VOICE,
      lang: process.env.HKCLAW_TTS_LANG,
      outputFormat: process.env.HKCLAW_TTS_OUTPUT_FORMAT,
      rate: process.env.HKCLAW_TTS_RATE || 'default',
      proxy: process.env.HKCLAW_TTS_PROXY || undefined,
      timeout: Number(process.env.HKCLAW_TTS_TIMEOUT_MS || '30000'),
    });

    try {
      await tts.ttsPromise(process.env.HKCLAW_TTS_TEXT || '', process.env.HKCLAW_TTS_OUTPUT || '');
      process.stdout.write('ok');
    } catch (err) {
      process.stderr.write(String(err?.stack || err?.message || err));
      process.exit(1);
    }
  `;

  try {
    await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', ttsScript],
      {
        env: {
          ...process.env,
          HKCLAW_TTS_TEXT: input,
          HKCLAW_TTS_OUTPUT: sourcePath,
          HKCLAW_TTS_VOICE: voice,
          HKCLAW_TTS_LANG: lang,
          HKCLAW_TTS_OUTPUT_FORMAT: outputFormat,
          HKCLAW_TTS_RATE: rate,
          HKCLAW_TTS_PROXY: proxy,
          HKCLAW_TTS_TIMEOUT_MS: String(timeoutMs),
        },
        timeout: timeoutMs + 5000,
      },
    );

    await execFileAsync(
      ffmpegBinary,
      [
        '-y',
        '-i',
        sourcePath,
        '-c:a',
        'libopus',
        '-b:a',
        getEnv('DISCORD_VOICE_OUTPUT_BITRATE') || DISCORD_VOICE_OUTPUT_BITRATE,
        outputPath,
      ],
      { timeout: timeoutMs + 5000 },
    );
  } finally {
    fs.rmSync(sourcePath, { force: true });
  }
}

/**
 * Download a Discord image attachment to local disk.
 * Returns the absolute path to the saved file.
 */
async function downloadImage(att: Attachment): Promise<string> {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const ext = path.extname(att.name || 'image.png') || '.png';
  const filename = `${Date.now()}-${att.id}${ext}`;
  const filePath = path.join(ATTACHMENTS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  logger.info({ file: filename, size: buffer.length }, 'Image downloaded');
  return filePath;
}

/**
 * Wait for a pending transcription from the other service (poll cache file).
 * Returns the cached text, or null if timeout.
 */
async function waitForPendingTranscription(
  cacheFile: string,
  timeoutMs = 15000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    if (fs.existsSync(cacheFile)) {
      return fs.readFileSync(cacheFile, 'utf-8');
    }
  }
  return null;
}

/**
 * Transcribe an audio attachment via Groq Whisper (primary) or OpenAI Whisper (fallback).
 * Uses shared file cache so both services don't duplicate API calls.
 */
async function transcribeAudio(att: Attachment): Promise<string> {
  fs.mkdirSync(TRANSCRIPTION_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(TRANSCRIPTION_CACHE_DIR, `${att.id}.txt`);
  const pendingFile = path.join(TRANSCRIPTION_CACHE_DIR, `${att.id}.pending`);

  // Check cache first
  if (fs.existsSync(cacheFile)) {
    logger.info({ attId: att.id }, 'Transcription cache hit');
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  // Another service is already transcribing — wait for result
  if (fs.existsSync(pendingFile)) {
    logger.info({ attId: att.id }, 'Waiting for pending transcription');
    const cached = await waitForPendingTranscription(cacheFile);
    if (cached) return cached;
    // Timeout — fall through and transcribe ourselves
  }

  try {
    // Mark as pending
    fs.writeFileSync(pendingFile, process.pid.toString());

    const start = Date.now();
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = att.name || 'audio.ogg';

    // Pick provider: Groq (fast) > OpenAI (fallback)
    const transcription = getTranscriptionConfig();
    if (!transcription) {
      return `[Audio: ${filename} (no transcription API key)]`;
    }

    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    form.append('model', transcription.model);
    if (transcription.language) {
      form.append('language', transcription.language);
    }

    const whisperRes = await fetch(transcription.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${transcription.apiKey}` },
      body: form,
    });
    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(
        `${transcription.provider} Whisper ${whisperRes.status}: ${errText}`,
      );
    }
    const data = (await whisperRes.json()) as { text: string };
    const elapsed = Date.now() - start;
    const result = `[Voice message transcription]: ${data.text}`;

    // Save to cache for the other service
    fs.writeFileSync(cacheFile, result);
    logger.info(
      {
        file: filename,
        length: data.text.length,
        provider: transcription.provider,
        model: transcription.model,
        language: transcription.language || 'auto',
        elapsed,
      },
      'Audio transcribed + cached',
    );
    return result;
  } catch (err) {
    logger.error({ err, file: att.name }, 'Audio transcription failed');
    return `[Audio: ${att.name || 'audio'} (transcription failed)]`;
  } finally {
    // Clean up pending marker
    try {
      fs.unlinkSync(pendingFile);
    } catch {
      /* ignore */
    }
  }
}

function buildWavFromPcm(args: {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}): Buffer {
  const { pcm, sampleRate, channels, bitsPerSample } = args;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function transcribeLiveVoice(
  filename: string,
  audio: Buffer,
): Promise<string | null> {
  const transcription = getTranscriptionConfig();
  if (!transcription) {
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), filename);
    form.append('model', transcription.model);
    if (transcription.language) {
      form.append('language', transcription.language);
    }

    const res = await fetch(transcription.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${transcription.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `${transcription.provider} live voice ${res.status}: ${errText}`,
      );
    }

    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    return text || null;
  } catch (err) {
    logger.error({ err, file: filename }, 'Live voice transcription failed');
    return null;
  }
}

function normalizeSpeechText(text: string): string {
  return formatOutbound(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSpeechCandidates(text: string): string[] {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return [];

  const maxChars = Number(
    getEnv('DISCORD_EDGE_TTS_MAX_CHARS') || EDGE_TTS_DEFAULT_MAX_CHARS,
  );
  const safeMaxChars =
    Number.isFinite(maxChars) && maxChars > 0
      ? Math.max(40, Math.min(maxChars, 300))
      : EDGE_TTS_DEFAULT_MAX_CHARS;

  const sentences = normalized
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const firstSentence = sentences[0] || normalized;
  const firstClause =
    firstSentence.split(/[,:;，、]/)[0]?.trim() || firstSentence;

  const candidates = [
    normalized.slice(0, safeMaxChars),
    firstSentence.slice(0, safeMaxChars),
    firstClause.slice(0, Math.min(80, safeMaxChars)),
  ]
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  return [...new Set(candidates)];
}

async function synthesizeSpeech(text: string): Promise<string | null> {
  const candidates = buildSpeechCandidates(text);
  if (candidates.length === 0) return null;
  const safeTimeoutMs = getSpeechTimeoutMs();

  fs.mkdirSync(VOICE_TTS_DIR, { recursive: true });
  for (const [index, input] of candidates.entries()) {
    const outputPath = path.join(
      VOICE_TTS_DIR,
      `${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`,
    );
    try {
      await synthesizeSpeechWithEdge(input, outputPath, safeTimeoutMs);
      logger.info(
        { provider: 'edge', attempt: index + 1, length: input.length },
        'Speech synthesis succeeded',
      );
      return outputPath;
    } catch (err) {
      fs.rmSync(outputPath, { force: true });
      logger.warn(
        { err, provider: 'edge', attempt: index + 1, length: input.length },
        'Speech synthesis attempt failed',
      );
    }

    if (index < candidates.length - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, EDGE_TTS_RETRY_BACKOFF_MS),
      );
    }
  }

  logger.error(
    {
      attempts: candidates.map((candidate) => candidate.length),
      provider: 'edge',
    },
    'Speech synthesis failed',
  );
  return null;
}
import { registerChannel, ChannelOpts } from './registry.js';
import {
  AgentType,
  Channel,
  ChannelMeta,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private voiceConnections = new Map<string, VoiceConnection>();
  private voicePlayers = new Map<string, AudioPlayer>();
  private voicePlaybackQueues = new Map<string, Promise<void>>();
  private activeVoiceCaptures = new Set<string>();
  private voiceReconnectTimers = new Map<string, NodeJS.Timeout>();
  private explicitVoiceChannelIds: string[];
  private voiceRouteMap: Map<string, string>;
  private lastInboundModeByJid = new Map<string, 'text' | 'voice'>();
  private isDisconnecting = false;
  private agentTypeFilter?: AgentType;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    agentTypeFilter?: AgentType,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.agentTypeFilter = agentTypeFilter;
    this.explicitVoiceChannelIds = parseDiscordVoiceChannelIds(
      getEnv('DISCORD_VOICE_CHANNEL_IDS') || getEnv('DISCORD_VOICE_CHANNEL_ID'),
    );
    this.voiceRouteMap = parseDiscordVoiceRouteMap({
      voiceChannelIds: this.explicitVoiceChannelIds,
      raw: getEnv('DISCORD_VOICE_ROUTE_MAP'),
      defaultTargetJid:
        getEnv('DISCORD_VOICE_TARGET_JID') ||
        getEnv('DISCORD_VOICE_SESSION_JID'),
    });
    if (agentTypeFilter) {
      this.name = `discord-${agentTypeFilter}`;
    }
  }

  async connect(): Promise<void> {
    this.isDisconnecting = false;
    try {
      await this.connectClient(true);
    } catch (error) {
      if (!isDisallowedDiscordIntentError(error)) {
        throw error;
      }
      logger.warn(
        {
          agentTypeFilter: this.agentTypeFilter || 'all',
        },
        'Discord bot lacks Message Content intent; retrying without it',
      );
      this.destroyClient(false);
      this.isDisconnecting = false;
      await this.connectClient(false);
    }
  }

  private async connectClient(includeMessageContent: boolean): Promise<void> {
    this.client = new Client({
      intents: buildDiscordIntents(includeMessageContent),
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      const isOwnBotMessage = message.author.id === this.client?.user?.id;
      if (isOwnBotMessage) return;

      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Normalize Discord mentions inline so every bot stores the same content.
      // This avoids per-service races where one service expands its own mention
      // and another overwrites the row with raw <@id> text.
      if (message.mentions?.users?.size) {
        for (const [mentionedUserId, mentionedUser] of message.mentions.users) {
          const mentionLabel =
            mentionedUser.displayName || mentionedUser.username;
          if (!mentionLabel) continue;
          content = content.replace(
            new RegExp(`<@!?${mentionedUserId}>`, 'g'),
            `@${mentionLabel}`,
          );
        }
      }

      // Handle attachments — transcribe audio, placeholder for others
      if (message.attachments.size > 0) {
        const attachmentDescriptions = await Promise.all(
          [...message.attachments.values()].map(async (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('audio/')) {
              return transcribeAudio(att);
            } else if (contentType.startsWith('image/')) {
              try {
                const imgPath = await downloadImage(att);
                return `[Image: ${imgPath}]`;
              } catch (err) {
                logger.error({ err, file: att.name }, 'Image download failed');
                return `[Image: ${att.name || 'image'} (download failed)]`;
              }
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else if (
              contentType.startsWith('text/') ||
              /\.(txt|md|json|csv|log|xml|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|py|js|ts|jsx|tsx|html|css|sql|rs|go|java|c|cpp|h|hpp|rb|php|swift|kt|scala|r|lua|pl|ex|exs|hs|ml|clj|dart|v|zig|nim|ps1|bat|cmd|mjs|cjs)$/i.test(
                att.name || '',
              )
            ) {
              // Download and inline text-based files
              try {
                const res = await fetch(att.url);
                if (!res.ok) throw new Error(`Download failed: ${res.status}`);
                let text = await res.text();
                // Truncate very large files
                const MAX_TEXT_LENGTH = 32_000;
                if (text.length > MAX_TEXT_LENGTH) {
                  text =
                    text.slice(0, MAX_TEXT_LENGTH) +
                    `\n...(truncated, ${text.length} chars total)`;
                }
                return `[File: ${att.name}]\n${text}`;
              } catch (err) {
                logger.error(
                  { err, file: att.name },
                  'Text file download failed',
                );
                return `[File: ${att.name || 'file'} (download failed)]`;
              }
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          }),
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups matching our agent type
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }
      if (
        this.agentTypeFilter &&
        (group.agentType || 'claude-code') !== this.agentTypeFilter
      ) {
        return; // This JID belongs to a different agent type's bot
      }
      if (
        message.author.bot &&
        !isPairedRoomJid(chatJid) &&
        !hasExplicitTriggerMessage(
          {
            id: msgId,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: true,
          },
          group,
          TRIGGER_PATTERN,
        )
      ) {
        return;
      }

      this.lastInboundModeByJid.set(chatJid, 'text');

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: message.author.bot ?? false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        void this.joinConfiguredVoiceChannels();
        settleResolve();
      });

      this.client!.login(this.botToken).catch(settleReject);
    });
  }

  private async joinConfiguredVoiceChannels(): Promise<void> {
    const voiceChannelIds = this.getManagedVoiceChannelIds();
    if (voiceChannelIds.length === 0) return;

    await Promise.all(
      voiceChannelIds.map(async (channelId) => {
        try {
          await this.joinVoiceChannelById(channelId, {
            warnOnNonVoice: this.explicitVoiceChannelIds.includes(channelId),
          });
        } catch (err) {
          logger.error(
            { channelId, err },
            'Failed to auto-join configured Discord voice channel',
          );
          this.scheduleVoiceReconnect(channelId);
        }
      }),
    );
  }

  private clearVoiceReconnect(channelId: string): void {
    const timer = this.voiceReconnectTimers.get(channelId);
    if (!timer) return;
    clearTimeout(timer);
    this.voiceReconnectTimers.delete(channelId);
  }

  private scheduleVoiceReconnect(channelId: string): void {
    if (this.isDisconnecting) return;
    if (!this.getManagedVoiceChannelIds().includes(channelId)) return;
    this.clearVoiceReconnect(channelId);
    this.voiceReconnectTimers.set(
      channelId,
      setTimeout(() => {
        this.voiceReconnectTimers.delete(channelId);
        if (!this.isDisconnecting) {
          void this.joinVoiceChannelById(channelId).catch((err) => {
            logger.error(
              { channelId, err },
              'Retrying Discord voice auto-join failed',
            );
            this.scheduleVoiceReconnect(channelId);
          });
        }
      }, getVoiceReconnectDelayMs()),
    );
  }

  private bindVoiceConnection(
    channelId: string,
    connection: VoiceConnection,
  ): void {
    this.voiceConnections.get(channelId)?.removeAllListeners();
    this.voiceConnections.get(channelId)?.destroy();
    this.voiceConnections.set(channelId, connection);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);
    this.voicePlayers.set(channelId, player);
    player.on('error', (err) => {
      logger.error({ channelId, err }, 'Discord voice player error');
    });

    connection.receiver.speaking.on('start', (userId) => {
      void this.handleLiveVoiceStart(channelId, connection, userId);
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      this.clearVoiceReconnect(channelId);
      logger.info({ channelId }, 'Discord voice connection ready');
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      logger.warn({ channelId }, 'Discord voice connection disconnected');
      if (!this.isDisconnecting) {
        try {
          connection.destroy();
        } catch {
          /* ignore */
        }
        this.voiceConnections.delete(channelId);
        this.scheduleVoiceReconnect(channelId);
      }
    });

    connection.on('error', (err) => {
      logger.error({ channelId, err }, 'Discord voice connection error');
      this.scheduleVoiceReconnect(channelId);
    });
  }

  private async resolveVoiceSenderName(
    channelId: string,
    userId: string,
  ): Promise<string> {
    if (!this.client) return userId;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('guild' in channel)) return userId;
      const member = await channel.guild.members.fetch(userId);
      return (
        member.displayName || member.user.displayName || member.user.username
      );
    } catch {
      return userId;
    }
  }

  private async handleLiveVoiceStart(
    channelId: string,
    connection: VoiceConnection,
    userId: string,
  ): Promise<void> {
    if (!this.client || userId === this.client.user?.id) return;

    const chatJid = `dc:${channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    const captureKey = `${channelId}:${userId}`;
    if (this.activeVoiceCaptures.has(captureKey)) return;
    this.activeVoiceCaptures.add(captureKey);
    logger.info(
      { channelId, userId, chatJid },
      'Discord live voice capture started',
    );

    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: getLiveVoiceSilenceMs(),
      },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    const pcmChunks: Buffer[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        opusStream.on('error', reject);
        decoder.on('error', reject);
        decoder.on('data', (chunk: Buffer) => {
          pcmChunks.push(Buffer.from(chunk));
        });
        decoder.on('end', resolve);
        opusStream.pipe(decoder);
      });

      const pcm = Buffer.concat(pcmChunks);
      logger.info(
        {
          channelId,
          userId,
          pcmBytes: pcm.length,
          minPcmBytes: getLiveVoiceMinPcmBytes(),
        },
        'Discord live voice capture completed',
      );
      if (pcm.length < getLiveVoiceMinPcmBytes()) {
        logger.warn(
          {
            channelId,
            userId,
            pcmBytes: pcm.length,
            minPcmBytes: getLiveVoiceMinPcmBytes(),
          },
          'Discarding live voice capture below minimum size',
        );
        return;
      }

      const wav = buildWavFromPcm({
        pcm,
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 16,
      });
      const transcriptRaw = await transcribeLiveVoice(
        `discord-live-${channelId}-${userId}.wav`,
        wav,
      );
      if (!transcriptRaw) {
        logger.warn(
          { channelId, userId },
          'Live voice transcription returned empty',
        );
        return;
      }

      const senderName = await this.resolveVoiceSenderName(channelId, userId);
      const transcript = transcriptRaw.trim();
      logger.info(
        { channelId, userId, senderName, transcriptLength: transcript.length },
        'Live voice transcription completed',
      );
      const content = TRIGGER_PATTERN.test(transcript)
        ? transcript
        : `@${ASSISTANT_NAME} ${transcript}`;
      const timestamp = new Date().toISOString();

      this.opts.onChatMetadata(chatJid, timestamp, group.name, 'discord', true);
      this.opts.onMessage(chatJid, {
        id: `voice:${channelId}:${userId}:${Date.now()}`,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      this.lastInboundModeByJid.set(chatJid, 'voice');

      const mirrorJid = this.resolveVoiceTextTargetJid(chatJid);
      if (mirrorJid) {
        await this.sendTextOnlyMessage(
          mirrorJid,
          `**${senderName}**: ${transcript}`,
          { recordOutbound: mirrorJid !== chatJid },
        );
        logger.info(
          { channelId, userId, mirrorJid, transcriptLength: transcript.length },
          'Mirrored live voice transcript to text chat',
        );
      }
    } catch (err) {
      logger.error({ channelId, userId, err }, 'Live voice receive failed');
    } finally {
      this.activeVoiceCaptures.delete(captureKey);
      opusStream.destroy();
      decoder.destroy();
    }
  }

  private async playVoiceReply(
    channelId: string,
    text: string,
  ): Promise<boolean> {
    const player = this.voicePlayers.get(channelId);
    if (!player) return false;

    const audioPath = await synthesizeSpeech(text);
    if (!audioPath) return false;

    const previous =
      this.voicePlaybackQueues.get(channelId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const audio = fs.readFileSync(audioPath);
          const resource = createAudioResource(Readable.from(audio), {
            inputType: StreamType.OggOpus,
          });
          player.play(resource);
          await entersState(player, AudioPlayerStatus.Playing, 10_000);
          await entersState(player, AudioPlayerStatus.Idle, 120_000);
        } finally {
          fs.rmSync(audioPath, { force: true });
        }
      });

    this.voicePlaybackQueues.set(
      channelId,
      next.catch(() => undefined).then(() => undefined),
    );
    await next;
    return true;
  }

  private resolveVoiceTextTargetJid(voiceJid: string): string | null {
    const mapped = this.voiceRouteMap.get(voiceJid);
    if (mapped) return mapped;
    return this.opts.registeredGroups()[voiceJid] ? voiceJid : null;
  }

  private getManagedVoiceChannelIds(): string[] {
    const result = new Set(this.explicitVoiceChannelIds);
    for (const [jid, group] of Object.entries(this.opts.registeredGroups())) {
      if (!jid.startsWith('dc:')) continue;
      if (!this.isManagedGroupForVoice(group)) continue;
      result.add(jid.replace(/^dc:/, ''));
    }
    return [...result];
  }

  private isManagedGroupForVoice(group: RegisteredGroup | undefined): boolean {
    if (!group) return false;
    const groupType = group.agentType || 'claude-code';
    return !this.agentTypeFilter || groupType === this.agentTypeFilter;
  }

  private async sendTextOnlyMessage(
    jid: string,
    text: string,
    options?: { recordOutbound?: boolean },
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.client.channels.fetch(channelId);

    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Discord channel not found or not text-based');
      return;
    }

    const textChannel = channel as TextChannel;

    // Extract image attachments from markdown links with image extensions
    // e.g. [name.png](/absolute/path/name.png)
    const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
    const MD_LINK_RE = /\[[^\]]*\]\((\/[^)]+)\)/g;
    const imageFiles: string[] = [];
    const seen = new Set<string>();
    let match;

    while ((match = MD_LINK_RE.exec(text)) !== null) {
      const imgPath = match[1].trim();
      if (
        !seen.has(imgPath) &&
        IMAGE_EXTS.test(imgPath) &&
        fs.existsSync(imgPath)
      ) {
        imageFiles.push(imgPath);
        seen.add(imgPath);
      }
    }
    let cleaned = text
      .replace(MD_LINK_RE, (full, p) => {
        const trimmed = p.trim();
        // Image links: remove entirely (attached as files)
        if (IMAGE_EXTS.test(trimmed) && seen.has(trimmed)) return '';
        // Non-image local path links: convert to readable filename
        const basename = path.basename(trimmed.replace(/#.*$/, ''));
        const lineMatch = trimmed.match(/#L(\d+)/);
        return lineMatch
          ? `\`${basename}:${lineMatch[1]}\``
          : `\`${basename}\``;
      })
      .replace(/^[ \t]*[•\-\*][ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const mentionMap = parseNamedMentionMap(
      getEnv('DISCORD_NAMED_MENTIONS') || '',
    );
    for (const [name, id] of Object.entries(mentionMap)) {
      cleaned = cleaned.replace(
        new RegExp(`@${escapeRegExp(name)}`, 'g'),
        `<@${id}>`,
      );
    }
    cleaned = formatOutbound(cleaned);

    const MAX_LENGTH = 2000;
    const MAX_ATTACHMENTS = 10;
    const files = imageFiles.map((f) => ({
      attachment: f,
      name: path.basename(f),
    }));

    if (!cleaned && files.length === 0) {
      logger.debug({ jid }, 'Skipping empty Discord outbound message');
      return;
    }

    const fileBatches: (typeof files)[] = [];
    for (let i = 0; i < files.length; i += MAX_ATTACHMENTS) {
      fileBatches.push(files.slice(i, i + MAX_ATTACHMENTS));
    }

    if (cleaned.length <= MAX_LENGTH) {
      await textChannel.send({
        content: cleaned || undefined,
        files: fileBatches[0]?.length ? fileBatches[0] : undefined,
        flags: MessageFlags.SuppressEmbeds,
      });
      for (let b = 1; b < fileBatches.length; b++) {
        await textChannel.send({
          files: fileBatches[b],
          flags: MessageFlags.SuppressEmbeds,
        });
      }
    } else {
      let fileBatchIndex = 0;
      for (let i = 0; i < cleaned.length; i += MAX_LENGTH) {
        const chunk = cleaned.slice(i, i + MAX_LENGTH);
        const batch = fileBatches[fileBatchIndex];
        await textChannel.send({
          content: chunk,
          files: batch?.length ? batch : undefined,
          flags: MessageFlags.SuppressEmbeds,
        });
        if (batch?.length) fileBatchIndex++;
      }
      for (let b = fileBatchIndex; b < fileBatches.length; b++) {
        await textChannel.send({
          files: fileBatches[b],
          flags: MessageFlags.SuppressEmbeds,
        });
      }
    }
    logger.info(
      { jid, length: cleaned.length, files: files.length },
      'Discord text-only message sent',
    );
    if (cleaned && options?.recordOutbound !== false) {
      this.recordOutboundTextMessage(jid, cleaned);
    }
  }

  private recordOutboundTextMessage(jid: string, text: string): void {
    const senderId = this.client?.user?.id || 'discord-bot';
    const senderName =
      this.client?.user?.displayName ||
      this.client?.user?.username ||
      ASSISTANT_NAME;
    this.opts.onMessage(jid, {
      id: `discord-out:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
  }

  private async joinVoiceChannelById(
    channelId: string,
    options?: { warnOnNonVoice?: boolean },
  ): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(channelId);
    const isVoiceBased =
      !!channel &&
      typeof (channel as { isVoiceBased?: unknown }).isVoiceBased ===
        'function' &&
      channel.isVoiceBased();
    if (!channel || !isVoiceBased || !('guild' in channel)) {
      if (options?.warnOnNonVoice) {
        logger.warn(
          { channelId },
          'Configured Discord voice channel was not found or is not voice-based',
        );
      } else {
        logger.debug(
          { channelId },
          'Skipping Discord group for voice auto-join because it is not voice-based',
        );
      }
      return;
    }

    const existing = this.voiceConnections.get(channelId);
    if (existing && existing.joinConfig.channelId === channelId) {
      return;
    }

    this.opts.onChatMetadata(
      `dc:${channel.id}`,
      new Date().toISOString(),
      `${channel.guild.name} #${channel.name}`,
      'discord',
      true,
    );

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      group: this.name,
    });

    this.bindVoiceConnection(channelId, connection);
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    logger.info(
      { channelId, guildId: channel.guild.id, channelName: channel.name },
      'Joined Discord voice channel',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const mirroredTextJid = this.resolveVoiceTextTargetJid(jid);
      if (this.voiceConnections.has(channelId)) {
        const inboundMode = this.lastInboundModeByJid.get(jid);
        if (mirroredTextJid === jid) {
          if (inboundMode === 'voice') {
            await this.sendTextOnlyMessage(jid, text);
            const spoke = await this.playVoiceReply(channelId, text).catch(
              () => false,
            );
            if (spoke) {
              logger.info(
                { jid, length: text.length },
                'Discord text message sent and voice reply played for unified call room',
              );
              return;
            }
            logger.warn(
              { jid, length: text.length },
              'Discord text-only reply sent for unified call room because voice playback failed',
            );
            return;
          }
          if (inboundMode === 'text') {
            await this.sendTextOnlyMessage(jid, text);
            logger.info(
              { jid, length: text.length },
              'Discord text-only reply sent for unified call room',
            );
            return;
          }
        }
        if (mirroredTextJid) {
          await this.sendTextOnlyMessage(mirroredTextJid, text);
          const spoke = await this.playVoiceReply(channelId, text).catch(
            () => false,
          );
          if (spoke) {
            logger.info(
              { jid, mirroredTextJid, length: text.length },
              'Discord text reply sent and voice reply played',
            );
          } else {
            await this.sendTextOnlyMessage(
              mirroredTextJid,
              '_음성 응답 생성에 실패해 텍스트로만 답변했습니다._',
            );
            logger.warn(
              { jid, mirroredTextJid, length: text.length },
              'Discord text reply sent but voice reply failed',
            );
          }
          return;
        }
        const spoke = await this.playVoiceReply(channelId, text).catch(
          () => false,
        );
        if (spoke) {
          logger.info(
            { jid, length: text.length },
            'Discord voice reply played',
          );
          return;
        }
      }
      await this.sendTextOnlyMessage(mirroredTextJid || jid, text);
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  isOwnMessage(msg: NewMessage): boolean {
    return !!msg.is_bot_message && msg.sender === this.client?.user?.id;
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;
    if (!this.agentTypeFilter) return true;
    const group = this.opts.registeredGroups()[jid];
    if (!group) return false;
    const groupType = group.agentType || 'claude-code';
    return groupType === this.agentTypeFilter;
  }

  getConnectedVoiceJids(): string[] {
    return [...this.voiceConnections.keys()].map(
      (channelId) => `dc:${channelId}`,
    );
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    for (const timer of this.voiceReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.voiceReconnectTimers.clear();
    for (const connection of this.voiceConnections.values()) {
      connection.removeAllListeners();
      connection.destroy();
    }
    this.voiceConnections.clear();
    for (const player of this.voicePlayers.values()) {
      player.stop();
    }
    this.voicePlayers.clear();
    this.voicePlaybackQueues.clear();
    this.activeVoiceCaptures.clear();
    this.lastInboundModeByJid.clear();
    this.destroyClient(true);
  }

  private destroyClient(logStop: boolean): void {
    if (!this.client) return;
    this.client.destroy();
    this.client = null;
    if (logStop) {
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    // Clear any existing interval for this channel
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const sendOnce = async () => {
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    // Send immediately, then refresh every 8 seconds (Discord expires at ~10s)
    await sendOnce();
    this.typingIntervals.set(jid, setInterval(sendOnce, 8000));
  }

  async sendAndTrack(jid: string, text: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return null;
      const msg = await (channel as TextChannel).send(text);
      return msg.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send tracked Discord message');
      throw err;
    }
  }

  async getChannelMeta(jids: string[]): Promise<Map<string, ChannelMeta>> {
    const result = new Map<string, ChannelMeta>();
    if (!this.client) return result;

    const dcJids = jids.filter((j) => j.startsWith('dc:'));
    if (dcJids.length === 0) return result;

    const channelIdToJid = new Map<string, string>();
    for (const jid of dcJids) {
      channelIdToJid.set(jid.replace(/^dc:/, ''), jid);
    }

    try {
      // Fetch one channel to discover its guild, then batch-fetch all channels
      const firstId = dcJids[0].replace(/^dc:/, '');
      const firstChannel = await this.client.channels.fetch(firstId);
      if (!firstChannel || !('guild' in firstChannel)) return result;

      const guild = (firstChannel as TextChannel).guild;
      const allChannels = await guild.channels.fetch();

      for (const [id, channel] of allChannels) {
        const jid = channelIdToJid.get(id);
        if (!jid || !channel) continue;
        result.set(jid, {
          name: channel.name,
          position: channel.position,
          category: channel.parent?.name || '',
          categoryPosition: channel.parent?.position ?? 999,
        });
      }
    } catch {
      // Fallback: individual fetches
      for (const jid of dcJids) {
        try {
          const channelId = jid.replace(/^dc:/, '');
          const channel = await this.client.channels.fetch(channelId);
          if (channel && 'position' in channel) {
            const tc = channel as TextChannel;
            result.set(jid, {
              name: tc.name,
              position: tc.position,
              category: tc.parent?.name || '',
              categoryPosition: tc.parent?.position ?? 999,
            });
          }
        } catch {
          /* skip inaccessible channels */
        }
      }
    }

    return result;
  }

  async purgeChannel(jid: string): Promise<number> {
    if (!this.client) return 0;
    let deleted = 0;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('bulkDelete' in channel)) return 0;
      const tc = channel as TextChannel;

      // Fetch and delete in batches (bulkDelete handles up to 100, only < 14 days old)
      let hasMore = true;
      while (hasMore) {
        const messages = await tc.messages.fetch({ limit: 100 });
        if (messages.size === 0) break;

        // Separate into bulk-deletable (< 14 days) and old messages
        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const recent = messages.filter((m) => m.createdTimestamp > twoWeeksAgo);
        const old = messages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

        if (recent.size >= 2) {
          await tc.bulkDelete(recent);
          deleted += recent.size;
        } else if (recent.size === 1) {
          await recent.first()!.delete();
          deleted += 1;
        }

        for (const [, msg] of old) {
          await msg.delete();
          deleted += 1;
        }

        hasMore = messages.size === 100;
      }

      logger.info({ jid, deleted }, 'Purged channel messages');
    } catch (err) {
      logger.error({ jid, err, deleted }, 'Failed to purge channel messages');
    }
    return deleted;
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.edit(text);
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit Discord message');
      throw err; // Re-throw so callers (e.g. dashboard) can reset message ID
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const token = getEnv('DISCORD_BOT_TOKEN') || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  // If a second Codex bot token exists, this instance only handles claude-code groups
  const hasCodexBot = !!getEnv('DISCORD_CODEX_BOT_TOKEN');
  return new DiscordChannel(
    token,
    opts,
    hasCodexBot ? 'claude-code' : undefined,
  );
});

// Only register the secondary Codex bot channel when running as the primary (claude-code) service.
// The codex service uses its own DISCORD_BOT_TOKEN via systemd EnvironmentFile override.
if ((process.env.ASSISTANT_NAME || 'claude') !== 'codex') {
  registerChannel('discord-codex', (opts: ChannelOpts) => {
    const token = getEnv('DISCORD_CODEX_BOT_TOKEN') || '';
    if (!token) return null; // Codex Discord bot is optional
    return new DiscordChannel(token, opts, 'codex');
  });
}
