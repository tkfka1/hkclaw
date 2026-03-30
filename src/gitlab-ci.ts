import { extractWatchCiTarget } from './task-watch-status.js';
import type { ScheduledTask } from './types.js';

export interface GitLabCiMetadata {
  project: string;
  pipeline_id?: number;
  job_id?: number;
  base_url?: string;
  poll_count?: number;
  consecutive_errors?: number;
  last_checked_at?: string;
}

interface GitLabPipelineResponse {
  id?: number | null;
  status?: string | null;
  ref?: string | null;
  sha?: string | null;
  source?: string | null;
  web_url?: string | null;
  name?: string | null;
}

interface GitLabJobResponse {
  id?: number | null;
  status?: string | null;
  name?: string | null;
  stage?: string | null;
  ref?: string | null;
  web_url?: string | null;
}

export interface GitLabCiCheckResult {
  terminal: boolean;
  resultSummary: string;
  completionMessage?: string;
}

export const MAX_GITLAB_CONSECUTIVE_ERRORS = 5;
export const GITLAB_WATCH_BACKOFF_STEPS = [
  { afterMs: 60 * 60 * 1000, delayMs: 60_000 },
  { afterMs: 10 * 60 * 1000, delayMs: 30_000 },
] as const;

function getGitLabBaseUrl(metadata: GitLabCiMetadata): string {
  const raw =
    metadata.base_url || process.env.GITLAB_BASE_URL || 'https://gitlab.com';
  return raw.replace(/\/+$/, '');
}

function getGitLabHeaders(): Record<string, string> {
  const privateToken =
    process.env.GITLAB_TOKEN ||
    process.env.GITLAB_PAT ||
    process.env.GITLAB_PRIVATE_TOKEN;
  if (privateToken) {
    return { 'PRIVATE-TOKEN': privateToken };
  }

  const jobToken = process.env.CI_JOB_TOKEN;
  if (jobToken) {
    return { 'JOB-TOKEN': jobToken };
  }

  throw new Error(
    'GitLab API token is missing. Set GITLAB_TOKEN, GITLAB_PAT, GITLAB_PRIVATE_TOKEN, or CI_JOB_TOKEN.',
  );
}

async function fetchGitLabJson<T>(
  metadata: GitLabCiMetadata,
  apiPath: string,
): Promise<T> {
  const response = await fetch(
    `${getGitLabBaseUrl(metadata)}/api/v4${apiPath}`,
    {
      headers: {
        Accept: 'application/json',
        ...getGitLabHeaders(),
      },
    },
  );

  if (!response.ok) {
    const details = (await response.text()).trim() || `HTTP ${response.status}`;
    throw new Error(`GitLab API failed: ${details}`);
  }

  return (await response.json()) as T;
}

function getTargetKind(metadata: GitLabCiMetadata): 'pipeline' | 'job' {
  return metadata.job_id ? 'job' : 'pipeline';
}

function getTargetId(metadata: GitLabCiMetadata): number {
  return metadata.job_id || metadata.pipeline_id || 0;
}

function getTargetLabel(metadata: GitLabCiMetadata): string {
  return `GitLab ${getTargetKind(metadata)} ${getTargetId(metadata)}`;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function formatStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'success':
      return '성공';
    case 'failed':
      return '실패';
    case 'canceled':
    case 'cancelled':
      return '취소됨';
    case 'skipped':
      return '건너뜀';
    case 'manual':
      return '수동 대기';
    default:
      return status || '완료';
  }
}

function isTerminalStatus(status: string | null | undefined): boolean {
  return [
    'success',
    'failed',
    'canceled',
    'cancelled',
    'skipped',
    'manual',
  ].includes(status || '');
}

export function parseGitLabCiMetadata(
  raw: string | null | undefined,
): GitLabCiMetadata | null {
  if (!raw) return null;

  let parsed: Partial<GitLabCiMetadata>;
  try {
    parsed = JSON.parse(raw) as Partial<GitLabCiMetadata>;
  } catch {
    return null;
  }

  if (typeof parsed.project !== 'string' || parsed.project.trim() === '') {
    return null;
  }

  const pipelineId = Number(parsed.pipeline_id);
  const jobId = Number(parsed.job_id);
  if (!isPositiveInteger(pipelineId) && !isPositiveInteger(jobId)) {
    return null;
  }

  return {
    project: parsed.project,
    pipeline_id: isPositiveInteger(pipelineId) ? pipelineId : undefined,
    job_id: isPositiveInteger(jobId) ? jobId : undefined,
    base_url:
      typeof parsed.base_url === 'string' && parsed.base_url.trim() !== ''
        ? parsed.base_url
        : undefined,
    poll_count:
      Number.isInteger(parsed.poll_count) && parsed.poll_count! >= 0
        ? parsed.poll_count
        : undefined,
    consecutive_errors:
      Number.isInteger(parsed.consecutive_errors) &&
      parsed.consecutive_errors! >= 0
        ? parsed.consecutive_errors
        : undefined,
    last_checked_at:
      typeof parsed.last_checked_at === 'string' &&
      parsed.last_checked_at.trim() !== ''
        ? parsed.last_checked_at
        : undefined,
  };
}

