import { describe, expect, it } from 'vitest';

import { shouldResetSessionOnAgentFailure } from './session-recovery.js';

describe('shouldResetSessionOnAgentFailure', () => {
  it('matches many-image dimension limit errors', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result:
          'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
        error: undefined,
      }),
    ).toBe(true);
  });

  it('matches the error field too', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result: null,
        error:
          'fatal: An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
      }),
    ).toBe(true);
  });

  it('does not match unrelated agent failures', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result: null,
        error: 'Claude Code process exited with code 1',
      }),
    ).toBe(false);
  });
});
