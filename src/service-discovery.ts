import fs from 'fs';
import path from 'path';

import { parseEnvFilePath } from './env.js';
import { logger } from './logger.js';
import {
  getAgentLabel,
  getRoleLabel,
  normalizeServiceId,
  parseAgentType,
  parseServiceRole,
} from './service-metadata.js';
import type { AgentType, ServiceRole } from './types.js';

export const PRIMARY_SERVICE_OVERLAY_NAME = '.env.primary';

export function getPrimaryServiceOverlayPath(projectRoot: string): string {
  return path.join(projectRoot, PRIMARY_SERVICE_OVERLAY_NAME);
}

export interface DiscoveredService {
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  launchdLabel: string;
  description: string;
  logName: string;
  assistantName: string;
  agentType: AgentType;
  role: ServiceRole;
  envOverlayPath?: string;
  extraEnv: Record<string, string>;
  source: 'primary' | 'legacy-codex' | 'overlay';
}

interface BuildServiceOptions {
  projectRoot: string;
  baseEnv: Record<string, string>;
  overlayPath?: string;
  source: DiscoveredService['source'];
  isPrimary: boolean;
  inferredServiceId?: string;
  defaultAssistantName?: string;
  defaultRole?: ServiceRole;
}

function hasPrimaryServiceConfig(
  baseEnv: Record<string, string>,
  overlayExists: boolean,
): boolean {
  if (overlayExists) {
    return true;
  }

  return [
    'ASSISTANT_NAME',
    'SERVICE_ID',
    'SERVICE_AGENT_TYPE',
    'SERVICE_ROLE',
    'SERVICE_USAGE',
    'DISCORD_BOT_TOKEN',
    'STATUS_CHANNEL_ID',
    'USAGE_DASHBOARD',
  ].some((key) => {
    const value = baseEnv[key];
    return typeof value === 'string' && value.trim() !== '';
  });
}

function buildServiceDescription(
  role: ServiceRole,
  agentType: AgentType,
): string {
  return `HKClaw ${getRoleLabel(role)} Service (${getAgentLabel(agentType)})`;
}

function buildDiscoveredService(
  opts: BuildServiceOptions,
): DiscoveredService | null {
  const overlayEnv = opts.overlayPath ? parseEnvFilePath(opts.overlayPath) : {};
  const assistantName =
    overlayEnv.ASSISTANT_NAME ||
    (opts.isPrimary ? opts.baseEnv.ASSISTANT_NAME : undefined) ||
    opts.defaultAssistantName ||
    (opts.isPrimary
      ? opts.baseEnv.SERVICE_ID || 'primary'
      : opts.inferredServiceId || 'service');
  const agentType = parseAgentType(
    overlayEnv.SERVICE_AGENT_TYPE ||
      (opts.isPrimary ? opts.baseEnv.SERVICE_AGENT_TYPE : undefined),
    assistantName,
  );
  const role = parseServiceRole(
    overlayEnv.SERVICE_ROLE ||
      overlayEnv.SERVICE_USAGE ||
      (opts.isPrimary ? opts.baseEnv.SERVICE_ROLE : undefined) ||
      (opts.isPrimary ? opts.baseEnv.SERVICE_USAGE : undefined),
    opts.defaultRole || 'normal',
  );
  const serviceId = normalizeServiceId(
    overlayEnv.SERVICE_ID ||
      (opts.isPrimary ? opts.baseEnv.SERVICE_ID : undefined) ||
      opts.inferredServiceId ||
      assistantName,
    opts.isPrimary ? 'normal' : opts.inferredServiceId || assistantName,
  );

  if (!serviceId) {
    logger.warn(
      { overlayPath: opts.overlayPath, source: opts.source },
      'Skipping service with empty service id',
    );
    return null;
  }

  const serviceSlug = serviceId;
  const serviceName = opts.isPrimary ? 'hkclaw' : `hkclaw-${serviceSlug}`;
  const launchdLabel = opts.isPrimary
    ? 'com.hkclaw'
    : `com.hkclaw-${serviceSlug}`;
  const logName = serviceName;
  const envOverlayPath =
    opts.overlayPath ||
    (opts.isPrimary
      ? getPrimaryServiceOverlayPath(opts.projectRoot)
      : path.join(opts.projectRoot, `.env.agent.${serviceSlug}`));

  return {
    serviceId,
    serviceSlug,
    serviceName,
    launchdLabel,
    description: buildServiceDescription(role, agentType),
    logName,
    assistantName,
    agentType,
    role,
    envOverlayPath: opts.overlayPath,
    extraEnv: {
      SERVICE_ID: serviceId,
      SERVICE_AGENT_TYPE: agentType,
      SERVICE_ROLE: role,
      ASSISTANT_NAME: assistantName,
      HKCLAW_SERVICE_ENV_PATH: envOverlayPath,
    },
    source: opts.source,
  };
}

