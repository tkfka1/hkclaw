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

  it('renders the primary admin pages', () => {
    const pages = [renderLoginPage(), renderSetupRequiredPage(), renderAdminPage()];

    for (const html of pages) {
      expect(html).toContain('href="/favicon.ico"');
    }

    expect(renderAdminGamePage()).toContain('<title>Office Admin</title>');
  });

  it('renders the original game-style office admin shell', () => {
    const loginPage = renderLoginPage();
    const adminGamePage = renderAdminGamePage();

    expect(loginPage).toContain('운영실 입장');
    expect(loginPage).toContain(
      'HKClaw 운영실은 브라우저 로그인으로 보호됩니다.',
    );
    expect(adminGamePage).toContain('<title>Office Admin</title>');
    expect(adminGamePage).toContain('class="app"');
    expect(adminGamePage).toContain('class="stage-wrap"');
    expect(adminGamePage).toContain('class="office" id="office"');
    expect(adminGamePage).toContain('id="detail-modal"');
    expect(adminGamePage).toContain('id="detail-panel"');
    expect(adminGamePage).toContain('data-action="open-team-create"');
    expect(adminGamePage).toContain('data-action="open-hiring"');
    expect(adminGamePage).toContain("id: 'team-management'");
    expect(adminGamePage).toContain("id: 'hiring'");
    expect(adminGamePage).toContain("id: 'employees'");
    expect(adminGamePage).toContain("data-origin-block=\"gemini-cli\"");
    expect(adminGamePage).toContain("data-origin-block=\"local-llm\"");
    expect(adminGamePage).toContain('function buildCounterLayouts');
    expect(adminGamePage).toContain('function boot()');
    expect(adminGamePage).toContain('this.cameras.main');
  });

  it('keeps the office shell scrollable', () => {
    const adminGamePage = renderAdminGamePage();

    expect(adminGamePage).toContain('overflow-y: auto;');
    expect(adminGamePage).toContain('scrollbar-gutter: stable;');
    expect(adminGamePage).toContain('setInterval(() => {');
  });
});
