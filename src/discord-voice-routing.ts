import { isValidGroupFolder } from './group-folder.js';
import { normalizeDiscordJid } from './discord-channel-id.js';
import { RegisteredGroup } from './types.js';

export function parseDiscordVoiceChannelIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim().replace(/^dc:/, ''))
        .filter(Boolean),
    ),
  ];
}

export function parseDiscordVoiceRouteMap(args: {
  voiceChannelIds: string[];
  raw: string | undefined;
  defaultTargetJid?: string | undefined;
}): Map<string, string> {
  const result = new Map<string, string>();
  const defaultTarget = args.defaultTargetJid
    ? normalizeDiscordJid(args.defaultTargetJid)
    : null;

  if (defaultTarget) {
    for (const channelId of args.voiceChannelIds) {
      result.set(`dc:${channelId}`, defaultTarget);
    }
  }

  if (!args.raw) return result;

  for (const entry of args.raw.split(',')) {
    const [voiceRaw, targetRaw] = entry.split('=');
    if (!voiceRaw || !targetRaw) continue;
    const voiceJid = normalizeDiscordJid(voiceRaw);
    const targetJid = normalizeDiscordJid(targetRaw);
    if (!voiceJid || !targetJid) continue;
    result.set(voiceJid, targetJid);
  }

  return result;
}

export function parseDiscordVoiceValueMap(
  raw: string | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;

  for (const entry of raw.split(',')) {
    const [voiceRaw, valueRaw] = entry.split('=');
    if (!voiceRaw || !valueRaw) continue;
    const voiceJid = normalizeDiscordJid(voiceRaw);
    const value = valueRaw.trim();
    if (!voiceJid || !value) continue;
    result.set(voiceJid, value);
  }

  return result;
}

export function buildDiscordVoiceAliases(args: {
  registeredGroups: Record<string, RegisteredGroup>;
  routeMap: Map<string, string>;
  agentType: 'claude-code' | 'codex';
  folderMap?: Map<string, string>;
  nameMap?: Map<string, string>;
  defaultFolder?: string | undefined;
  defaultName?: string | undefined;
}): Record<string, RegisteredGroup> {
  const aliases: Record<string, RegisteredGroup> = {};
  const seedGroup = Object.values(args.registeredGroups).find(
    (group) => (group.agentType || 'claude-code') === args.agentType,
  );

  for (const [voiceJid, targetJid] of args.routeMap) {
    if (args.registeredGroups[voiceJid]) continue;

    const mappedFolder = args.folderMap?.get(voiceJid) || args.defaultFolder;
    const mappedName = args.nameMap?.get(voiceJid) || args.defaultName;
    const targetGroup = args.registeredGroups[targetJid];

    if (targetGroup) {
      const targetAgentType = targetGroup.agentType || 'claude-code';
      if (targetAgentType !== args.agentType) continue;

      const folder =
        mappedFolder && isValidGroupFolder(mappedFolder)
          ? mappedFolder
          : `${targetGroup.folder}_voice`;

      aliases[voiceJid] = {
        ...targetGroup,
        folder,
        name: mappedName || `${targetGroup.name} (voice)`,
      };
      continue;
    }

    // Self-target voice rooms can act as their own primary chat channel.
    if (voiceJid !== targetJid) continue;
    if (!seedGroup) continue;
    if (!mappedFolder || !isValidGroupFolder(mappedFolder)) continue;

    aliases[voiceJid] = {
      ...seedGroup,
      folder: mappedFolder,
      name: mappedName || seedGroup.name,
    };
  }

  return aliases;
}
