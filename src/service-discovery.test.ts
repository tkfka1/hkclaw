import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverConfiguredServices } from './service-discovery.js';
import { parseAgentType, parseServiceRole } from './service-metadata.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-service-'));
  tempDirs.push(dir);
  for (const [filePath, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filePath), content, 'utf-8');
  }
  return dir;
}

describe('service discovery', () => {
  it('skips the primary service when base env has no service config', () => {
    const projectRoot = createProject({
      '.env': '',
    });

    expect(discoverConfiguredServices(projectRoot)).toEqual([]);
  });

  it('discovers primary, legacy codex, and agent overlays', () => {
    const projectRoot = createProject({
      '.env': 'ASSISTANT_NAME=Claude\nSERVICE_ROLE=normal\n',
      '.env.codex': 'DISCORD_BOT_TOKEN=codex-token\nASSISTANT_NAME=Codex\n',
      '.env.agent.ops': [
        'ASSISTANT_NAME=Nova Ops',
        'SERVICE_AGENT_TYPE=claude',
        'SERVICE_ROLE=normal',
      ].join('\n'),
    });

    const services = discoverConfiguredServices(projectRoot);

    expect(services.map((service) => service.serviceName)).toEqual([
      'hkclaw',
      'hkclaw-codex',
      'hkclaw-ops',
    ]);
    expect(services.map((service) => service.serviceId)).toEqual([
      'claude',
      'codex',
      'ops',
    ]);
    expect(services.map((service) => service.role)).toEqual([
      'normal',
      'normal',
      'normal',
    ]);
    expect(services.map((service) => service.agentType)).toEqual([
      'claude-code',
      'codex',
      'claude-code',
    ]);
  });

  it('rejects duplicate service ids', () => {
    const projectRoot = createProject({
      '.env': 'ASSISTANT_NAME=Claude\nSERVICE_ID=primary\n',
      '.env.agent.ops': 'SERVICE_ID=primary\nSERVICE_AGENT_TYPE=claude\n',
    });

    expect(() => discoverConfiguredServices(projectRoot)).toThrow(
      'Duplicate SERVICE_ID detected: primary',
    );
  });
});

describe('service metadata helpers', () => {
  it('accepts claude as an agent type alias', () => {
    expect(parseAgentType('claude')).toBe('claude-code');
  });

  it('normalizes usage aliases into service roles', () => {
    expect(parseServiceRole('text-chat')).toBe('normal');
    expect(parseServiceRole('voice-chat')).toBe('normal');
    expect(parseServiceRole('assistant')).toBe('normal');
  });

  it('uses .env.primary when present', () => {
    const projectRoot = createProject({
      '.env': 'GROQ_API_KEY=test\nASSISTANT_NAME=Base\nSERVICE_ROLE=normal\n',
      '.env.primary': [
        'ASSISTANT_NAME=Prime',
        'SERVICE_ID=prime',
        'SERVICE_AGENT_TYPE=claude',
        'SERVICE_ROLE=normal',
      ].join('\n'),
    });

    const [primary] = discoverConfiguredServices(projectRoot);

    expect(primary?.serviceId).toBe('prime');
    expect(primary?.assistantName).toBe('Prime');
    expect(primary?.role).toBe('normal');
    expect(primary?.envOverlayPath).toBe(
      path.join(projectRoot, '.env.primary'),
    );
  });

  it('uses the primary service id as the legacy fallback assistant name', () => {
    const projectRoot = createProject({
      '.env': ['SERVICE_ID=frontdesk', 'SERVICE_ROLE=normal', ''].join('\n'),
    });

    const [primary] = discoverConfiguredServices(projectRoot);

    expect(primary?.serviceId).toBe('frontdesk');
    expect(primary?.assistantName).toBe('frontdesk');
  });
});
