function isLikelyDiscordSnowflake(value: string): boolean {
  return /^\d{15,22}$/.test(value);
}

export function parseDiscordChannelId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() || '';
  if (!trimmed) return null;

  if (isLikelyDiscordSnowflake(trimmed)) {
    return trimmed;
  }

  const jidMatch = trimmed.match(/^dc:(\d+)$/);
  if (jidMatch && isLikelyDiscordSnowflake(jidMatch[1])) {
    return jidMatch[1];
  }

  const mentionMatch = trimmed.match(/^<#(\d+)>$/);
  if (mentionMatch && isLikelyDiscordSnowflake(mentionMatch[1])) {
    return mentionMatch[1];
  }

  const urlMatch = trimmed.match(
    /(?:https?:\/\/)?(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)/,
  );
  if (urlMatch && isLikelyDiscordSnowflake(urlMatch[1])) {
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
