import fs from 'fs';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  countAdminUsers,
  createAdminSession,
  createAdminWebChatMessage,
  createTask,
  createProducedWorkItem,
  deleteAdminSessionByTokenHash,
  deleteExpiredAdminSessions,
  deleteOfficeTeam,
  deleteRegisteredGroup,
  deleteSession,
  deleteTask,
  getAdminSessionByTokenHash,
  getAdminUserByUsername,
  getAdminWebChatMessages,
  getAllChats,
  getAllRegisteredGroups,
  getRegisteredGroupAssignments,
  getAllTasks,
  getDueTasks,
  getLatestMessageSeqAtOrBefore,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getOpenWorkItem,
  getRegisteredGroup,
  getRegisteredAgentTypesForJid,
  getMessagesSince,
  getNewMessages,
  getOfficeTeams,
  isPairedRoomJid,
  getSession,
  getTaskById,
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  setSession,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  touchAdminSession,
  touchAdminUserLogin,
  updateTask,
  upsertAdminUser,
  upsertOfficeTeam,
} from './db.js';
import {
  resolveTaskRuntimeIpcPath,
  resolveTaskSessionsPath,
} from './group-folder.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });

  it('preserves non-empty content when a duplicate write arrives blank', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-race',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: '@징징이 안녕',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-race',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: '',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('@징징이 안녕');
  });

  it('upgrades blank duplicate content when a later write has real content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-race-upgrade',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: '',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-race-upgrade',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: '@징징이 안녕',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('@징징이 안녕');
  });
});

