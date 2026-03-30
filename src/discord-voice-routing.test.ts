import { describe, expect, it } from 'vitest';

import {
  buildDiscordVoiceAliases,
  parseDiscordVoiceChannelIds,
  parseDiscordVoiceRouteMap,
  parseDiscordVoiceValueMap,
} from './discord-voice-routing.js';

describe('discord voice routing', () => {
  it('parses configured voice channel ids', () => {
    expect(
      parseDiscordVoiceChannelIds(
        '1486805999535783986, dc:1486805999535783986',
      ),
    ).toEqual(['1486805999535783986']);
  });

  it('builds route map from a default target jid', () => {
    expect(
      Array.from(
        parseDiscordVoiceRouteMap({
          voiceChannelIds: ['1486805999535783986'],
          raw: undefined,
          defaultTargetJid: 'dc:1486791026889855167',
        }).entries(),
      ),
    ).toEqual([['dc:1486805999535783986', 'dc:1486791026889855167']]);
  });

  it('builds in-memory aliases from mapped text groups', () => {
    expect(
      buildDiscordVoiceAliases({
        registeredGroups: {
          'dc:1486791026889855167': {
            name: 'dev-codex',
            folder: 'discord_dev-codex',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            agentType: 'codex',
          },
        },
        routeMap: new Map([
          ['dc:1486805999535783986', 'dc:1486791026889855167'],
        ]),
        agentType: 'codex',
      }),
    ).toEqual({
      'dc:1486805999535783986': {
        name: 'dev-codex (voice)',
        folder: 'discord_dev-codex_voice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        agentType: 'codex',
      },
    });
  });

  it('builds a separate voice session when folder and name are mapped', () => {
    expect(
      buildDiscordVoiceAliases({
        registeredGroups: {
          'dc:1486791026889855167': {
            name: 'dev-codex',
            folder: 'discord_dev-codex',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            agentType: 'codex',
          },
        },
        routeMap: new Map([
          ['dc:1486805999535783986', 'dc:1486791026889855167'],
        ]),
        folderMap: parseDiscordVoiceValueMap(
          '1486805999535783986=discord_call-codex',
        ),
        nameMap: parseDiscordVoiceValueMap('1486805999535783986=call-codex'),
        agentType: 'codex',
      }),
    ).toEqual({
      'dc:1486805999535783986': {
        name: 'call-codex',
        folder: 'discord_call-codex',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        agentType: 'codex',
      },
    });
  });

  it('builds a self-target voice room from mapped folder and name', () => {
    expect(
      buildDiscordVoiceAliases({
        registeredGroups: {
          'dc:1486791026889855167': {
            name: 'dev-codex',
            folder: 'discord_dev-codex',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            agentType: 'codex',
          },
        },
        routeMap: new Map([
          ['dc:1486805999535783986', 'dc:1486805999535783986'],
        ]),
        folderMap: parseDiscordVoiceValueMap(
          '1486805999535783986=discord_call-codex',
        ),
        nameMap: parseDiscordVoiceValueMap('1486805999535783986=call-codex'),
        defaultFolder: 'discord_call-codex',
        defaultName: 'call-codex',
        agentType: 'codex',
      }),
    ).toEqual({
      'dc:1486805999535783986': {
        name: 'call-codex',
        folder: 'discord_call-codex',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        agentType: 'codex',
      },
    });
  });
});
