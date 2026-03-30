import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// ── Internal cache ──────────────────────────────────────────────

let _cache: Record<string, string> | null = null;
let _serviceCache:
  | {
      envFile: string;
      mtimeMs: number;
      values: Record<string, string>;
    }
  | null = null;

export const SERVICE_SCOPED_ENV_KEYS = [
  'ASSISTANT_NAME',
  'SERVICE_ID',
  'SERVICE_AGENT_TYPE',
  'SERVICE_ROLE',
  'SERVICE_USAGE',
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
  'CODEX_MODEL',
  'CODEX_EFFORT',
  'CODEX_USE_HOME_AUTH',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'FALLBACK_ENABLED',
  'FALLBACK_PROVIDER_NAME',
  'FALLBACK_BASE_URL',
  'FALLBACK_AUTH_TOKEN',
  'FALLBACK_MODEL',
  'FALLBACK_SMALL_MODEL',
  'FALLBACK_COOLDOWN_MS',
] as const;

const SERVICE_SCOPED_ENV_KEY_SET = new Set<string>(SERVICE_SCOPED_ENV_KEYS);

function hasOwn(
  record: Record<string, string> | NodeJS.ProcessEnv,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function getCurrentServiceEnvPath(): string | null {
  const configured = process.env.HKCLAW_SERVICE_ENV_PATH?.trim();
  if (!configured) return null;
  const envFile = path.resolve(configured);
  return fs.existsSync(envFile) ? envFile : null;
}

function parseCurrentServiceEnv(): Record<string, string> | null {
  const envFile = getCurrentServiceEnvPath();
  if (!envFile) {
    _serviceCache = null;
    return null;
  }

  const mtimeMs = fs.statSync(envFile).mtimeMs;
  if (
    _serviceCache &&
    _serviceCache.envFile === envFile &&
    _serviceCache.mtimeMs === mtimeMs
  ) {
    return _serviceCache.values;
  }

  const values = parseEnvFilePath(envFile);
  _serviceCache = {
    envFile,
    mtimeMs,
    values,
  };
  return values;
}

/** Parse the entire .env file into a Record (no key filtering). */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function parseEnvFilePath(envFile: string): Record<string, string> {
  try {
    return parseEnvContent(fs.readFileSync(envFile, 'utf-8'));
  } catch (err) {
    logger.debug({ err, envFile }, 'Env file not found, using defaults');
    return {};
  }
}

/** Parse the entire .env file into a Record (no key filtering). */
function parseEnvFile(): Record<string, string> {
  return parseEnvFilePath(path.join(process.cwd(), '.env'));
}

// ── Public API ──────────────────────────────────────────────────

/** Load (or reload) the .env file into the in-memory cache. */
export function loadEnvFile(): void {
  _cache = parseEnvFile();
  _serviceCache = null;
}

/**
 * Look up a single env value.
 * Priority: process.env > .env cache > undefined
 */
export function getEnv(key: string): string | undefined {
  if (!_cache) loadEnvFile();
  const serviceEnv = parseCurrentServiceEnv();
  if (serviceEnv && SERVICE_SCOPED_ENV_KEY_SET.has(key)) {
    return hasOwn(serviceEnv, key) ? serviceEnv[key] : undefined;
  }
  if (hasOwn(process.env, key)) return process.env[key];
  return hasOwn(_cache!, key) ? _cache![key] : undefined;
}

/**
 * Look up a boolean env value.
 * Empty / unset values fall back to the provided default.
 */
export function getBooleanEnv(
  key: string,
  defaultValue?: boolean,
): boolean | undefined {
  const value = getEnv(key);
  if (value === undefined || value === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
}

/** Force-reload the .env file (e.g. after token refresh writes new values). */
export function reloadEnvFile(): void {
  _cache = null;
  _serviceCache = null;
  loadEnvFile();
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Now backed by the in-memory cache (disk read happens at most once).
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  if (!_cache) loadEnvFile();

  const result: Record<string, string> = {};
  const wanted = new Set(keys);
  for (const [key, value] of Object.entries(_cache!)) {
    if (wanted.has(key)) result[key] = value;
  }
  return result;
}

export function readServiceEnvFile(keys: string[]): Record<string, string> {
  if (!_cache) loadEnvFile();

  const serviceEnv = parseCurrentServiceEnv();
  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const key of wanted) {
    if (serviceEnv && hasOwn(serviceEnv, key)) {
      result[key] = serviceEnv[key];
      continue;
    }
    if (serviceEnv && SERVICE_SCOPED_ENV_KEY_SET.has(key)) {
      continue;
    }
    if (hasOwn(_cache!, key)) {
      result[key] = _cache![key];
    }
  }

  return result;
}
