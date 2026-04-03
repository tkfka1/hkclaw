/**
 * Cross-platform detection utilities for HKClaw setup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export type Platform = 'macos' | 'linux' | 'windows' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';
export type HostSupportLevel = 'first_class' | 'supported' | 'limited' | 'unsupported';

export interface HostSupportProfile {
  platform: Platform;
  isWSL: boolean;
  serviceManager: ServiceManager;
  level: HostSupportLevel;
  label: string;
  setupFlow: string;
  notes: string[];
}

export interface HostSupportOverrides {
  platform?: Platform;
  isWSL?: boolean;
  serviceManager?: ServiceManager;
}

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  // No display server available
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  // macOS is never headless in practice (even SSH sessions can open URLs)
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    // Check if systemd is PID 1
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Returns true if the command was attempted, false if no method available.
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      // Try xdg-open first, then wslview for WSL
      if (commandExists('xdg-open')) {
        execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      if (isWSL() && commandExists('wslview')) {
        execSync(`wslview ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      // WSL without wslview: try cmd.exe
      if (isWSL()) {
        try {
          execSync(`cmd.exe /c start "" ${JSON.stringify(url)}`, {
            stdio: 'ignore',
          });
          return true;
        } catch {
          // cmd.exe not available
        }
      }
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  return 'none';
}

export function describeHostSupport(
  overrides: HostSupportOverrides = {},
): HostSupportProfile {
  const platform = overrides.platform ?? getPlatform();
  const wsl = overrides.isWSL ?? isWSL();
  const serviceManager = overrides.serviceManager ?? getServiceManager();

  if (platform === 'windows') {
    return {
      platform,
      isWSL: false,
      serviceManager,
      level: 'unsupported',
      label: 'Windows native',
      setupFlow: 'Use WSL Ubuntu instead of running HKClaw directly on Windows.',
      notes: [
        'Native Windows service management is not a supported install target.',
        'Run the repo inside WSL Ubuntu so the Linux setup path applies.',
      ],
    };
  }

  if (platform === 'macos') {
    return {
      platform,
      isWSL: false,
      serviceManager,
      level: 'supported',
      label: 'macOS',
      setupFlow: 'Use the normal setup flow with launchd user agents.',
      notes: [
        'Services are installed as per-user LaunchAgents.',
        'Xcode Command Line Tools are required for native module builds.',
      ],
    };
  }

  if (platform === 'linux' && wsl) {
    return {
      platform,
      isWSL: true,
      serviceManager,
      level: 'supported',
      label: 'WSL Ubuntu',
      setupFlow:
        serviceManager === 'systemd'
          ? 'Use the normal Linux setup flow with systemd.'
          : 'Use the Linux setup flow; service setup falls back to repo-local nohup wrappers when systemd is unavailable.',
      notes: [
        'Windows users should treat WSL Ubuntu as the supported host path.',
        'Without systemd, generated start-*.sh wrappers are the expected service manager fallback.',
      ],
    };
  }

  if (platform === 'linux' && serviceManager === 'systemd') {
    return {
      platform,
      isWSL: false,
      serviceManager,
      level: 'first_class',
      label: 'Linux with systemd',
      setupFlow: 'Use the normal setup flow with systemd user services.',
      notes: [
        'Ubuntu is the primary tested Linux target.',
        'Other Linux distributions are supported when the same Node and systemd assumptions hold.',
      ],
    };
  }

  if (platform === 'linux') {
    return {
      platform,
      isWSL: false,
      serviceManager,
      level: 'limited',
      label: 'Linux without systemd',
      setupFlow:
        'Use the Linux setup flow; service setup falls back to repo-local nohup wrappers.',
      notes: [
        'Install and build remain supported.',
        'Long-running service management is limited to the generated wrapper scripts.',
      ],
    };
  }

  return {
    platform,
    isWSL: false,
    serviceManager,
    level: 'unsupported',
    label: 'Unknown host',
    setupFlow: 'Use Linux, WSL Ubuntu, or macOS.',
    notes: ['The current host OS is outside the documented support matrix.'],
  };
}

export function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
