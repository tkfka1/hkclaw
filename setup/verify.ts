/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { parseEnvFilePath, readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { discoverConfiguredServices } from '../src/service-discovery.js';
import {
  buildEffectiveServiceEnv,
  diagnoseServiceHealth,
  summarizeServiceHealthConfig,
  type ServiceDiagnostic,
} from '../src/service-health.js';
import { getPlatform, getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ServiceStatus = 'running' | 'stopped' | 'not_found' | 'not_configured';

interface ServiceCheck {
  name: string;
  status: ServiceStatus;
}

export function statusToRuntime(
  status: ServiceStatus,
): {
  manager: 'systemd-user' | 'systemd-system' | 'launchd' | 'none';
  activeState: string;
  subState: string;
  running: boolean;
  mainPid: number | null;
} {
  return {
    manager: 'none',
    activeState:
      status === 'running'
        ? 'active'
        : status === 'stopped'
          ? 'inactive'
          : 'unknown',
    subState: status === 'running' ? 'running' : status,
    running: status === 'running',
    mainPid: null,
  };
}

export function hasBlockingDiagnostics(
  diagnostics: ServiceDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.level === 'error');
}

export function getPrimaryServiceStatus(
  services: ServiceCheck[],
): ServiceStatus {
  return services[0]?.status ?? 'not_configured';
}

/* ------------------------------------------------------------------ */
/*  Service status checks                                              */
/* ------------------------------------------------------------------ */

function checkLaunchdService(label: string): ServiceStatus {
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    if (output.includes(label)) {
      const line = output.split('\n').find((l) => l.includes(label));
      if (line) {
        const pidField = line.trim().split(/\s+/)[0];
        return pidField !== '-' && pidField ? 'running' : 'stopped';
      }
    }
  } catch {
    // launchctl not available
  }
  return 'not_found';
}

function checkSystemdService(name: string): ServiceStatus {
  const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
  try {
    execSync(`${prefix} is-active ${name}`, { stdio: 'ignore' });
    return 'running';
  } catch {
    try {
      const output = execSync(`${prefix} list-unit-files`, {
        encoding: 'utf-8',
      });
      if (output.includes(name)) {
        return 'stopped';
      }
    } catch {
      // systemctl not available
    }
  }
  return 'not_found';
}

function checkNohupService(
  projectRoot: string,
  serviceName: string,
): ServiceStatus {
  const pidFile = path.join(projectRoot, `${serviceName}.pid`);
  if (fs.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = Number(raw);
      if (raw && Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        return 'running';
      }
    } catch {
      return 'stopped';
    }
  }
  return 'not_found';
}

function checkService(
  projectRoot: string,
  mgr: ReturnType<typeof getServiceManager>,
  serviceName: string,
  launchdLabel: string,
): ServiceStatus {
  if (mgr === 'launchd') return checkLaunchdService(launchdLabel);
  if (mgr === 'systemd') return checkSystemdService(serviceName);
  return checkNohupService(projectRoot, serviceName);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const mgr = getServiceManager();
  const serviceDefs = discoverConfiguredServices(projectRoot);
  const baseEnv = parseEnvFilePath(path.join(projectRoot, '.env'));

  logger.info('Starting verification');

  // 1. Check service statuses
  const services: ServiceCheck[] = serviceDefs.map((service) => ({
    name: service.serviceName,
    status: checkService(
      projectRoot,
      mgr,
      service.serviceName,
      service.launchdLabel,
    ),
  }));

  for (const svc of services) {
    logger.info({ service: svc.name, status: svc.status }, 'Service status');
  }

  const diagnosticsByService = Object.fromEntries(
    serviceDefs.map((service) => {
      const serviceStatus =
        services.find((entry) => entry.name === service.serviceName)?.status ||
        'not_found';
      const diagnostics = diagnoseServiceHealth({
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        assistantName: service.assistantName,
        agentType: service.agentType,
        role: service.role,
        envPath: service.envOverlayPath || path.join(projectRoot, '.env'),
        config: summarizeServiceHealthConfig(
          buildEffectiveServiceEnv(projectRoot, service, baseEnv),
        ),
        runtime: statusToRuntime(serviceStatus),
      });
      return [service.serviceName, diagnostics];
    }),
  );

  // 2. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 3. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const overlayEnvVars = serviceDefs
    .flatMap((service) =>
      service.envOverlayPath
        ? [parseEnvFilePath(service.envOverlayPath).DISCORD_BOT_TOKEN]
        : [],
    )
    .filter(Boolean);

  const channelAuth: Record<string, string> = {};

  if (
    process.env.DISCORD_BOT_TOKEN ||
    envVars.DISCORD_BOT_TOKEN ||
    overlayEnvVars.length > 0
  ) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 4. Check registered groups (using better-sqlite3, not sqlite3 CLI)
  let registeredGroups = 0;
  let groupsByAgent: Record<string, number> = {};
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;

      // Count by agent type
      try {
        const rows = db
          .prepare(
            'SELECT agent_type, COUNT(*) as count FROM registered_groups GROUP BY agent_type',
          )
          .all() as { agent_type: string; count: number }[];
        for (const r of rows) {
          groupsByAgent[r.agent_type || 'unknown'] = r.count;
        }
      } catch {
        // agent_type column might not exist in older schema
      }

      db.close();
    } catch {
      // Table might not exist
    }
  }

  // Determine overall status
  const primaryRunning = services[0]?.status === 'running';
  const allConfiguredServicesRunning = services.every(
    (service) => service.status === 'running',
  );
  const hasDiagnosticErrors = Object.values(diagnosticsByService).some(
    (diagnostics) => hasBlockingDiagnostics(diagnostics),
  );

  const status =
    primaryRunning &&
    allConfiguredServicesRunning &&
    !hasDiagnosticErrors &&
    credentials !== 'missing' &&
    anyChannelConfigured &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  // Build service status summary
  const servicesSummary: Record<string, string> = {};
  for (const svc of services) {
    servicesSummary[svc.name] = svc.status;
  }

  const diagnosticsSummary = Object.fromEntries(
    Object.entries(diagnosticsByService).map(([serviceName, diagnostics]) => [
      serviceName,
      diagnostics.map((diagnostic) => ({
        level: diagnostic.level,
        code: diagnostic.code,
      })),
    ]),
  );

  logger.info(
    { status, channelAuth, servicesSummary, diagnosticsSummary },
    'Verification complete',
  );

  emitStatus('VERIFY', {
    SERVICES: JSON.stringify(servicesSummary),
    DIAGNOSTICS: JSON.stringify(diagnosticsSummary),
    // Legacy field (keep for backward compatibility)
    SERVICE: getPrimaryServiceStatus(services),
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    GROUPS_BY_AGENT: JSON.stringify(groupsByAgent),
    CODEX_CONFIGURED: serviceDefs.some((service) => service.agentType === 'codex'),
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
