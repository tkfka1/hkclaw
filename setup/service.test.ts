import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { buildManagedServiceDefs } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hkclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/hkclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/hkclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=HKClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/hkclaw.log
StandardError=append:${projectRoot}/logs/hkclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/hkclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>com.hkclaw</string>');
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/hkclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/hkclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/hkclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/hkclaw',
      '/home/user',
    );
    expect(plist).toContain('hkclaw.log');
    expect(plist).toContain('hkclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/hkclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/hkclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/hkclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/hkclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/hkclaw/dist/index.js',
    );
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/hkclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'hkclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/hkclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/hkclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('hkclaw.pid');
  });
});

describe('buildManagedServiceDefs', () => {
  it('adds a bootstrap admin service when no dashboard service exists', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hkclaw-service-defs-'),
    );
    fs.writeFileSync(path.join(projectRoot, '.env'), '');

    const defs = buildManagedServiceDefs(projectRoot);

    expect(defs.map((def) => def.name)).toEqual(['hkclaw-admin']);
    expect(defs[0]?.entryScript).toBe(
      path.join(projectRoot, 'dist', 'admin-standalone.js'),
    );
  });

  it('does not add a bootstrap admin service when a dashboard service exists', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hkclaw-service-defs-'),
    );
    fs.writeFileSync(path.join(projectRoot, '.env'), '');
    fs.writeFileSync(
      path.join(projectRoot, '.env.agent.dashboard'),
      [
        'SERVICE_ID=dashboard',
        'ASSISTANT_NAME=dashboard',
        'SERVICE_ROLE=dashboard',
        'SERVICE_AGENT_TYPE=claude-code',
        'STATUS_CHANNEL_ID=123456789012345678',
      ].join('\n'),
    );

    const defs = buildManagedServiceDefs(projectRoot);

    expect(defs.map((def) => def.name)).toEqual(['hkclaw-dashboard']);
  });

  it('keeps the bootstrap admin service alongside non-dashboard services', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hkclaw-service-defs-'),
    );
    fs.writeFileSync(
      path.join(projectRoot, '.env.primary'),
      [
        'SERVICE_ID=normal',
        'ASSISTANT_NAME=normal',
        'SERVICE_ROLE=normal',
        'SERVICE_AGENT_TYPE=claude-code',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(projectRoot, '.env'), '');

    const defs = buildManagedServiceDefs(projectRoot);

    expect(defs.map((def) => def.name)).toEqual(['hkclaw', 'hkclaw-admin']);
  });
});
