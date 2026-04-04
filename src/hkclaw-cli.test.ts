import { describe, expect, it } from 'vitest';

import { formatCliServiceStatus, parseCliCommand } from './hkclaw-cli.js';

describe('hkclaw cli', () => {
  it('parses supported commands', () => {
    expect(parseCliCommand(['start'])).toBe('start');
    expect(parseCliCommand(['stop'])).toBe('stop');
    expect(parseCliCommand(['restart'])).toBe('restart');
    expect(parseCliCommand(['status'])).toBe('status');
    expect(parseCliCommand(['setup'])).toBe('setup');
    expect(parseCliCommand(['verify'])).toBe('verify');
  });

  it('rejects unknown commands', () => {
    expect(parseCliCommand([])).toBeNull();
    expect(parseCliCommand(['boot'])).toBeNull();
  });

  it('includes diagnostics in formatted status output', () => {
    expect(
      formatCliServiceStatus('hkclaw-qa: stopped', [
        {
          level: 'error',
          code: 'discord-token-missing',
          message: 'Normal service cannot connect without DISCORD_BOT_TOKEN.',
        },
      ]),
    ).toEqual([
      'hkclaw-qa: stopped',
      '  diagnostics: error:discord-token-missing',
      '  - Normal service cannot connect without DISCORD_BOT_TOKEN.',
    ]);
  });
});
