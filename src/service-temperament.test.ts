import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyServiceTemperament,
  assignServiceTemperament,
  deleteTemperamentDefinition,
  getServiceTemperament,
  getTemperamentDefinitionStorePath,
  listTemperaments,
  upsertTemperamentDefinition,
} from './service-temperament.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-temperament-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

describe('temperament definitions', () => {
  it('persists custom temperament definitions', () => {
    const projectRoot = createProjectRoot();

    upsertTemperamentDefinition({
      projectRoot,
      temperamentId: 'critic',
      name: 'critic',
      prompt: 'Be severe.',
    });

    expect(fs.existsSync(getTemperamentDefinitionStorePath(projectRoot))).toBe(
      true,
    );
    expect(
      listTemperaments(projectRoot).find(
        (entry) => entry.temperamentId === 'critic',
      ),
    ).toMatchObject({
      temperamentId: 'critic',
      name: 'critic',
      prompt: 'Be severe.',
    });
  });

  it('deletes custom temperament definitions', () => {
    const projectRoot = createProjectRoot();

    upsertTemperamentDefinition({
      projectRoot,
      temperamentId: 'critic',
      name: 'critic',
      prompt: 'Be severe.',
    });
    deleteTemperamentDefinition(projectRoot, 'critic');

    expect(
      listTemperaments(projectRoot).find(
        (entry) => entry.temperamentId === 'critic',
      ),
    ).toBeUndefined();
  });
});

describe('service temperament assignments', () => {
  it('resolves assigned temperament prompt from the definition library', () => {
    const projectRoot = createProjectRoot();

    upsertTemperamentDefinition({
      projectRoot,
      temperamentId: 'critic',
      name: 'critic',
      prompt: 'Be severe.',
    });
    assignServiceTemperament({
      projectRoot,
      serviceId: 'nova',
      temperamentId: 'critic',
    });

    expect(getServiceTemperament(projectRoot, 'nova')).toMatchObject({
      serviceId: 'nova',
      temperamentId: 'critic',
      temperamentName: 'critic',
      prompt: 'Be severe.',
    });
  });

  it('falls back to normal when the assignment is cleared', () => {
    const projectRoot = createProjectRoot();

    assignServiceTemperament({
      projectRoot,
      serviceId: 'nova',
      temperamentId: 'normal',
    });

    expect(getServiceTemperament(projectRoot, 'nova')).toMatchObject({
      serviceId: 'nova',
      temperamentId: 'normal',
      prompt: '',
    });
  });
});

describe('applyServiceTemperament', () => {
  it('wraps prompts when a temperament prompt is configured', () => {
    const next = applyServiceTemperament('Handle the request.', {
      temperamentId: 'analyst',
      prompt: 'Be terse and highly structured.',
    });

    expect(next).toContain('[SERVICE TEMPERAMENT]');
    expect(next).toContain('Temperament: analyst');
    expect(next).toContain('Handle the request.');
  });

  it('keeps prompts unchanged when temperament prompt is empty', () => {
    expect(
      applyServiceTemperament('Handle the request.', {
        temperamentId: 'normal',
        prompt: '',
      }),
    ).toBe('Handle the request.');
  });
});
