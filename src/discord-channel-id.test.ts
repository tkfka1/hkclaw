import { describe, expect, it } from 'vitest';

import {
  normalizeDiscordJid,
  parseDiscordChannelId,
} from './discord-channel-id.js';

describe('parseDiscordChannelId', () => {
  it('accepts raw channel ids', () => {
    expect(parseDiscordChannelId('1486792500814413957')).toBe(
      '1486792500814413957',
    );
  });

  it('normalizes discord jid, mention, and channel url inputs', () => {
    expect(parseDiscordChannelId('dc:1486792500814413957')).toBe(
      '1486792500814413957',
    );
    expect(parseDiscordChannelId('<#1486792500814413957>')).toBe(
      '1486792500814413957',
    );
    expect(
      parseDiscordChannelId(
        'https://discord.com/channels/1000000000000000000/1486792500814413957',
      ),
    ).toBe('1486792500814413957');
  });

  it('rejects non-channel inputs', () => {
    expect(parseDiscordChannelId('dc:not-a-channel')).toBeNull();
    expect(parseDiscordChannelId('dc:14867924710')).toBeNull();
    expect(parseDiscordChannelId('14867924710')).toBeNull();
    expect(parseDiscordChannelId('general')).toBeNull();
  });
});

describe('normalizeDiscordJid', () => {
  it('returns a dc-prefixed jid when the input is valid', () => {
    expect(normalizeDiscordJid('<#1486792500814413957>')).toBe(
      'dc:1486792500814413957',
    );
  });
});
