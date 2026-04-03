/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvFilePath } from '../src/env.js';
import { logger } from '../src/logger.js';
import { discoverConfiguredServices } from '../src/service-discovery.js';
import {
  describeHostSupport,
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

/* ------------------------------------------------------------------ */
/*  Service definition                                                 */
/* ------------------------------------------------------------------ */

export interface ServiceDef {
  /** systemd unit name / nohup script name */
  name: string;
  /** launchd label */
  launchdLabel: string;
  /** Human-readable description for systemd/launchd */
  description: string;
  /** Log file prefix (e.g. "hkclaw" → logs/hkclaw.log) */
  logName: string;
  /** Absolute path to the node entry script */
  entryScript: string;
  /** Absolute paths to env files, loaded in order */
  environmentFiles?: string[];
  /** Extra Environment= lines for systemd / env dict entries for launchd */
  extraEnv?: Record<string, string>;
}

function buildBootstrapAdminServiceDef(projectRoot: string): ServiceDef {
  return {
    name: 'hkclaw-admin',
    launchdLabel: 'com.hkclaw-admin',
    description: 'HKClaw Admin Web',
    logName: 'hkclaw-admin',
    entryScript: path.join(projectRoot, 'dist', 'admin-standalone.js'),
    environmentFiles: [path.join(projectRoot, '.env')].filter((filePath) =>
      fs.existsSync(filePath),
    ),
    extraEnv: {
      SERVICE_ID: 'admin-web',
      ASSISTANT_NAME: 'admin-web',
      SERVICE_ROLE: 'dashboard',
      SERVICE_AGENT_TYPE: 'claude-code',
    },
  };
}

export function buildManagedServiceDefs(projectRoot: string): ServiceDef[] {
  const discovered = discoverConfiguredServices(projectRoot);
  const serviceDefs = discovered.map((service) => ({
    name: service.serviceName,
    launchdLabel: service.launchdLabel,
    description: service.description,
    logName: service.logName,
    entryScript: path.join(projectRoot, 'dist', 'index.js'),
    environmentFiles: [
      path.join(projectRoot, '.env'),
      ...(service.envOverlayPath ? [service.envOverlayPath] : []),
    ].filter((filePath) => fs.existsSync(filePath)),
    extraEnv: service.extraEnv,
  }));

  if (!discovered.some((service) => service.role === 'dashboard')) {
    serviceDefs.push(buildBootstrapAdminServiceDef(projectRoot));
  }

  return serviceDefs;
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();
  const serviceManager = getServiceManager();
  const support = describeHostSupport({
    platform,
    isWSL: isWSL(),
    serviceManager,
  });

  logger.info({ platform, nodePath, projectRoot }, 'Setting up service');

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  const serviceDefs = buildManagedServiceDefs(projectRoot);

  if (platform === 'macos') {
    for (const def of serviceDefs) {
      setupLaunchd(def, projectRoot, nodePath, homeDir);
    }
  } else if (platform === 'linux') {
    setupLinux(serviceDefs, projectRoot, nodePath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR:
        platform === 'windows'
          ? 'windows_native_not_supported'
          : 'unsupported_platform',
      SUPPORT_LEVEL: support.level,
      SUPPORT_LABEL: support.label,
      HINT: support.setupFlow,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  macOS (launchd)                                                    */
/* ------------------------------------------------------------------ */

function setupLaunchd(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    `${def.launchdLabel}.plist`,
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const envVars: Record<string, string> = {
    PATH: `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin:${homeDir}/.npm-global/bin`,
    HOME: homeDir,
    ...(def.environmentFiles || []).reduce<Record<string, string>>(
      (acc, envFile) => ({
        ...acc,
        ...parseEnvFilePath(envFile),
      }),
      {},
    ),
    ...(def.extraEnv || {}),
  };
  const envEntries = Object.entries(envVars).flatMap(([key, value]) => [
    `        <key>${key}</key>`,
    `        <string>${value}</string>`,
  ]);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${def.launchdLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${def.entryScript}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries.join('\n')}
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/${def.logName}.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/${def.logName}.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath, service: def.name }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info({ service: def.name }, 'launchctl load succeeded');
  } catch {
    logger.warn(
      { service: def.name },
      'launchctl load failed (may already be loaded)',
    );
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes(def.launchdLabel);
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_NAME: def.name,
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

/* ------------------------------------------------------------------ */
/*  Linux                                                              */
/* ------------------------------------------------------------------ */

function setupLinux(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemdAll(serviceDefs, projectRoot, nodePath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    for (const def of serviceDefs) {
      setupNohupFallback(def, projectRoot, nodePath, homeDir);
    }
  }
}

/**
 * Kill any orphaned hkclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/(index|admin-standalone)\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned hkclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/* ------------------------------------------------------------------ */
/*  systemd                                                            */
/* ------------------------------------------------------------------ */

function setupSystemdAll(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();
  const systemctlPrefix = runningAsRoot ? 'systemctl' : 'systemctl --user';

  // Pre-flight: verify user-level systemd session is available
  if (!runningAsRoot) {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      for (const def of serviceDefs) {
        setupNohupFallback(def, projectRoot, nodePath, homeDir);
      }
      return;
    }
  }

  // Kill orphaned processes once before installing any services
  killOrphanedProcesses(projectRoot);

  reconcileSystemdUnits(serviceDefs, projectRoot, homeDir, runningAsRoot);

  // Install each service
  for (const def of serviceDefs) {
    setupSystemdUnit(def, projectRoot, nodePath, homeDir, runningAsRoot);
  }

  // Reload daemon once after all units are written
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  // Enable and start each service
  for (const def of serviceDefs) {
    try {
      execSync(`${systemctlPrefix} enable ${def.name}`, { stdio: 'ignore' });
    } catch (err) {
      logger.error({ err, service: def.name }, 'systemctl enable failed');
    }

    try {
      execSync(`${systemctlPrefix} start ${def.name}`, { stdio: 'ignore' });
    } catch (err) {
      logger.error({ err, service: def.name }, 'systemctl start failed');
    }

    // Verify
    let serviceLoaded = false;
    try {
      execSync(`${systemctlPrefix} is-active ${def.name}`, {
        stdio: 'ignore',
      });
      serviceLoaded = true;
    } catch {
      // Not active
    }

    emitStatus('SETUP_SERVICE', {
      SERVICE_NAME: def.name,
      SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      UNIT_PATH: getUnitPath(def.name, homeDir, runningAsRoot),
      SERVICE_LOADED: serviceLoaded,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  }
}

function getUnitPath(
  serviceName: string,
  homeDir: string,
  runningAsRoot: boolean,
): string {
  if (runningAsRoot) {
    return `/etc/systemd/system/${serviceName}.service`;
  }
  return path.join(
    homeDir,
    '.config',
    'systemd',
    'user',
    `${serviceName}.service`,
  );
}

function setupSystemdUnit(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  runningAsRoot: boolean,
): void {
  const unitPath = getUnitPath(def.name, homeDir, runningAsRoot);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });

  // Build Environment= lines
  const envLines = [
    `Environment=HOME=${homeDir}`,
    `Environment=PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin:${homeDir}/.npm-global/bin`,
  ];
  if (def.extraEnv) {
    for (const [k, v] of Object.entries(def.extraEnv)) {
      envLines.push(`Environment=${k}=${v}`);
    }
  }

  // EnvironmentFile lines (shared base env first, then per-service overlay)
  const envFileLine = (def.environmentFiles || [])
    .map((envFile) => `EnvironmentFile=${envFile}`)
    .join('\n');
  const envFileBlock = envFileLine ? `${envFileLine}\n` : '';

  const unit = `[Unit]
Description=${def.description}
After=network.target

[Service]
${envFileBlock}Type=simple
ExecStart=${nodePath} ${def.entryScript}
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
${envLines.join('\n')}
StandardOutput=append:${projectRoot}/logs/${def.logName}.log
StandardError=append:${projectRoot}/logs/${def.logName}.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath, service: def.name }, 'Wrote systemd unit');
}

function reconcileSystemdUnits(
  serviceDefs: ServiceDef[],
  projectRoot: string,
  homeDir: string,
  runningAsRoot: boolean,
): void {
  const unitDir = runningAsRoot
    ? '/etc/systemd/system'
    : path.join(homeDir, '.config', 'systemd', 'user');
  if (!fs.existsSync(unitDir)) return;

  const desiredUnitNames = new Set(serviceDefs.map((def) => `${def.name}.service`));
  const desiredSystemctlPrefix = runningAsRoot ? 'systemctl' : 'systemctl --user';

  for (const entry of fs.readdirSync(unitDir)) {
    if (!entry.startsWith('hkclaw') || !entry.endsWith('.service')) continue;
    if (desiredUnitNames.has(entry)) continue;

    const unitPath = path.join(unitDir, entry);
    const content = fs.readFileSync(unitPath, 'utf8');
    const isProjectUnit =
      content.includes(`WorkingDirectory=${projectRoot}`) ||
      content.includes(`${projectRoot}/dist/index.js`) ||
      content.includes(`${projectRoot}/dist/admin-standalone.js`);
    if (!isProjectUnit) continue;

    const serviceName = path.basename(entry, '.service');
    try {
      execSync(`${desiredSystemctlPrefix} stop ${serviceName}`, {
        stdio: 'ignore',
      });
    } catch {
      // Service may already be stopped.
    }
    try {
      execSync(`${desiredSystemctlPrefix} disable ${serviceName}`, {
        stdio: 'ignore',
      });
    } catch {
      // Service may already be disabled.
    }

    fs.rmSync(unitPath, { force: true });
    logger.info({ unitPath, service: serviceName }, 'Removed stale systemd unit');
  }
}

/* ------------------------------------------------------------------ */
/*  nohup fallback (WSL / no systemd)                                  */
/* ------------------------------------------------------------------ */

function setupNohupFallback(
  def: ServiceDef,
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn(
    { service: def.name },
    'No systemd detected — generating nohup wrapper script',
  );

  const wrapperPath = path.join(projectRoot, `start-${def.name}.sh`);
  const pidFile = path.join(projectRoot, `${def.name}.pid`);

  // Build export lines for extra env
  const exportLines: string[] = [];
  if (def.environmentFiles?.length) {
    exportLines.push(`# Load environment files`);
    exportLines.push(`set -a`);
    for (const envFile of def.environmentFiles) {
      exportLines.push(`source ${JSON.stringify(envFile)}`);
    }
    exportLines.push(`set +a`);
    exportLines.push('');
  }
  if (def.extraEnv) {
    for (const [k, v] of Object.entries(def.extraEnv)) {
      exportLines.push(`export ${k}=${JSON.stringify(v)}`);
    }
    exportLines.push('');
  }

  const lines = [
    '#!/bin/bash',
    `# start-${def.name}.sh — Start ${def.description} without systemd`,
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    ...exportLines,
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    `    echo "Stopping existing ${def.name} (PID $OLD_PID)..."`,
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    `echo "Starting ${def.description}..."`,
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(def.entryScript)} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/' + def.logName + '.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/' + def.logName + '.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    `echo "${def.name} started (PID $!)"`,
    `echo "Logs: tail -f ${projectRoot}/logs/${def.logName}.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath, service: def.name }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_NAME: def.name,
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
