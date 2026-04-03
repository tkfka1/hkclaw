import os from 'os';
import path from 'path';

import type { AgentType, ServiceRole } from './types.js';
import { getBooleanEnv, getEnv } from './env.js';
import { parseDiscordChannelId } from './discord-channel-id.js';
import {
  normalizeServiceId,
  parseAgentType,
  parseServiceRole,
} from './service-metadata.js';

export const ASSISTANT_NAME = getEnv('ASSISTANT_NAME') || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  getBooleanEnv('ASSISTANT_HAS_OWN_NUMBER', false) ?? false;
const rawServiceAgentType = getEnv('SERVICE_AGENT_TYPE');
export const SERVICE_ID = normalizeServiceId(
  getEnv('SERVICE_ID'),
  ASSISTANT_NAME,
);
export const SERVICE_AGENT_TYPE: AgentType = parseAgentType(
  rawServiceAgentType,
  ASSISTANT_NAME,
);
export const SERVICE_ROLE: ServiceRole = parseServiceRole(
  getEnv('SERVICE_ROLE') || getEnv('SERVICE_USAGE'),
  'normal',
);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'hkclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(
  process.env.HKCLAW_STORE_DIR || path.join(PROJECT_ROOT, 'store'),
);
export const GROUPS_DIR = path.resolve(
  process.env.HKCLAW_GROUPS_DIR || path.join(PROJECT_ROOT, 'groups'),
);
export const DATA_DIR = path.resolve(
  process.env.HKCLAW_DATA_DIR || path.join(PROJECT_ROOT, 'data'),
);
// Shared cache directory (same across both services for dedup)
export const CACHE_DIR = path.join(PROJECT_ROOT, 'cache');

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep agent alive after last result
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AGENTS || '5', 10) || 5,
);
export const RECOVERY_CONCURRENT_AGENTS = parseInt(
  getEnv('RECOVERY_CONCURRENT_AGENTS') || '3',
  10,
);
export const RECOVERY_STAGGER_MS = parseInt(
  getEnv('RECOVERY_STAGGER_MS') || '2000',
  10,
);
export const RECOVERY_DURATION_MS = parseInt(
  getEnv('RECOVERY_DURATION_MS') || '60000',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(assistantName: string): RegExp {
  const escapedAssistantName = escapeRegex(assistantName.trim());
  return new RegExp(`^@${escapedAssistantName}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
}

export const TRIGGER_PATTERN = buildTriggerPattern(ASSISTANT_NAME);

// Status dashboard: Discord channel ID for live agent status updates
export const STATUS_CHANNEL_ID =
  parseDiscordChannelId(getEnv('STATUS_CHANNEL_ID')) || '';
export const STATUS_UPDATE_INTERVAL = 10000; // 10s
export const USAGE_UPDATE_INTERVAL = 300000; // 5 minutes
export const STATUS_SHOW_ROOMS =
  getBooleanEnv('STATUS_SHOW_ROOMS', true) ?? true;
export const STATUS_SHOW_ROOM_DETAILS =
  getBooleanEnv('STATUS_SHOW_ROOM_DETAILS', true) ?? true;
export const USAGE_DASHBOARD_ENABLED =
  getBooleanEnv('USAGE_DASHBOARD', false) ?? false;
const parsedAdminPort = parseInt(
  getEnv('HKCLAW_ADMIN_PORT') || getEnv('ADMIN_WEB_PORT') || '4622',
  10,
);
export const ADMIN_WEB_HOST =
  getEnv('HKCLAW_ADMIN_HOST') || getEnv('ADMIN_WEB_HOST') || '0.0.0.0';
export const ADMIN_WEB_PORT =
  Number.isFinite(parsedAdminPort) && parsedAdminPort > 0
    ? parsedAdminPort
    : 4622;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const rawSessionCommandAllowedSenders =
  getEnv('SESSION_COMMAND_ALLOWED_SENDERS') ||
  getEnv('SESSION_COMMAND_USER_IDS') ||
  '';

const SESSION_COMMAND_ALLOWED_SENDERS = new Set(
  rawSessionCommandAllowedSenders
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

export function isSessionCommandSenderAllowed(sender: string): boolean {
  return SESSION_COMMAND_ALLOWED_SENDERS.has(sender);
}
