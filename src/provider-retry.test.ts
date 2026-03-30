import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./provider-fallback.js', () => ({
  detectFallbackTrigger: vi.fn(() => ({ shouldFallback: false, reason: '' })),
  markPrimaryCooldown: vi.fn(),
}));

vi.mock('./token-rotation.js', () => ({
  rotateToken: vi.fn(() => false),
  getTokenCount: vi.fn(() => 1),
  markTokenHealthy: vi.fn(),
}));

import { markPrimaryCooldown } from './provider-fallback.js';
import { runClaudeRotationLoop } from './provider-retry.js';
import {
  getTokenCount,
  markTokenHealthy,
  rotateToken,
} from './token-rotation.js';

describe('runClaudeRotationLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTokenCount).mockReturnValue(1);
    vi.mocked(rotateToken).mockReturnValue(false);
  });

  it('rotates and succeeds after an org-access-denied trigger', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);
    vi.mocked(rotateToken).mockReturnValueOnce(true);

    const outcome = await runClaudeRotationLoop(
      { reason: 'org-access-denied' },
      async () => ({
        output: { status: 'success', result: 'ok' },
        sawOutput: true,
      }),
      { runId: 'rotate-org-access' },
    );

    expect(outcome).toEqual({ type: 'success' });
    expect(rotateToken).toHaveBeenCalledTimes(1);
    expect(markTokenHealthy).toHaveBeenCalledTimes(1);
    expect(markPrimaryCooldown).not.toHaveBeenCalled();
  });

  it('marks no-fallback cooldown when all Claude tokens are org-access-denied', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);

    const outcome = await runClaudeRotationLoop(
      { reason: 'org-access-denied' },
      async () => ({
        output: { status: 'success', result: 'should not run' },
        sawOutput: true,
      }),
      { runId: 'no-fallback-org-access' },
    );

    expect(outcome).toEqual({
      type: 'no-fallback',
      trigger: { reason: 'org-access-denied' },
    });
    expect(markPrimaryCooldown).toHaveBeenCalledWith(
      'org-access-denied',
      undefined,
    );
  });

  it('returns success-null-result as a fallback trigger after rotation', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);
    vi.mocked(rotateToken).mockReturnValueOnce(true);

    const outcome = await runClaudeRotationLoop(
      { reason: '429' },
      async () => ({
        output: { status: 'success', result: null },
        sawOutput: false,
        sawSuccessNullResult: true,
      }),
      { runId: 'success-null-result' },
    );

    expect(outcome).toEqual({
      type: 'needs-fallback',
      trigger: { reason: 'success-null-result' },
    });
    expect(markPrimaryCooldown).not.toHaveBeenCalled();
  });
});
