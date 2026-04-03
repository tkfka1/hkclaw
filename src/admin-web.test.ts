import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, upsertAdminUser } from './db.js';
import {
  getAdminBootstrapConfig,
  getAdminSessionTokenFromCookie,
  hashAdminPassword,
  isPublicAdminRoute,
  renderAdminPage,
  renderLoginPage,
  renderSetupRequiredPage,
  verifyAdminPassword,
} from './admin-web.js';
import { renderAdminGamePage } from './admin-web-page.js';

describe('admin web auth helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.unstubAllEnvs();
  });

  it('reads bootstrap credentials from env-style input', () => {
    expect(
      getAdminBootstrapConfig({
        password: 'secret-pass',
      }),
    ).toEqual({
      username: 'admin',
      password: 'secret-pass',
    });
  });

  it('returns null when no bootstrap password exists', () => {
    expect(getAdminBootstrapConfig({})).toBeNull();
  });

  it('hashes and verifies admin passwords', () => {
    const hash = hashAdminPassword('bridge');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyAdminPassword('bridge', hash)).toBe(true);
    expect(verifyAdminPassword('wrong', hash)).toBe(false);
  });

  it('extracts the admin session token from cookies', () => {
    expect(
      getAdminSessionTokenFromCookie(
        'foo=bar; hkclaw_admin_session=session-token; theme=dark',
      ),
    ).toBe('session-token');
  });

  it('ignores malformed cookie encoding', () => {
    expect(
      getAdminSessionTokenFromCookie(
        'foo=bar; hkclaw_admin_session=%E0%A4%A; theme=dark',
      ),
    ).toBe('%E0%A4%A');
  });

  it('marks only login and logout routes as public', () => {
    expect(isPublicAdminRoute('GET', '/healthz')).toBe(true);
    expect(isPublicAdminRoute('GET', '/favicon.ico')).toBe(true);
    expect(isPublicAdminRoute('GET', '/login')).toBe(true);
    expect(isPublicAdminRoute('POST', '/api/admin/login')).toBe(true);
    expect(isPublicAdminRoute('POST', '/api/admin/logout')).toBe(true);
    expect(isPublicAdminRoute('GET', '/')).toBe(false);
    expect(isPublicAdminRoute('GET', '/api/admin/state')).toBe(false);
  });

  it('stores DB-backed admin users with verifiable hashes', () => {
    const hash = hashAdminPassword('ops-pass');
    const user = upsertAdminUser({
      username: 'ops',
      passwordHash: hash,
    });

    expect(user.username).toBe('ops');
    expect(verifyAdminPassword('ops-pass', user.password_hash)).toBe(true);
  });

  it('renders admin surfaces without external font dependencies', () => {
    const pages = [
      renderLoginPage(),
      renderSetupRequiredPage(),
      renderAdminPage(),
      renderAdminGamePage(),
    ];

    for (const html of pages) {
      expect(html).toContain('href="/favicon.ico"');
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).not.toContain('fonts.gstatic.com');
      expect(html).not.toContain('@import url(');
    }
  });

  it('renders the richer login shell and office overview controls', () => {
    const loginPage = renderLoginPage();
    const adminGamePage = renderAdminGamePage();

    expect(loginPage).toContain('운영실 입장');
    expect(loginPage).toContain(
      'HKClaw 운영실은 브라우저 로그인으로 보호됩니다.',
    );
    expect(adminGamePage).toContain('id="stage-overview"');
    expect(adminGamePage).toContain('data-action="camera-overview"');
    expect(adminGamePage).toContain('data-action="camera-focus"');
    expect(adminGamePage).toContain('data-action="camera-jump"');
    expect(adminGamePage).toContain('data-action="open-team-management"');
    expect(adminGamePage).toContain('data-action="open-employees"');
    expect(adminGamePage).toContain('data-action="open-hiring"');
    expect(adminGamePage).toContain('data-action="open-team-layout"');
    expect(adminGamePage).toContain('data-action="open-temperaments"');
    expect(adminGamePage).toContain('data-action="select-hero"');
    expect(adminGamePage).toContain('data-action="toggle-party-member"');
    expect(adminGamePage).toContain('data-action="save-party-preset"');
    expect(adminGamePage).toContain('data-action="load-party-preset"');
    expect(adminGamePage).toContain('data-action="save-relic-loadout"');
    expect(adminGamePage).toContain('data-action="load-relic-loadout"');
    expect(adminGamePage).toContain('data-action="hero-skill"');
    expect(adminGamePage).toContain('data-action="begin-raid"');
    expect(adminGamePage).toContain('data-action="raid-command"');
    expect(adminGamePage).toContain('data-action="claim-raid-loot"');
    expect(adminGamePage).toContain('data-action="accept-objective"');
    expect(adminGamePage).toContain('data-action="resolve-objective"');
    expect(adminGamePage).toContain('data-action="reset-hero-customization"');
    expect(adminGamePage).toContain('data-action="reset-campaign-state"');
    expect(adminGamePage).toContain('data-action="cycle-hero"');
    expect(adminGamePage).toContain('data-action="logout"');
    expect(adminGamePage).toContain('data-employee-filter-input');
    expect(adminGamePage).toContain('id="hero-customization-form"');
    expect(adminGamePage).toContain('오피스 레이드 파티');
    expect(adminGamePage).toContain('현재 퀘스트');
    expect(adminGamePage).toContain('보스 레이드');
    expect(adminGamePage).toContain('오피스 항로');
    expect(adminGamePage).toContain('상황 신호');
    expect(adminGamePage).toContain('렐릭 금고');
    expect(adminGamePage).toContain('Relic Memory');
    expect(adminGamePage).toContain('Squad Memory');
    expect(adminGamePage).toContain('Camera Focus');
    expect(adminGamePage).toContain('현장 기록');
    expect(adminGamePage).toContain('캠페인 로그 초기화');
  });

  it('preserves cleared raid hp when rebuilding encounter cards', () => {
    const adminGamePage = renderAdminGamePage();

    expect(adminGamePage).toContain('raid.bossHp ?? bossMaxHp');
    expect(adminGamePage).not.toContain('raid.bossHp || bossMaxHp');
  });

  it('persists raid relic inventory and applies equipped bonuses to party power', () => {
    const adminGamePage = renderAdminGamePage();

    expect(adminGamePage).toContain('relicInventory: []');
    expect(adminGamePage).toContain('equippedRelicIds: []');
    expect(adminGamePage).toContain(
      'relicLoadouts: createDefaultRelicLoadouts()',
    );
    expect(adminGamePage).toContain(
      'rewardRelic = relicDefForEncounter(encounter.id)',
    );
    expect(adminGamePage).toContain("'unequip-relic' : 'equip-relic'");
    expect(adminGamePage).toContain('equippedRelicBonuses().power');
  });

  it('supports saving and loading relic loadout memory slots', () => {
    const adminGamePage = renderAdminGamePage();

    expect(adminGamePage).toContain("savedAt: ''");
    expect(adminGamePage).toContain('function saveRelicLoadout(slotId)');
    expect(adminGamePage).toContain('function loadRelicLoadout(slotId)');
    expect(adminGamePage).toContain('data-action="save-relic-loadout"');
    expect(adminGamePage).toContain('data-action="load-relic-loadout"');
    expect(adminGamePage).toContain('Relic Loadout');
  });

  it('keeps the stage shell scrollable and syncs the expanded header layout', () => {
    const adminGamePage = renderAdminGamePage();

    expect(adminGamePage).toContain('overflow-y: auto;');
    expect(adminGamePage).toContain('scrollbar-gutter: stable;');
    expect(adminGamePage).toContain('function syncStageHeaderLayout()');
    expect(adminGamePage).toContain(
      'header.style.paddingBottom = `${basePaddingBottom + overflow}px`;',
    );
    expect(adminGamePage).toContain(
      "window.addEventListener('resize', () => {",
    );
  });
});