describe('admin auth accessors', () => {
  it('upserts admin users by username', () => {
    const first = upsertAdminUser({
      username: 'admin',
      passwordHash: 'hash-1',
    });
    const second = upsertAdminUser({
      username: 'admin',
      passwordHash: 'hash-2',
    });

    expect(countAdminUsers()).toBe(1);
    expect(first.username).toBe('admin');
    expect(second.password_hash).toBe('hash-2');
    expect(getAdminUserByUsername('admin')?.password_hash).toBe('hash-2');
  });

  it('creates, looks up, touches, and deletes admin sessions', () => {
    const user = upsertAdminUser({
      username: 'captain',
      passwordHash: 'hash-bridge',
    });
    const session = createAdminSession({
      userId: user.id,
      tokenHash: 'token-hash',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    expect(getAdminSessionByTokenHash('token-hash')?.username).toBe('captain');

    touchAdminSession(session.id);
    touchAdminUserLogin(user.id);

    expect(getAdminSessionByTokenHash('token-hash')?.last_used_at).toBeTruthy();
    expect(getAdminUserByUsername('captain')?.last_login_at).toBeTruthy();

    deleteAdminSessionByTokenHash('token-hash');
    expect(getAdminSessionByTokenHash('token-hash')).toBeUndefined();
  });

  it('deletes expired admin sessions without touching active ones', () => {
    const user = upsertAdminUser({
      username: 'ops',
      passwordHash: 'hash-ops',
    });
    createAdminSession({
      userId: user.id,
      tokenHash: 'expired-token',
      expiresAt: '2024-01-01T00:00:00.000Z',
    });
    createAdminSession({
      userId: user.id,
      tokenHash: 'active-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    deleteExpiredAdminSessions('2025-01-01T00:00:00.000Z');

    expect(getAdminSessionByTokenHash('expired-token')).toBeUndefined();
    expect(getAdminSessionByTokenHash('active-token')).toBeTruthy();
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('bot reply');
    expect(msgs[1].content).toBe('third');
  });

  it('includes bot messages from other senders', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(1);
    expect(botMsgs[0].is_bot_message).toBe(true);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    expect(msgs).toHaveLength(4);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(4);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('bot reply');
    expect(messages[1].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

describe('session accessors', () => {
  it('deletes only the current service session for a group', () => {
    setSession('group-a', 'session-123');
    expect(getSession('group-a')).toBe('session-123');

    deleteSession('group-a');
    expect(getSession('group-a')).toBeUndefined();
  });

  it('isolates sessions by service id', () => {
    setSession('group-a', 'session-primary', 'primary');
    setSession('group-a', 'session-voice', 'voice');

    expect(getSession('group-a', 'primary')).toBe('session-primary');
    expect(getSession('group-a', 'voice')).toBe('session-voice');

    deleteSession('group-a', 'voice');
    expect(getSession('group-a', 'primary')).toBe('session-primary');
    expect(getSession('group-a', 'voice')).toBeUndefined();
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('stores and updates GitHub CI task metadata', () => {
    createTask({
      id: 'task-github',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({ repo: 'owner/repo', run_id: 123456 }),
      prompt: 'github watcher',
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(getTaskById('task-github')?.ci_provider).toBe('github');
    expect(getTaskById('task-github')?.ci_metadata).toContain('owner/repo');

    updateTask('task-github', {
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 123456,
        poll_count: 2,
      }),
    });

    expect(getTaskById('task-github')?.ci_metadata).toContain('"poll_count":2');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });

  it('deletes task-scoped IPC and session directories when removing a task', () => {
    const taskId = 'task-cleanup';
    const groupFolder = 'cleanup-group';
    const runtimeIpcDir = resolveTaskRuntimeIpcPath(groupFolder, taskId);
    const taskSessionsDir = resolveTaskSessionsPath(groupFolder, taskId);

    fs.rmSync(runtimeIpcDir, { recursive: true, force: true });
    fs.rmSync(taskSessionsDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeIpcDir, { recursive: true });
    fs.mkdirSync(taskSessionsDir, { recursive: true });

    createTask({
      id: taskId,
      group_folder: groupFolder,
      chat_jid: 'group@g.us',
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
cleanup

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask(taskId);

    expect(fs.existsSync(runtimeIpcDir)).toBe(false);
    expect(fs.existsSync(taskSessionsDir)).toBe(false);
  });

  it('returns due tasks only for the requested agent type', () => {
    const dueAt = new Date(Date.now() - 1_000).toISOString();

    createTask({
      id: 'task-claude',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      agent_type: 'claude-code',
      prompt: 'claude task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-codex',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      agent_type: 'codex',
      prompt: 'codex task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2024-01-01T00:00:01.000Z',
    });

    expect(getDueTasks('claude-code').map((task) => task.id)).toEqual([
      'task-claude',
    ]);
    expect(getDueTasks('codex').map((task) => task.id)).toEqual(['task-codex']);
  });

  it('isolates tasks by service id even for the same agent type', () => {
    const dueAt = new Date(Date.now() - 1_000).toISOString();

    createTask({
      id: 'task-primary',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      service_id: 'primary',
      agent_type: 'claude-code',
      prompt: 'primary task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-voice',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      service_id: 'voice',
      agent_type: 'claude-code',
      prompt: 'voice task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2024-01-01T00:00:01.000Z',
    });

    expect(
      getDueTasks('claude-code', 'primary').map((task) => task.id),
    ).toEqual(['task-primary']);
    expect(getDueTasks('claude-code', 'voice').map((task) => task.id)).toEqual([
      'task-voice',
    ]);
    expect(getAllTasks(undefined, { allServices: true })).toHaveLength(2);
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('dc:main', {
      name: 'Main Chat',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['dc:main'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('discord_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'discord_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });

  it('filters duplicate jid registrations by agent type', () => {
    setRegisteredGroup('dc:shared', {
      name: 'Shared Room Claude',
      folder: 'shared-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'claude',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:shared', {
      name: 'Shared Room Codex',
      folder: 'shared-room-codex',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'codex',
      agentType: 'codex',
    });

    const claudeGroups = getAllRegisteredGroups({
      serviceId: 'claude',
      agentType: 'claude-code',
    });
    const codexGroups = getAllRegisteredGroups({
      serviceId: 'codex',
      agentType: 'codex',
    });

    expect(claudeGroups['dc:shared']?.agentType).toBe('claude-code');
    expect(claudeGroups['dc:shared']?.name).toBe('Shared Room Claude');
    expect(codexGroups['dc:shared']?.agentType).toBe('codex');
    expect(codexGroups['dc:shared']?.name).toBe('Shared Room Codex');
  });

  it('isolates duplicate jid registrations by service id', () => {
    setRegisteredGroup('dc:shared', {
      name: 'Primary Room',
      folder: 'shared-primary',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'primary',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:shared', {
      name: 'Voice Room',
      folder: 'shared-voice',
      trigger: '@Nova',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'voice',
      agentType: 'claude-code',
    });

    const primaryGroup = getRegisteredGroup('dc:shared', {
      serviceId: 'primary',
    });
    const voiceGroup = getRegisteredGroup('dc:shared', { serviceId: 'voice' });

    expect(primaryGroup?.folder).toBe('shared-primary');
    expect(voiceGroup?.folder).toBe('shared-voice');
  });

  it('lists assignments across all services with chat metadata', () => {
    storeChatMetadata(
      'dc:999',
      '2024-01-01T01:00:00.000Z',
      'Launch Bay',
      'discord',
      true,
    );
    setRegisteredGroup('dc:999', {
      name: 'Launch Bay',
      folder: 'launch-bay',
      trigger: '@Andy',
      added_at: '2024-01-01T01:00:00.000Z',
      serviceId: 'assistant',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:999', {
      name: 'Launch Bay Codex',
      folder: 'launch-bay-codex',
      trigger: '@Codex',
      added_at: '2024-01-01T01:00:00.000Z',
      serviceId: 'codex',
      agentType: 'codex',
    });

    const assignments = getRegisteredGroupAssignments({ allServices: true });

    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.jid).toBe('dc:999');
    expect(assignments[0]?.channel).toBe('discord');
    expect(assignments[0]?.isGroup).toBe(true);
    expect(
      assignments.map((assignment) => assignment.serviceId).sort(),
    ).toEqual(['assistant', 'codex']);
  });

  it('deletes only the targeted service assignment', () => {
    setRegisteredGroup('dc:shared', {
      name: 'Shared Room Claude',
      folder: 'shared-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'claude',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:shared', {
      name: 'Shared Room Codex',
      folder: 'shared-room-codex',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'codex',
      agentType: 'codex',
    });

    deleteRegisteredGroup('dc:shared', 'codex');

    expect(
      getRegisteredGroup('dc:shared', { serviceId: 'codex' }),
    ).toBeUndefined();
    expect(getRegisteredGroup('dc:shared', { serviceId: 'claude' })?.name).toBe(
      'Shared Room Claude',
    );
  });
});

describe('paired room registration', () => {
  it('detects when both Claude and Codex are registered on the same jid', () => {
    setRegisteredGroup('dc:123', {
      name: 'Paired Room Claude',
      folder: 'paired-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'claude',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:123', {
      name: 'Paired Room Codex',
      folder: 'paired-codex',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      serviceId: 'codex',
      agentType: 'codex',
    });

    expect(getRegisteredAgentTypesForJid('dc:123').sort()).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(isPairedRoomJid('dc:123')).toBe(true);
  });

  it('does not mark solo rooms as paired', () => {
    setRegisteredGroup('dc:solo', {
      name: 'Solo Claude Room',
      folder: 'solo-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });

    expect(getRegisteredAgentTypesForJid('dc:solo')).toEqual(['claude-code']);
    expect(isPairedRoomJid('dc:solo')).toBe(false);
  });
});

describe('message seq cursors', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'seq-1',
      chat_jid: 'group@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'seq-2',
      chat_jid: 'group@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    store({
      id: 'seq-3',
      chat_jid: 'group@g.us',
      sender: 'carol',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
  });

  it('assigns monotonic seq values and preserves them on upsert', () => {
    const { messages } = getNewMessagesBySeq(['group@g.us'], 0, 'Andy');
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    store({
      id: 'seq-2',
      chat_jid: 'group@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'second updated',
      timestamp: '2024-01-01T00:00:02.500Z',
    });

    const afterUpdate = getMessagesSinceSeq('group@g.us', 0, 'Andy');
    expect(afterUpdate.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(afterUpdate[1].content).toBe('second updated');
  });

  it('maps legacy timestamp cursors to the latest seq at or before that time', () => {
    expect(
      getLatestMessageSeqAtOrBefore('2024-01-01T00:00:02.000Z', 'group@g.us'),
    ).toBe(2);
  });
});

describe('work items', () => {
  it('tracks produced, retry, and delivered states', () => {
    const item = createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:123',
      agent_type: 'claude-code',
      start_seq: 10,
      end_seq: 12,
      result_payload: 'hello',
    });

    expect(getOpenWorkItem('dc:123', 'claude-code')?.id).toBe(item.id);

    markWorkItemDeliveryRetry(item.id, 'send failed');
    const retried = getOpenWorkItem('dc:123', 'claude-code');
    expect(retried?.status).toBe('delivery_retry');
    expect(retried?.delivery_attempts).toBe(1);
    expect(retried?.last_error).toBe('send failed');

    markWorkItemDelivered(item.id, 'msg-1');
    expect(getOpenWorkItem('dc:123', 'claude-code')).toBeUndefined();
  });

  it('isolates work items by service id', () => {
    createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:123',
      service_id: 'primary',
      agent_type: 'claude-code',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'primary',
    });
    createProducedWorkItem({
      group_folder: 'discord_test',
      chat_jid: 'dc:123',
      service_id: 'voice',
      agent_type: 'claude-code',
      start_seq: 3,
      end_seq: 4,
      result_payload: 'voice',
    });

    expect(
      getOpenWorkItem('dc:123', 'claude-code', 'primary')?.result_payload,
    ).toBe('primary');
    expect(
      getOpenWorkItem('dc:123', 'claude-code', 'voice')?.result_payload,
    ).toBe('voice');
  });
});

describe('office teams', () => {
  it('stores and updates office team metadata', () => {
    upsertOfficeTeam({
      team_id: 'platform',
      name: 'Platform Team',
      linked_jid: 'dc:platform',
      color: '#ffbf69',
    });

    expect(getOfficeTeams()).toHaveLength(1);
    expect(getOfficeTeams()[0].name).toBe('Platform Team');

    upsertOfficeTeam({
      team_id: 'platform',
      name: 'Platform Ops',
      linked_jid: 'dc:platform',
      color: '#58d4ba',
    });

    expect(getOfficeTeams()[0].name).toBe('Platform Ops');

    deleteOfficeTeam('platform');
    expect(getOfficeTeams()).toHaveLength(0);
  });
});

describe('admin web chat messages', () => {
  it('stores per-service chat history in order', () => {
    createAdminWebChatMessage({
      service_id: 'claude',
      role: 'user',
      content: 'hello',
    });
    createAdminWebChatMessage({
      service_id: 'claude',
      role: 'assistant',
      content: 'hi',
    });
    createAdminWebChatMessage({
      service_id: 'codex',
      role: 'user',
      content: 'separate',
    });

    const claudeMessages = getAdminWebChatMessages('claude');
    expect(claudeMessages).toHaveLength(2);
    expect(claudeMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(getAdminWebChatMessages('codex')).toHaveLength(1);
  });
});
