export function parseDiscordChannelId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() || '';
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const jidMatch = trimmed.match(/^dc:(\d+)$/);
  if (jidMatch) {
    return jidMatch[1];
  }

  const mentionMatch = trimmed.match(/^<#(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  const urlMatch = trimmed.match(
    /(?:https?:\/\/)?(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)/,
  );
  if (urlMatch) {
    return urlMatch[1];
  }

  return null;
}

export function normalizeDiscordJid(
  value: string | null | undefined,
): string | null {
  const channelId = parseDiscordChannelId(value);
  return channelId ? `dc:${channelId}` : null;
}
