import { randomUUID } from 'crypto';

import { ASSISTANT_NAME, SERVICE_AGENT_TYPE, SERVICE_ID } from './config.js';
import {
  deleteSession,
  getAllRegisteredGroups,
  getAllSessions,
  initDatabase,
  setSession,
} from './db.js';
import { runAgentForGroup } from './message-agent-executor.js';
import type { AgentOutput } from './agent-runner.js';
import type { RegisteredGroup } from './types.js';

interface WorkerInput {
  prompt: string;
  chatJid?: string;
  group?: Omit<RegisteredGroup, 'serviceId' | 'agentType'>;
}

async function readStdin(): Promise<WorkerInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? (JSON.parse(raw) as WorkerInput) : { prompt: '' };
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.prompt?.trim()) {
    process.stdout.write(
      JSON.stringify({ status: 'error', error: 'Prompt is required' }),
    );
    return;
  }

  initDatabase();

  const chatJid = input.chatJid?.trim() || `admin:web:${SERVICE_ID}`;
  const defaultDeskName =
    SERVICE_ID === 'admin-web' ? 'Admin Desk' : `${ASSISTANT_NAME} Desk`;
  const group: RegisteredGroup = input.group
    ? {
        ...input.group,
        serviceId: SERVICE_ID,
        agentType: SERVICE_AGENT_TYPE,
      }
    : {
        name: defaultDeskName,
        folder: `web-${SERVICE_ID}`,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        serviceId: SERVICE_ID,
        agentType: SERVICE_AGENT_TYPE,
      };

  let finalOutput: AgentOutput | null = null;
  const sessions = () => getAllSessions(SERVICE_ID);

  const result = await runAgentForGroup(
    {
      assistantName: ASSISTANT_NAME,
      queue: {
        registerProcess: () => undefined,
      },
      getRegisteredGroups: () =>
        getAllRegisteredGroups({ serviceId: SERVICE_ID }),
      getSessions: sessions,
      persistSession: (folder, sessionId) => {
        setSession(folder, sessionId, SERVICE_ID);
      },
      clearSession: (folder) => {
        deleteSession(folder, SERVICE_ID);
      },
    },
    {
      group,
      prompt: input.prompt.trim(),
      chatJid,
      runId: `admin-chat-${randomUUID()}`,
      onOutput: async (output) => {
        finalOutput = output;
      },
    },
  );
  const output = finalOutput as AgentOutput | null;

  if (result === 'success') {
    process.stdout.write(
      JSON.stringify({
        status: 'success',
        reply: output?.result || '',
      }),
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      status: 'error',
      error: output?.error || 'Agent execution failed',
    }),
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = 1;
});
