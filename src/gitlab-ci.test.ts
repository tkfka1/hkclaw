import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkGitLabCiStatus,
  parseGitLabCiMetadata,
  serializeGitLabCiMetadata,
} from './gitlab-ci.js';

describe('gitlab-ci helpers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    process.env.GITLAB_TOKEN = 'test-token';
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.GITLAB_TOKEN;
  });

  it('round-trips GitLab pipeline metadata', () => {
    const raw = serializeGitLabCiMetadata({
      project: 'group/project',
      pipeline_id: 123,
      poll_count: 1,
    });

    expect(parseGitLabCiMetadata(raw)).toEqual({
      project: 'group/project',
      pipeline_id: 123,
      job_id: undefined,
      base_url: undefined,
      poll_count: 1,
      consecutive_errors: undefined,
      last_checked_at: undefined,
    });
    expect(parseGitLabCiMetadata('{"project":"","pipeline_id":0}')).toBeNull();
  });

  it('returns non-terminal status for running pipelines', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'running',
      }),
    });

    await expect(
      checkGitLabCiStatus({
        prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitLab pipeline 123

Check instructions:
Managed by host-driven watcher.
        `.trim(),
        ci_metadata: JSON.stringify({
          project: 'group/project',
          pipeline_id: 123,
        }),
      }),
    ).resolves.toEqual({
      terminal: false,
      resultSummary: 'GitLab pipeline 123 is running',
    });
  });

  it('renders a concise completion message for failed pipelines', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'failed',
          name: 'deploy',
          ref: 'main',
          web_url: 'https://gitlab.example.com/group/project/-/pipelines/456',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'build', status: 'success' },
          { name: 'test', status: 'failed' },
        ],
      });

    const result = await checkGitLabCiStatus({
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitLab pipeline 456

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      ci_metadata: JSON.stringify({
        project: 'group/project',
        pipeline_id: 456,
        base_url: 'https://gitlab.example.com',
      }),
    });

    expect(result.terminal).toBe(true);
    expect(result.resultSummary).toContain('실패');
    expect(result.completionMessage).toContain('CI 완료: GitLab pipeline 456');
    expect(result.completionMessage).toContain('판정: 실패');
    expect(result.completionMessage).toContain('- 실패 job: test');
  });

  it('renders a concise completion message for successful jobs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        name: 'unit-test',
        stage: 'test',
        ref: 'main',
        web_url: 'https://gitlab.example.com/group/project/-/jobs/789',
      }),
    });

    const result = await checkGitLabCiStatus({
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitLab job 789

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      ci_metadata: JSON.stringify({
        project: 'group/project',
        job_id: 789,
        base_url: 'https://gitlab.example.com',
      }),
    });

    expect(result.terminal).toBe(true);
    expect(result.resultSummary).toContain('성공');
    expect(result.completionMessage).toContain('- Job: unit-test');
    expect(result.completionMessage).toContain('- Stage: test');
  });
});
