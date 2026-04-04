import fs from 'fs';
import path from 'path';

import { parseDiscordChannelId } from './discord-channel-id.js';
import { SERVICE_SCOPED_ENV_KEYS, parseEnvFilePath } from './env.js';
import type { DiscoveredService } from './service-discovery.js';
import type { AgentType, ServiceRole } from './types.js';

const SERVICE_SCOPED_ENV_KEY_SET = new Set<string>(SERVICE_SCOPED_ENV_KEYS);

export interface ServiceHealthConfigSummary {
  statusChannelId: string;
  botTokenConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  anthropicAuthTokenConfigured: boolean;
  claudeCodeOauthTokenConfigured: boolean;
  claudeCodeOauthTokensConfigured: boolean;
  codexAuthJsonConfigured: boolean;
  codexUseHomeAuth: boolean;
  geminiApiKeyConfigured: boolean;
  geminiCliPath: string;
  geminiModel: string;
  localLlmBaseUrl: string;
  localLlmModel: string;
  localLlmApiKeyConfigured: boolean;
}

export interface ServiceHealthRuntimeSummary {
  manager: 'systemd-user' | 'systemd-system' | 'launchd' | 'none';
  activeState: string;
  subState: string;
  running: boolean;
  mainPid: number | null;
  error?: string;
}

export interface ServiceDiagnostic {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export function stripServiceScopedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !SERVICE_SCOPED_ENV_KEY_SET.has(entry[0]),
    ),
  );
}

export function buildManagedServiceEnv(
  baseEnv: Record<string, string>,
  overlayEnv: Record<string, string>,
  extraEnv: Record<string, string>,
  allowBaseScopedEnv = false,
  processEnvOverride: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    ...stripServiceScopedEnv(processEnvOverride),
    ...(allowBaseScopedEnv ? baseEnv : stripServiceScopedEnv(baseEnv)),
    ...overlayEnv,
    ...extraEnv,
  };
}

export function buildEffectiveServiceEnv(
  projectRoot: string,
  service: DiscoveredService,
  baseEnvOverride?: Record<string, string>,
): Record<string, string> {
  const baseEnv = baseEnvOverride || parseEnvFilePath(path.join(projectRoot, '.env'));
  const overlayEnv = service.envOverlayPath
    ? parseEnvFilePath(service.envOverlayPath)
    : {};
  return buildManagedServiceEnv(
    baseEnv,
    overlayEnv,
    service.extraEnv,
    !service.envOverlayPath,
  );
}

export function summarizeServiceHealthConfig(
  effectiveEnv: Record<string, string>,
): ServiceHealthConfigSummary {
  return {
    statusChannelId: parseDiscordChannelId(effectiveEnv.STATUS_CHANNEL_ID) || '',
    botTokenConfigured: Boolean(effectiveEnv.DISCORD_BOT_TOKEN),
    anthropicApiKeyConfigured: Boolean(effectiveEnv.ANTHROPIC_API_KEY),
    anthropicAuthTokenConfigured: Boolean(effectiveEnv.ANTHROPIC_AUTH_TOKEN),
    claudeCodeOauthTokenConfigured: Boolean(effectiveEnv.CLAUDE_CODE_OAUTH_TOKEN),
    claudeCodeOauthTokensConfigured: Boolean(
      effectiveEnv.CLAUDE_CODE_OAUTH_TOKENS,
    ),
    codexAuthJsonConfigured: Boolean(effectiveEnv.CODEX_AUTH_JSON_B64),
    codexUseHomeAuth:
      (effectiveEnv.CODEX_USE_HOME_AUTH || '').trim().toLowerCase() === 'true',
    geminiApiKeyConfigured: Boolean(effectiveEnv.GEMINI_API_KEY),
    geminiCliPath: effectiveEnv.GEMINI_CLI_PATH || '',
    geminiModel: effectiveEnv.GEMINI_MODEL || '',
    localLlmBaseUrl: effectiveEnv.LOCAL_LLM_BASE_URL || '',
    localLlmModel: effectiveEnv.LOCAL_LLM_MODEL || '',
    localLlmApiKeyConfigured: Boolean(effectiveEnv.LOCAL_LLM_API_KEY),
  };
}

