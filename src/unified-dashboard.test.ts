import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  formatStatusHeader,
  readDashboardRendererState,
  summarizeWatcherTasks,
  writeDashboardRendererState,
} from './unified-dashboard.js';

const dashboardStateDir = path.join(
  process.cwd(),
  'cache',
  'unified-dashboard',
);

afterEach(() => {
  fs.rmSync(dashboardStateDir, { recursive: true, force: true });
});

describe('summarizeWatcherTasks', () => {
  it('counts active and paused watcher tasks only', () => {
    const summary = summarizeWatcherTasks([
      {
        prompt:
          '[BACKGROUND CI WATCH]\n\nWatch target:\nGitHub Actions run 1\n\nCheck instructions:\na',
        status: 'active',
      },
      {
        prompt:
          '[BACKGROUND CI WATCH]\n\nWatch target:\nGitHub Actions run 2\n\nCheck instructions:\nb',
        status: 'paused',
      },
      {
        prompt:
          '[BACKGROUND CI WATCH]\n\nWatch target:\nGitHub Actions run 3\n\nCheck instructions:\nc',
        status: 'completed',
      },
      {
        prompt: 'normal scheduled task',
        status: 'active',
      },
    ]);

    expect(summary).toEqual({
      active: 1,
      paused: 1,
    });
  });
});

describe('formatStatusHeader', () => {
  it('shows active watcher count in the dashboard header', () => {
    expect(
      formatStatusHeader({
        totalActive: 3,
        totalRooms: 8,
        watchers: { active: 2, paused: 0 },
      }),
    ).toBe('**📊 에이전트 상태** — 활성 3 / 8 | 감시 2');
  });

  it('adds paused watcher count only when present', () => {
    expect(
      formatStatusHeader({
        totalActive: 3,
        totalRooms: 8,
        watchers: { active: 2, paused: 1 },
      }),
    ).toBe('**📊 에이전트 상태** — 활성 3 / 8 | 감시 2 | 일시정지 1');
  });
});

describe('dashboard renderer state', () => {
  it('persists the last tracked dashboard message id by service id', () => {
    fs.rmSync(dashboardStateDir, { recursive: true, force: true });

    writeDashboardRendererState('dashboard-main', {
      statusJid: 'dc:123',
      statusMessageId: 'msg-123',
    });

    expect(readDashboardRendererState('dashboard-main')).toEqual({
      statusJid: 'dc:123',
      statusMessageId: 'msg-123',
    });
  });
});
