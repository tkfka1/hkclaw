import fs from 'fs';

export type EnvFileUpdates = Record<string, string | null | undefined>;

function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (!/[\s#"']/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function upsertEnvContent(
  content: string,
  updates: EnvFileUpdates,
): string {
  const entries = Object.entries(updates).flatMap(([key, value]) => {
    if (!key.trim() || value === undefined) {
      return [];
    }
    return [[key, value] as [string, string | null]];
  });
  if (entries.length === 0) {
    return content.endsWith('\n') ? content : `${content}\n`;
  }

  const pending = new Map(entries);
  const handled = new Set<string>();
  const lines =
    content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      output.push(line);
      continue;
    }

    const eqIndex = line.indexOf('=');
    const key = line.slice(0, eqIndex).trim();
    if (!pending.has(key)) {
      output.push(line);
      continue;
    }

    if (handled.has(key)) {
      continue;
    }

    handled.add(key);
    const nextValue = pending.get(key);
    if (nextValue === null || nextValue === undefined) {
      continue;
    }

    output.push(`${key}=${formatEnvValue(nextValue)}`);
  }

  const appendLines = [...pending.entries()].flatMap(([key, value]) => {
    if (handled.has(key) || value === null || value === undefined) {
      return [];
    }
    return [`${key}=${formatEnvValue(value)}`];
  });

  let normalized = output.join('\n');
  if (appendLines.length > 0) {
    if (normalized && !normalized.endsWith('\n')) {
      normalized += '\n';
    }
    if (normalized && normalized.trim() !== '') {
      normalized += '\n';
    }
    normalized += appendLines.join('\n');
  }

  if (!normalized.endsWith('\n')) {
    normalized += '\n';
  }

  return normalized;
}

export function upsertEnvFile(filePath: string, updates: EnvFileUpdates): void {
  const current = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';
  const next = upsertEnvContent(current, updates);
  fs.writeFileSync(filePath, next, 'utf-8');
}
