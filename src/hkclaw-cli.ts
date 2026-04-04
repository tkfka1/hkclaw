#!/usr/bin/env node

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { discoverConfiguredServices } from './service-discovery.js';
import {
  buildEffectiveServiceEnv,
  diagnoseServiceHealth,
  formatServiceDiagnosticsInline,
  summarizeServiceHealthConfig,
  type ServiceDiagnostic,
} from './service-health.js';

type CliCommand = 'start' | 'stop' | 'restart' | 'status' | 'setup' | 'verify';
type ServiceManager = 'launchd' | 'systemd' | 'none';

interface ServiceTarget {
  serviceName: string;
  launchdLabel: string;
  wrapperPath: string;
  pidFile: string;
}

export function parseCliCommand(args: string[]): CliCommand | null {
  const command = args[0]?.trim().toLowerCase();
  if (
    command === 'start' ||
    command === 'stop' ||
    command === 'restart' ||
    command === 'status' ||
    command === 'setup' ||
    command === 'verify'
  ) {
    return command;
  }
  return null;
}

function printHelp(): void {
  console.log(`HKClaw CLI

Usage:
  hkclaw start
  hkclaw stop
  hkclaw restart
  hkclaw status
  hkclaw setup
  hkclaw verify

Commands:
  start    Build/reconcile services and start them
  stop     Stop all managed HKClaw services
  restart  Stop then start all managed HKClaw services
  status   Show per-service runtime status
  setup    Run the setup service step directly
  verify   Run the setup verify step directly
`);
}

function getPlatform(): NodeJS.Platform {
  return os.platform();
}

function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    const init = fs.readFileSync('/proc/1/comm', 'utf8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function getServiceManager(): ServiceManager {
  if (getPlatform() === 'darwin') return 'launchd';
  if (getPlatform() === 'linux') {
    return hasSystemd() ? 'systemd' : 'none';
  }
  return 'none';
}

function getServiceTargets(projectRoot: string): ServiceTarget[] {
  const discovered = discoverConfiguredServices(projectRoot);
  const targets = discovered.map((service) => ({
    serviceName: service.serviceName,
    launchdLabel: service.launchdLabel,
    wrapperPath: path.join(projectRoot, `start-${service.serviceName}.sh`),
    pidFile: path.join(projectRoot, `${service.serviceName}.pid`),
  }));

  if (!discovered.some((service) => service.role === 'dashboard')) {
    targets.push({
      serviceName: 'hkclaw-admin',
      launchdLabel: 'com.hkclaw-admin',
      wrapperPath: path.join(projectRoot, 'start-hkclaw-admin.sh'),
      pidFile: path.join(projectRoot, 'hkclaw-admin.pid'),
    });
  }

  return targets;
}

function runSetupStep(step: 'service' | 'verify'): void {
  execFileSync('npm', ['run', 'setup', '--', '--step', step], {
    stdio: 'inherit',
  });
}

