import { describe, it, expect } from 'vitest';

import {
  describeHostSupport,
  getPlatform,
  isWSL,
  isRoot,
  isHeadless,
  hasSystemd,
  getServiceManager,
  commandExists,
  getNodeVersion,
  getNodeMajorVersion,
} from './platform.js';

// --- getPlatform ---

describe('getPlatform', () => {
  it('returns a valid platform string', () => {
    const result = getPlatform();
    expect(['macos', 'linux', 'windows', 'unknown']).toContain(result);
  });
});

// --- isWSL ---

describe('isWSL', () => {
  it('returns a boolean', () => {
    expect(typeof isWSL()).toBe('boolean');
  });

  it('checks /proc/version for WSL markers', () => {
    // On non-WSL Linux, should return false
    // On WSL, should return true
    // Just verify it doesn't throw
    const result = isWSL();
    expect(typeof result).toBe('boolean');
  });
});

// --- isRoot ---

describe('isRoot', () => {
  it('returns a boolean', () => {
    expect(typeof isRoot()).toBe('boolean');
  });
});

// --- isHeadless ---

describe('isHeadless', () => {
  it('returns a boolean', () => {
    expect(typeof isHeadless()).toBe('boolean');
  });
});

// --- hasSystemd ---

describe('hasSystemd', () => {
  it('returns a boolean', () => {
    expect(typeof hasSystemd()).toBe('boolean');
  });

  it('checks /proc/1/comm', () => {
    // On systemd systems, should return true
    // Just verify it doesn't throw
    const result = hasSystemd();
    expect(typeof result).toBe('boolean');
  });
});

// --- getServiceManager ---

describe('getServiceManager', () => {
  it('returns a valid service manager', () => {
    const result = getServiceManager();
    expect(['launchd', 'systemd', 'none']).toContain(result);
  });

  it('matches the detected platform', () => {
    const platform = getPlatform();
    const result = getServiceManager();
    if (platform === 'macos') {
      expect(result).toBe('launchd');
    } else if (platform === 'windows') {
      expect(result).toBe('none');
    } else {
      expect(['systemd', 'none']).toContain(result);
    }
  });
});

describe('describeHostSupport', () => {
  it('marks Windows native as unsupported', () => {
    expect(
      describeHostSupport({
        platform: 'windows',
        isWSL: false,
        serviceManager: 'none',
      }),
    ).toMatchObject({
      level: 'unsupported',
      label: 'Windows native',
    });
  });

  it('marks macOS as supported with launchd', () => {
    expect(
      describeHostSupport({
        platform: 'macos',
        isWSL: false,
        serviceManager: 'launchd',
      }),
    ).toMatchObject({
      level: 'supported',
      label: 'macOS',
    });
  });

  it('marks Linux with systemd as first-class', () => {
    expect(
      describeHostSupport({
        platform: 'linux',
        isWSL: false,
        serviceManager: 'systemd',
      }),
    ).toMatchObject({
      level: 'first_class',
      label: 'Linux with systemd',
    });
  });

  it('marks WSL without systemd as supported via nohup fallback', () => {
    const profile = describeHostSupport({
      platform: 'linux',
      isWSL: true,
      serviceManager: 'none',
    });
    expect(profile.level).toBe('supported');
    expect(profile.setupFlow).toContain('nohup');
  });

  it('marks Linux without systemd as limited', () => {
    expect(
      describeHostSupport({
        platform: 'linux',
        isWSL: false,
        serviceManager: 'none',
      }),
    ).toMatchObject({
      level: 'limited',
      label: 'Linux without systemd',
    });
  });
});

// --- commandExists ---

describe('commandExists', () => {
  it('returns true for node', () => {
    expect(commandExists('node')).toBe(true);
  });

  it('returns false for nonexistent command', () => {
    expect(commandExists('this_command_does_not_exist_xyz_123')).toBe(false);
  });
});

// --- getNodeVersion ---

describe('getNodeVersion', () => {
  it('returns a version string', () => {
    const version = getNodeVersion();
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// --- getNodeMajorVersion ---

describe('getNodeMajorVersion', () => {
  it('returns at least 20', () => {
    const major = getNodeMajorVersion();
    expect(major).not.toBeNull();
    expect(major!).toBeGreaterThanOrEqual(20);
  });
});
