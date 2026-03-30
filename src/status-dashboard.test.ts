import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cacheDir = path.join(process.cwd(), 'cache', 'status-dashboard');

describe('status dashboard snapshots', () => {
  beforeEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('writes snapshots by service id and reads them back', async () => {
    const { readStatusSnapshots, writeStatusSnapshot } = await import(
      './status-dashboard.js'
    );

    writeStatusSnapshot({
      serviceId: 'normal',
      agentType: 'codex',
      serviceRole: 'normal',
      assistantName: 'codex',
      updatedAt: new Date().toISOString(),
      entries: [],
    });

    expect(fs.existsSync(path.join(cacheDir, 'normal.json'))).toBe(true);
    const snapshot = readStatusSnapshots(60_000).find(
      (entry) => entry.serviceId === 'normal',
    );
    expect(snapshot?.serviceId).toBe('normal');
    expect(snapshot?.serviceRole).toBe('normal');
  });
});
