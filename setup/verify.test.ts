import { describe, expect, it } from 'vitest';

import {
  getPrimaryServiceStatus,
  hasBlockingDiagnostics,
  statusToRuntime,
} from './verify.js';

describe('getPrimaryServiceStatus', () => {
  it('returns not_configured when no services are present', () => {
    expect(getPrimaryServiceStatus([])).toBe('not_configured');
  });

  it('returns the first service status when services exist', () => {
    expect(
      getPrimaryServiceStatus([
        {
          name: 'hkclaw-admin',
          status: 'running',
        },
      ]),
    ).toBe('running');
  });

  it('maps running status into a running runtime summary', () => {
    expect(statusToRuntime('running')).toEqual({
      manager: 'none',
      activeState: 'active',
      subState: 'running',
      running: true,
      mainPid: null,
    });
  });

  it('treats error diagnostics as blocking', () => {
    expect(
      hasBlockingDiagnostics([
        { level: 'warning', code: 'warn', message: 'warn' },
      ]),
    ).toBe(false);
    expect(
      hasBlockingDiagnostics([
        { level: 'error', code: 'err', message: 'err' },
      ]),
    ).toBe(true);
  });
});
