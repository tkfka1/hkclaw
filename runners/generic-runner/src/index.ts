import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: string;
  memoryBriefing?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  phase?: 'progress' | 'final';
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---HKCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HKCLAW_OUTPUT_END---';
const GROUP_DIR = process.env.HKCLAW_GROUP_DIR || '/workspace/group';
const WORK_DIR = process.env.HKCLAW_WORK_DIR || '';
const EFFECTIVE_CWD = WORK_DIR || GROUP_DIR;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[generic-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function buildPrompt(input: ContainerInput): string {
  return [process.env.HKCLAW_SYSTEM_PROMPT, input.memoryBriefing, input.prompt]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join('\n\n---\n\n')
    .trim();
}

async function runGeminiCli(prompt: string): Promise<ContainerOutput> {
  const command = process.env.GEMINI_CLI_PATH || 'gemini';
  const args = ['-p', prompt, '--output-format', 'json'];
  if (process.env.GEMINI_MODEL) {
    args.push('-m', process.env.GEMINI_MODEL);
  }

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: EFFECTIVE_CWD,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      resolve({
        status: 'error',
        result: null,
        error: `Failed to start Gemini CLI: ${error.message}`,
      });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({
          status: 'error',
          result: null,
          error:
            stderr.trim() ||
            stdout.trim() ||
            `Gemini CLI exited with code ${code ?? 'unknown'}`,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          status: 'error',
          result: null,
          error: 'Gemini CLI returned an empty response.',
        });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as {
          responseJson?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          text?: string;
        };
        const result =
          parsed.text ||
          parsed.responseJson?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || '')
            .join('\n')
            .trim() ||
          trimmed;
        resolve({
          status: 'success',
          result,
          phase: 'final',
        });
      } catch {
        resolve({
          status: 'success',
          result: trimmed,
          phase: 'final',
        });
      }
    });
  });
}

async function runLocalLlm(prompt: string): Promise<ContainerOutput> {
  const baseUrl =
    (process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(
      /\/$/,
      '',
    );
  const model = process.env.LOCAL_LLM_MODEL || '';
  const apiKey = process.env.LOCAL_LLM_API_KEY || '';

  if (!model) {
    return {
      status: 'error',
      result: null,
      error: 'LOCAL_LLM_MODEL is required for local-llm services.',
    };
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string } | string;
      choices?: Array<{ message?: { content?: string } }>;
    };

    if (!response.ok) {
      const errorMessage =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message || `HTTP ${response.status}`;
      return {
        status: 'error',
        result: null,
        error: errorMessage,
      };
    }

    const result = payload.choices?.[0]?.message?.content?.trim();
    if (!result) {
      return {
        status: 'error',
        result: null,
        error: 'Local LLM returned an empty response.',
      };
    }

    return {
      status: 'success',
      result,
      phase: 'final',
    };
  } catch (error) {
    return {
      status: 'error',
      result: null,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown local LLM request failure',
    };
  }
}

async function main(): Promise<void> {
  try {
    const rawInput = await readStdin();
    const input = JSON.parse(rawInput) as ContainerInput;
    const agentType = process.env.HKCLAW_AGENT_TYPE || input.agentType || '';
    const prompt = buildPrompt(input);

    fs.mkdirSync(path.join(EFFECTIVE_CWD, '.hkclaw-runner'), { recursive: true });

    const output =
      agentType === 'gemini-cli'
        ? await runGeminiCli(prompt)
        : agentType === 'local-llm'
          ? await runLocalLlm(prompt)
          : {
              status: 'error' as const,
              result: null,
              error: `Unsupported generic runner agent type: ${agentType}`,
            };

    writeOutput(output);
  } catch (error) {
    log(error instanceof Error ? error.stack || error.message : String(error));
    writeOutput({
      status: 'error',
      result: null,
      error:
        error instanceof Error ? error.message : 'Unknown generic runner failure',
    });
    process.exitCode = 1;
  }
}

void main();
