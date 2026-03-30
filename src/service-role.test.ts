import { describe, expect, it } from 'vitest';

import {
  isDashboardRole,
  shouldCollectCodexUsage,
  shouldRenderDashboard,
  shouldStartInteractiveRuntime,
} from './service-role.js';

describe('service role helpers', () => {
  it('treats dashboard as a non-interactive renderer role', () => {
    expect(isDashboardRole('dashboard')).toBe(true);
    expect(shouldRenderDashboard('dashboard')).toBe(true);
    expect(shouldStartInteractiveRuntime('dashboard')).toBe(false);
  });

  it('keeps normal roles interactive', () => {
    expect(shouldStartInteractiveRuntime('normal')).toBe(true);
    expect(shouldRenderDashboard('normal')).toBe(false);
  });

  it('only collects codex usage from non-dashboard codex services', () => {
    expect(shouldCollectCodexUsage('normal', 'codex')).toBe(true);
    expect(shouldCollectCodexUsage('dashboard', 'codex')).toBe(false);
    expect(shouldCollectCodexUsage('normal', 'claude-code')).toBe(false);
  });
});