export function serializeGitLabCiMetadata(metadata: GitLabCiMetadata): string {
  return JSON.stringify(metadata);
}

export function computeGitLabWatcherDelayMs(
  task: Pick<ScheduledTask, 'schedule_value' | 'created_at'>,
  nowMs: number,
): number {
  const baseDelayMs = Number.parseInt(task.schedule_value, 10);
  const normalizedBaseDelayMs =
    Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 15_000;

  const createdAtMs = new Date(task.created_at).getTime();
  const elapsedMs = Number.isFinite(createdAtMs)
    ? Math.max(0, nowMs - createdAtMs)
    : 0;

  for (const step of GITLAB_WATCH_BACKOFF_STEPS) {
    if (elapsedMs >= step.afterMs) {
      return Math.max(normalizedBaseDelayMs, step.delayMs);
    }
  }

  return normalizedBaseDelayMs;
}

async function fetchFailedPipelineJobs(
  metadata: GitLabCiMetadata,
): Promise<string[]> {
  const jobs = await fetchGitLabJson<Array<GitLabJobResponse>>(
    metadata,
    `/projects/${encodeURIComponent(metadata.project)}/pipelines/${metadata.pipeline_id}/jobs?per_page=100`,
  );

  return jobs
    .filter((job) =>
      ['failed', 'canceled', 'cancelled'].includes(job.status || ''),
    )
    .map((job) => job.name?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);
}

export async function checkGitLabCiStatus(
  task: Pick<ScheduledTask, 'prompt' | 'ci_metadata'>,
): Promise<GitLabCiCheckResult> {
  const metadata = parseGitLabCiMetadata(task.ci_metadata);
  if (!metadata) {
    throw new Error('Task is missing valid GitLab CI metadata');
  }

  const target = extractWatchCiTarget(task.prompt) || getTargetLabel(metadata);

  if (metadata.job_id) {
    const job = await fetchGitLabJson<GitLabJobResponse>(
      metadata,
      `/projects/${encodeURIComponent(metadata.project)}/jobs/${metadata.job_id}`,
    );
    const status = job.status || 'unknown';

    if (!isTerminalStatus(status)) {
      return {
        terminal: false,
        resultSummary: `GitLab job ${metadata.job_id} is ${status}`,
      };
    }

    const lines = [
      `CI 완료: ${target}`,
      `판정: ${formatStatusLabel(status)}`,
      `- 프로젝트: ${metadata.project}`,
    ];
    if (job.name) {
      lines.push(`- Job: ${job.name}`);
    }
    if (job.stage) {
      lines.push(`- Stage: ${job.stage}`);
    }
    if (job.ref) {
      lines.push(`- 브랜치: ${job.ref}`);
    }
    if (job.web_url) {
      lines.push(`- 링크: ${job.web_url}`);
    }

    return {
      terminal: true,
      resultSummary: `${formatStatusLabel(status)}: ${metadata.project} job ${metadata.job_id}`,
      completionMessage: lines.join('\n'),
    };
  }

  const pipeline = await fetchGitLabJson<GitLabPipelineResponse>(
    metadata,
    `/projects/${encodeURIComponent(metadata.project)}/pipelines/${metadata.pipeline_id}`,
  );
  const status = pipeline.status || 'unknown';

  if (!isTerminalStatus(status)) {
    return {
      terminal: false,
      resultSummary: `GitLab pipeline ${metadata.pipeline_id} is ${status}`,
    };
  }

  let failedJobs: string[] = [];
  try {
    failedJobs = await fetchFailedPipelineJobs(metadata);
  } catch {
    failedJobs = [];
  }

  const lines = [
    `CI 완료: ${target}`,
    `판정: ${formatStatusLabel(status)}`,
    `- 프로젝트: ${metadata.project}`,
  ];
  if (pipeline.name) {
    lines.push(`- 파이프라인: ${pipeline.name}`);
  }
  if (pipeline.ref) {
    lines.push(`- 브랜치: ${pipeline.ref}`);
  }
  if (failedJobs.length > 0) {
    lines.push(`- 실패 job: ${failedJobs.join(', ')}`);
  }
  if (pipeline.web_url) {
    lines.push(`- 링크: ${pipeline.web_url}`);
  }

  return {
    terminal: true,
    resultSummary: `${formatStatusLabel(status)}: ${metadata.project} pipeline ${metadata.pipeline_id}`,
    completionMessage: lines.join('\n'),
  };
}