export function diagnoseServiceHealth(input: {
  serviceId: string;
  serviceName: string;
  assistantName: string;
  agentType: AgentType;
  role: ServiceRole;
  envPath: string;
  config: ServiceHealthConfigSummary;
  runtime?: ServiceHealthRuntimeSummary;
  snapshotStale?: boolean;
  assignmentCount?: number;
}): ServiceDiagnostic[] {
  const diagnostics: ServiceDiagnostic[] = [];

  if (!fs.existsSync(input.envPath)) {
    diagnostics.push({
      level: 'error',
      code: 'env-path-missing',
      message: `Configured env file is missing: ${input.envPath}`,
    });
  }

  if (input.role === 'dashboard' && !input.config.statusChannelId) {
    diagnostics.push({
      level: 'error',
      code: 'status-channel-missing',
      message: 'Dashboard service requires STATUS_CHANNEL_ID.',
    });
  }

  if (input.role === 'normal' && !input.config.botTokenConfigured) {
    diagnostics.push({
      level: 'error',
      code: 'discord-token-missing',
      message: 'Normal service cannot connect without DISCORD_BOT_TOKEN.',
    });
  }

  if (input.agentType === 'claude-code') {
    const hasClaudeAuth =
      input.config.anthropicApiKeyConfigured ||
      input.config.anthropicAuthTokenConfigured ||
      input.config.claudeCodeOauthTokenConfigured ||
      input.config.claudeCodeOauthTokensConfigured;
    if (!hasClaudeAuth) {
      diagnostics.push({
        level: 'error',
        code: 'claude-auth-missing',
        message:
          'Claude service has no auth configured. Set Anthropic auth or Claude OAuth.',
      });
    }
  }

  if (
    input.agentType === 'codex' &&
    !input.config.codexAuthJsonConfigured &&
    !input.config.codexUseHomeAuth
  ) {
    diagnostics.push({
      level: 'error',
      code: 'codex-auth-missing',
      message:
        'Codex service has no auth configured. Set CODEX_AUTH_JSON_B64 or enable CODEX_USE_HOME_AUTH.',
    });
  }

  if (input.agentType === 'gemini-cli' && !input.config.geminiCliPath) {
    diagnostics.push({
      level: 'warning',
      code: 'gemini-cli-path-default',
      message:
        'Gemini CLI path is not set. The service will rely on `gemini` being available on PATH.',
    });
  }

  if (input.agentType === 'local-llm' && !input.config.localLlmModel) {
    diagnostics.push({
      level: 'error',
      code: 'local-llm-model-missing',
      message: 'Local LLM service requires LOCAL_LLM_MODEL.',
    });
  }

  if (
    input.role !== 'dashboard' &&
    typeof input.assignmentCount === 'number' &&
    input.assignmentCount === 0
  ) {
    diagnostics.push({
      level: 'warning',
      code: 'no-assignments',
      message: 'Staff is not assigned to any order counter.',
    });
  }

  if (input.runtime?.error) {
    diagnostics.push({
      level: 'warning',
      code: 'runtime-inspection-failed',
      message: `Runtime inspection failed: ${input.runtime.error}`,
    });
  }

  if (
    input.runtime &&
    !input.runtime.running &&
    input.runtime.activeState !== 'inactive' &&
    input.runtime.activeState !== 'unknown'
  ) {
    diagnostics.push({
      level: 'warning',
      code: 'service-not-running',
      message: `Service is not running (${input.runtime.activeState}/${input.runtime.subState}).`,
    });
  }

  if (input.runtime?.running && input.snapshotStale) {
    diagnostics.push({
      level: 'warning',
      code: 'stale-snapshot',
      message: 'Runtime is up, but the latest activity snapshot is stale or missing.',
    });
  }

  return diagnostics;
}

export function formatServiceDiagnosticsInline(
  diagnostics: ServiceDiagnostic[],
): string {
  if (diagnostics.length === 0) return 'ok';
  return diagnostics
    .map((diagnostic) => `${diagnostic.level}:${diagnostic.code}`)
    .join(', ');
}
