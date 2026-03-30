import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { getBooleanEnv, getEnv, reloadEnvFile } from './env.js';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.TEST_EMPTY;
  delete process.env.TEST_BOOL;
  delete process.env.HKCLAW_SERVICE_ENV_PATH;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  reloadEnvFile();
});

describe('env helpers', () => {
  it('preserves empty values from .env', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-env-'));
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'TEST_EMPTY=\nTEST_BOOL=false\n',
      'utf-8',
    );

    process.chdir(tempDir);
    reloadEnvFile();

    expect(getEnv('TEST_EMPTY')).toBe('');
    expect(getBooleanEnv('TEST_EMPTY')).toBeUndefined();
    expect(getBooleanEnv('TEST_BOOL')).toBe(false);
  });

  it('prefers process.env even when the value is empty', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-env-'));
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'TEST_EMPTY=file-value\n',
      'utf-8',
    );

    process.chdir(tempDir);
    process.env.TEST_EMPTY = '';
    reloadEnvFile();

    expect(getEnv('TEST_EMPTY')).toBe('');
  });

  it('uses the current service overlay as the sole source for service-scoped keys', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-env-'));
    const serviceEnvPath = path.join(tempDir, '.env.agent.worker');
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'CLAUDE_CODE_OAUTH_TOKEN=base-token\n',
      'utf-8',
    );
    fs.writeFileSync(serviceEnvPath, '', 'utf-8');

    process.chdir(tempDir);
    process.env.HKCLAW_SERVICE_ENV_PATH = serviceEnvPath;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'process-token';
    reloadEnvFile();

    expect(getEnv('CLAUDE_CODE_OAUTH_TOKEN')).toBeUndefined();
  });
});