export function discoverConfiguredServices(
  projectRoot: string,
): DiscoveredService[] {
  const baseEnv = parseEnvFilePath(path.join(projectRoot, '.env'));
  const services: DiscoveredService[] = [];
  const primaryOverlayPath = getPrimaryServiceOverlayPath(projectRoot);
  const hasPrimaryOverlay = fs.existsSync(primaryOverlayPath);

  if (hasPrimaryServiceConfig(baseEnv, hasPrimaryOverlay)) {
    const primary = buildDiscoveredService({
      projectRoot,
      baseEnv,
      overlayPath: hasPrimaryOverlay ? primaryOverlayPath : undefined,
      source: 'primary',
      isPrimary: true,
      defaultAssistantName:
        baseEnv.ASSISTANT_NAME || baseEnv.SERVICE_ID || 'primary',
      defaultRole: 'normal',
    });
    if (primary) {
      services.push(primary);
    }
  }

  const legacyCodexPath = path.join(projectRoot, '.env.codex');
  if (fs.existsSync(legacyCodexPath)) {
    const legacyCodex = buildDiscoveredService({
      projectRoot,
      baseEnv,
      overlayPath: legacyCodexPath,
      source: 'legacy-codex',
      isPrimary: false,
      inferredServiceId: 'codex',
      defaultAssistantName: 'codex',
      defaultRole: 'normal',
    });
    if (legacyCodex) {
      services.push(legacyCodex);
      logger.info(
        {
          serviceName: legacyCodex.serviceName,
          serviceId: legacyCodex.serviceId,
        },
        'Detected legacy .env.codex overlay',
      );
    }
  }

  const overlayFiles = fs
    .readdirSync(projectRoot)
    .filter(
      (entry) => entry.startsWith('.env.agent.') && !entry.endsWith('.example'),
    )
    .sort();

  for (const entry of overlayFiles) {
    const inferredServiceId = entry.slice('.env.agent.'.length);
    const discovered = buildDiscoveredService({
      projectRoot,
      baseEnv,
      overlayPath: path.join(projectRoot, entry),
      source: 'overlay',
      isPrimary: false,
      inferredServiceId,
      defaultAssistantName: inferredServiceId,
      defaultRole: 'normal',
    });
    if (discovered) {
      services.push(discovered);
    }
  }

  const seenServiceIds = new Set<string>();
  const seenServiceNames = new Set<string>();
  for (const service of services) {
    if (seenServiceIds.has(service.serviceId)) {
      throw new Error(`Duplicate SERVICE_ID detected: ${service.serviceId}`);
    }
    if (seenServiceNames.has(service.serviceName)) {
      throw new Error(
        `Duplicate service name detected: ${service.serviceName}`,
      );
    }
    seenServiceIds.add(service.serviceId);
    seenServiceNames.add(service.serviceName);
  }

  return services;
}

export function getLegacyServiceIdByAgentType(
  projectRoot: string,
): Record<AgentType, string> {
  const mapping: Partial<Record<AgentType, string>> = {};
  for (const service of discoverConfiguredServices(projectRoot)) {
    if (!mapping[service.agentType]) {
      mapping[service.agentType] = service.serviceId;
    }
  }
  return {
    'claude-code': mapping['claude-code'] || 'normal',
    codex: mapping.codex || 'codex',
    'gemini-cli': mapping['gemini-cli'] || 'gemini',
    'local-llm': mapping['local-llm'] || 'local-llm',
  };
}
