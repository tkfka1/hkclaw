import type { AgentType, ServiceRole } from './types.js';

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeServiceId(
  value: string | undefined | null,
  fallback: string = 'normal',
): string {
  const normalized = value ? slugify(value) : '';
  if (normalized) return normalized;
  const fallbackNormalized = slugify(fallback);
  return fallbackNormalized || 'normal';
}

export function parseAgentType(
  value: string | undefined | null,
  assistantName?: string,
): AgentType {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'gemini' || normalized === 'gemini-cli') {
    return 'gemini-cli';
  }
  if (
    normalized === 'local' ||
    normalized === 'local-llm' ||
    normalized === 'ollama' ||
    normalized === 'vllm'
  ) {
    return 'local-llm';
  }
  if (
    normalized === 'claude' ||
    normalized === 'claude-code' ||
    normalized === 'claude_code'
  ) {
    return 'claude-code';
  }

  return normalizeServiceId(assistantName, 'claude') === 'codex'
    ? 'codex'
    : 'claude-code';
}

export function parseServiceRole(
  value: string | undefined | null,
  fallback: ServiceRole = 'normal',
): ServiceRole {
  const normalized = normalizeServiceId(value, fallback);
  switch (normalized) {
    case 'dashboard':
      return 'dashboard';
    case 'normal':
    case 'chat':
    case 'text':
    case 'text-chat':
    case 'general':
    case 'general-chat':
    case 'voice':
    case 'voice-chat':
    case 'assistant':
      return 'normal';
    default:
      return fallback;
  }
}

export function getAgentLabel(agentType: AgentType): string {
  switch (agentType) {
    case 'codex':
      return 'Codex';
    case 'gemini-cli':
      return 'Gemini CLI';
    case 'local-llm':
      return 'Local LLM';
    case 'claude-code':
    default:
      return 'Claude';
  }
}

export function getRoleLabel(role: ServiceRole): string {
  switch (role) {
    case 'dashboard':
      return 'Dashboard';
    case 'normal':
      return 'Normal';
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
}
