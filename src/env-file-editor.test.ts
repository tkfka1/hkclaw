import { describe, expect, it } from 'vitest';

import { upsertEnvContent } from './env-file-editor.js';

describe('upsertEnvContent', () => {
  it('replaces existing keys and appends new ones', () => {
    const next = upsertEnvContent(
      ['# config', 'ASSISTANT_NAME=andy', 'SERVICE_ROLE=assistant', ''].join(
        '\n',
      ),
      {
        ASSISTANT_NAME: 'dashboard',
        STATUS_CHANNEL_ID: '123456',
      },
    );

    expect(next).toContain('ASSISTANT_NAME=dashboard');
    expect(next).toContain('SERVICE_ROLE=assistant');
    expect(next).toContain('STATUS_CHANNEL_ID=123456');
    expect(next.startsWith('# config')).toBe(true);
  });

  it('removes keys when null is provided', () => {
    const next = upsertEnvContent(
      ['ASSISTANT_NAME=andy', 'STATUS_CHANNEL_ID=123456', ''].join('\n'),
      {
        STATUS_CHANNEL_ID: null,
      },
    );

    expect(next).toContain('ASSISTANT_NAME=andy');
    expect(next).not.toContain('STATUS_CHANNEL_ID=');
  });

  it('quotes values with spaces', () => {
    const next = upsertEnvContent('', {
      ASSISTANT_NAME: 'HKClaw Dashboard',
    });

    expect(next).toBe('ASSISTANT_NAME="HKClaw Dashboard"\n');
  });

  it('keeps existing keys when undefined is provided', () => {
    const next = upsertEnvContent(
      ['ANTHROPIC_AUTH_TOKEN=test', 'GROQ_API_KEY=abc123', ''].join('\n'),
      {
        ANTHROPIC_AUTH_TOKEN: undefined,
        GROQ_API_KEY: 'updated',
      },
    );

    expect(next).toContain('ANTHROPIC_AUTH_TOKEN=test');
    expect(next).toContain('GROQ_API_KEY=updated');
  });
});
