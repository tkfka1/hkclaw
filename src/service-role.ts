import type { AgentType, ServiceRole } from './types.js';

export function isDashboardRole(role: ServiceRole): boolean {
  return role === 'dashboard';
}

export function shouldStartInteractiveRuntime(role: ServiceRole): boolean {
  return !isDashboardRole(role);
}

export function shouldRenderDashboard(role: ServiceRole): boolean {
  return isDashboardRole(role);
}

export function shouldCollectCodexUsage(
  role: ServiceRole,
  agentType: AgentType,
): boolean {
  return !isDashboardRole(role) && agentType === 'codex';
}