function stopLaunchdService(target: ServiceTarget): void {
  try {
    execFileSync(
      'launchctl',
      [
        'unload',
        '-w',
        path.join(
          os.homedir(),
          'Library',
          'LaunchAgents',
          `${target.launchdLabel}.plist`,
        ),
      ],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    // already unloaded or unavailable
  }
}

function stopSystemdService(target: ServiceTarget): void {
  const args = isRoot()
    ? ['stop', target.serviceName]
    : ['--user', 'stop', target.serviceName];
  try {
    execFileSync('systemctl', args, { stdio: 'ignore' });
  } catch {
    // already stopped or unavailable
  }
}

function stopPidFileService(target: ServiceTarget): void {
  if (!fs.existsSync(target.pidFile)) return;
  try {
    const pid = Number(fs.readFileSync(target.pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // process already gone or unreadable pid file
  }
  try {
    fs.rmSync(target.pidFile, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function getServiceStatusLine(
  target: ServiceTarget,
  manager: ServiceManager,
): string {
  if (manager === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf8' });
      const line = output
        .split('\n')
        .find((entry) => entry.includes(target.launchdLabel));
      if (line) {
        const pidField = line.trim().split(/\s+/)[0];
        return `${target.serviceName}: ${pidField !== '-' && pidField ? 'running' : 'stopped'}`;
      }
      return `${target.serviceName}: not found`;
    } catch {
      return `${target.serviceName}: unknown`;
    }
  }

  if (manager === 'systemd') {
    const args = isRoot()
      ? ['is-active', target.serviceName]
      : ['--user', 'is-active', target.serviceName];
    try {
      const output = execFileSync('systemctl', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return `${target.serviceName}: ${output}`;
    } catch {
      return `${target.serviceName}: stopped`;
    }
  }

  if (fs.existsSync(target.pidFile)) {
    try {
      const pid = Number(fs.readFileSync(target.pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        return `${target.serviceName}: running (pid ${pid})`;
      }
    } catch {
      return `${target.serviceName}: stopped`;
    }
  }

  return `${target.serviceName}: not found`;
}

export function formatCliServiceStatus(
  statusLine: string,
  diagnostics: ServiceDiagnostic[],
): string[] {
  if (diagnostics.length === 0) {
    return [statusLine];
  }
  return [
    statusLine,
    `  diagnostics: ${formatServiceDiagnosticsInline(diagnostics)}`,
    ...diagnostics.map((diagnostic) => `  - ${diagnostic.message}`),
  ];
}

function stopAllServices(projectRoot: string): void {
  const manager = getServiceManager();
  const targets = getServiceTargets(projectRoot);
  for (const target of targets) {
    if (manager === 'launchd') {
      stopLaunchdService(target);
    } else if (manager === 'systemd') {
      stopSystemdService(target);
    } else {
      stopPidFileService(target);
    }
  }
}

function printStatus(projectRoot: string): void {
  const manager = getServiceManager();
  const targets = getServiceTargets(projectRoot);
  const servicesByName = new Map(
    discoverConfiguredServices(projectRoot).map((service) => [
      service.serviceName,
      service,
    ]),
  );
  console.log(`service-manager: ${manager}`);
  for (const target of targets) {
    const statusLine = getServiceStatusLine(target, manager);
    const service = servicesByName.get(target.serviceName);
    const diagnostics = service
      ? diagnoseServiceHealth({
          serviceId: service.serviceId,
          serviceName: service.serviceName,
          assistantName: service.assistantName,
          agentType: service.agentType,
          role: service.role,
          envPath: service.envOverlayPath || path.join(projectRoot, '.env'),
          config: summarizeServiceHealthConfig(
            buildEffectiveServiceEnv(projectRoot, service),
          ),
          runtime: {
            manager:
              manager === 'none'
                ? 'none'
                : manager === 'launchd'
                  ? 'launchd'
                  : isRoot()
                    ? 'systemd-system'
                    : 'systemd-user',
            activeState: statusLine.split(': ')[1] || 'unknown',
            subState: 'status',
            running: /running|active/.test(statusLine),
            mainPid: null,
          },
        })
      : [];
    for (const line of formatCliServiceStatus(statusLine, diagnostics)) {
      console.log(line);
    }
  }
}

async function main(): Promise<void> {
  const command = parseCliCommand(process.argv.slice(2));
  const projectRoot = process.cwd();

  if (!command) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (command === 'start' || command === 'setup') {
    runSetupStep('service');
    return;
  }

  if (command === 'verify') {
    runSetupStep('verify');
    return;
  }

  if (command === 'stop') {
    stopAllServices(projectRoot);
    printStatus(projectRoot);
    return;
  }

  if (command === 'restart') {
    stopAllServices(projectRoot);
    runSetupStep('service');
    return;
  }

  if (command === 'status') {
    printStatus(projectRoot);
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  void main();
}
