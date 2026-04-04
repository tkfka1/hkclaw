import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildEffectiveServiceEnv,
  diagnoseServiceHealth,
  summarizeServiceHealthConfig,
} from './service-health.js';
import { discoverConfiguredServices } from './service-discovery.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-health-'));
  tempDirs.push(dir);
  for (const [filePath, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filePath), content, 'utf-8');
  }
  return dir;
}

describe('service health diagnostics', () => {
  it('flags missing codex auth and missing discord token', () => {
    const projectRoot = createProject({
      '.env.agent.qa': [
        'ASSISTANT_NAME=QA',
        'SERVICE_ID=qa',
        'SERVICE_AGENT_TYPE=codex',
        'SERVICE_ROLE=normal',
      ].join('\n'),
    });

    const [service] = discoverConfiguredServices(projectRoot);
    const diagnostics = diagnoseServiceHealth({
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
        manager: 'systemd-user',
        activeState: 'inactive',
        subState: 'dead',
        running: false,
        mainPid: null,
      },
      assignmentCount: 0,
      snapshotStale: true,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'discord-token-missing',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'codex-auth-missing',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'no-assignments',
    );
    expect(
      diagnostics.find((diagnostic) => diagnostic.code === 'no-assignments')
        ?.message,
    ).toBe('Staff is not assigned to any order counter.');
  });

  it('accepts codex home auth as valid authentication', () => {
    const projectRoot = createProject({
      '.env.agent.qa': [
        'ASSISTANT_NAME=QA',
        'SERVICE_ID=qa',
        'SERVICE_AGENT_TYPE=codex',
        'SERVICE_ROLE=normal',
        'DISCORD_BOT_TOKEN=test-token',
        'CODEX_USE_HOME_AUTH=true',
      ].join('\n'),
    });

    const [service] = discoverConfiguredServices(projectRoot);
    const diagnostics = diagnoseServiceHealth({
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
        manager: 'systemd-user',
        activeState: 'active',
        subState: 'running',
        running: true,
        mainPid: 123,
      },
      assignmentCount: 1,
      snapshotStale: false,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'codex-auth-missing',
    );
  });

  it('flags dashboard services without a status channel', () => {
    const projectRoot = createProject({
      '.env.agent.ops': [
        'ASSISTANT_NAME=Ops',
        'SERVICE_ID=ops',
        'SERVICE_AGENT_TYPE=claude-code',
        'SERVICE_ROLE=dashboard',
        'CLAUDE_CODE_OAUTH_TOKEN=oauth-token',
      ].join('\n'),
    });

    const [service] = discoverConfiguredServices(projectRoot);
    const diagnostics = diagnoseServiceHealth({
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
        manager: 'systemd-user',
        activeState: 'active',
        subState: 'running',
        running: true,
        mainPid: 123,
      },
      assignmentCount: 1,
      snapshotStale: false,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'status-channel-missing',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'no-assignments',
    );
  });

  it('flags local llm services without a model', () => {
    const projectRoot = createProject({
      '.env.agent.local': [
        'ASSISTANT_NAME=Local Bot',
        'SERVICE_ID=local',
        'SERVICE_AGENT_TYPE=local-llm',
        'SERVICE_ROLE=normal',
        'DISCORD_BOT_TOKEN=test-token',
        'LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1',
      ].join('\n'),
    });

    const [service] = discoverConfiguredServices(projectRoot);
    const diagnostics = diagnoseServiceHealth({
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
        manager: 'systemd-user',
        activeState: 'inactive',
        subState: 'dead',
        running: false,
        mainPid: null,
      },
      assignmentCount: 1,
      snapshotStale: false,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'local-llm-model-missing',
    );
  });
});
