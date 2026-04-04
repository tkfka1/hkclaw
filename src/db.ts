import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  SERVICE_AGENT_TYPE,
  SERVICE_ID,
  STORE_DIR,
} from './config.js';
import {
  isValidGroupFolder,
  resolveTaskRuntimeIpcPath as resolveTaskRuntimeIpcPathFromGroup,
  resolveTaskSessionsPath as resolveTaskSessionsPathFromGroup,
} from './group-folder.js';
import { logger } from './logger.js';
import { getLegacyServiceIdByAgentType } from './service-discovery.js';
import { getTaskRuntimeTaskId } from './task-watch-status.js';
import {
  NewMessage,
  AgentType,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import { readJsonFile } from './utils.js';

let db: Database.Database;

export interface WorkItem {
  id: number;
  group_folder: string;
  chat_jid: string;
  service_id?: string;
  agent_type: AgentType;
  status: 'produced' | 'delivery_retry' | 'delivered';
  start_seq: number | null;
  end_seq: number | null;
  result_payload: string;
  delivery_attempts: number;
  delivery_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

interface RegisteredGroupQuery {
  serviceId?: string;
  agentType?: string;
}

interface RegisteredGroupAssignmentQuery {
  serviceId?: string;
  allServices?: boolean;
}

interface TaskQueryOptions {
  serviceId?: string;
  allServices?: boolean;
}

function backfillMessageSeq(database: Database.Database): void {
  const rows = database
    .prepare(
      `SELECT rowid, seq
       FROM messages
       ORDER BY CASE WHEN seq IS NULL THEN 1 ELSE 0 END, seq, timestamp, rowid`,
    )
    .all() as Array<{ rowid: number; seq: number | null }>;

  if (rows.length === 0) {
    return;
  }

  let nextSeq = 1;
  const assignSeq = database.prepare(
    'UPDATE messages SET seq = ? WHERE rowid = ? AND seq IS NULL',
  );
  const tx = database.transaction(() => {
    for (const row of rows) {
      if (row.seq === null) {
        assignSeq.run(nextSeq, row.rowid);
      }
      nextSeq = Math.max(nextSeq, (row.seq ?? nextSeq) + 1);
    }
  });
  tx();

  const maxSeqRow = database
    .prepare('SELECT MAX(seq) AS maxSeq FROM messages')
    .get() as { maxSeq: number | null };
  const maxSeq = maxSeqRow.maxSeq ?? 0;
  if (maxSeq > 0) {
    database
      .prepare('INSERT OR IGNORE INTO message_sequence (id) VALUES (?)')
      .run(maxSeq);
  }
}

function getLegacyServiceIdMap(): Record<AgentType, string> {
  try {
    return getLegacyServiceIdByAgentType(process.cwd());
  } catch (err) {
    logger.warn({ err }, 'Falling back to default legacy service id mapping');
    return {
      'claude-code':
        SERVICE_AGENT_TYPE === 'claude-code' ? SERVICE_ID : 'assistant',
      codex: SERVICE_AGENT_TYPE === 'codex' ? SERVICE_ID : 'codex',
      'gemini-cli': SERVICE_AGENT_TYPE === 'gemini-cli' ? SERVICE_ID : 'gemini',
      'local-llm':
        SERVICE_AGENT_TYPE === 'local-llm' ? SERVICE_ID : 'local-llm',
    };
  }
}

function createSchema(database: Database.Database): void {
  const legacyServiceIds = getLegacyServiceIdMap();
  const legacyServiceIdSql = (agentTypeExpr: string): string => `
    CASE COALESCE(${agentTypeExpr}, 'claude-code')
      WHEN 'codex' THEN '${legacyServiceIds.codex}'
      ELSE '${legacyServiceIds['claude-code']}'
    END
  `;

  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      seq INTEGER,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE TABLE IF NOT EXISTS message_sequence (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      service_id TEXT NOT NULL DEFAULT 'assistant',
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'produced',
      start_seq INTEGER,
      end_seq INTEGER,
      result_payload TEXT NOT NULL,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      CHECK (status IN ('produced', 'delivery_retry', 'delivered'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent ON work_items(chat_jid, service_id, agent_type, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, service_id, agent_type)
      WHERE status IN ('produced', 'delivery_retry');

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      service_id TEXT NOT NULL DEFAULT 'assistant',
      agent_type TEXT,
      ci_provider TEXT,
      ci_metadata TEXT,
      max_duration_ms INTEGER,
      status_message_id TEXT,
      status_started_at TEXT,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      service_id TEXT NOT NULL DEFAULT 'assistant',
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, service_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT NOT NULL,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      agent_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      service_id TEXT NOT NULL DEFAULT 'assistant',
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      work_dir TEXT,
      PRIMARY KEY (jid, service_id),
      UNIQUE (folder, service_id)
    );
    CREATE TABLE IF NOT EXISTS office_teams (
      team_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      linked_jid TEXT UNIQUE,
      folder TEXT,
      requires_mention INTEGER DEFAULT 1,
      layout_left REAL,
      layout_top REAL,
      layout_width REAL,
      layout_height REAL,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS office_company_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name TEXT,
      office_title TEXT,
      office_subtitle TEXT,
      room_layouts_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_web_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (role IN ('user', 'assistant', 'system', 'error'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_web_chat_messages_service
      ON admin_web_chat_messages(service_id, id);

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
      ON admin_sessions(expires_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN agent_type TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN ci_provider TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN ci_metadata TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN status_message_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN status_started_at TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN suspended_until TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN service_id TEXT DEFAULT '${legacyServiceIds['claude-code']}'`,
    );
  } catch {
    /* column already exists */
  }

  database.exec(`
    UPDATE scheduled_tasks
    SET agent_type = COALESCE(
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE jid = scheduled_tasks.chat_jid
          AND folder = scheduled_tasks.group_folder
      ),
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE jid = scheduled_tasks.chat_jid
      ),
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE folder = scheduled_tasks.group_folder
      )
    )
    WHERE agent_type IS NULL;
  `);

  database.exec(`
    UPDATE scheduled_tasks
    SET service_id = COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql('agent_type')})
    WHERE service_id IS NULL OR service_id = '';
  `);

  try {
    database.exec(
      `ALTER TABLE work_items ADD COLUMN service_id TEXT DEFAULT '${legacyServiceIds['claude-code']}'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE office_teams ADD COLUMN folder TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE office_teams ADD COLUMN requires_mention INTEGER DEFAULT 1`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE office_teams ADD COLUMN layout_left REAL`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE office_teams ADD COLUMN layout_top REAL`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE office_teams ADD COLUMN layout_width REAL`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE office_teams ADD COLUMN layout_height REAL`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE office_company_settings ADD COLUMN room_layouts_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  database.exec(`
    UPDATE work_items
    SET service_id = COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql('agent_type')})
    WHERE service_id IS NULL OR service_id = '';
  `);

  database.exec(`
    DROP INDEX IF EXISTS idx_work_items_status;
    DROP INDEX IF EXISTS idx_work_items_group_agent;
    DROP INDEX IF EXISTS idx_work_items_open;
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent
      ON work_items(chat_jid, service_id, agent_type, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, service_id, agent_type)
      WHERE status IN ('produced', 'delivery_retry');
  `);

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
  } catch {
    /* column already exists */
  }

  backfillMessageSeq(database);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_jid_seq ON messages(chat_jid, seq);
  `);

  // Migrate registered_groups to composite keys so Claude/Codex can share a jid/folder.
  const registeredGroupsSql = (
    database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registered_groups'`,
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (
    registeredGroupsSql &&
    !registeredGroupsSql.includes('PRIMARY KEY (jid, service_id)')
  ) {
    const registeredGroupCols = database
      .prepare('PRAGMA table_info(registered_groups)')
      .all() as Array<{ name: string }>;
    const hasIsMain = registeredGroupCols.some((col) => col.name === 'is_main');
    const hasServiceId = registeredGroupCols.some(
      (col) => col.name === 'service_id',
    );
    const hasAgentType = registeredGroupCols.some(
      (col) => col.name === 'agent_type',
    );
    const hasWorkDir = registeredGroupCols.some(
      (col) => col.name === 'work_dir',
    );
    const hasAgentConfig = registeredGroupCols.some(
      (col) => col.name === 'agent_config',
    );
    const hasContainerConfig = registeredGroupCols.some(
      (col) => col.name === 'container_config',
    );

    database.exec(`
      CREATE TABLE registered_groups_new (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        service_id TEXT NOT NULL DEFAULT '${legacyServiceIds['claude-code']}',
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, service_id),
        UNIQUE (folder, service_id)
      );
    `);

    database.exec(`
      INSERT INTO registered_groups_new (
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        agent_config,
        requires_trigger,
        is_main,
        service_id,
        agent_type,
        work_dir
      )
      SELECT
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        ${
          hasAgentConfig
            ? 'agent_config'
            : hasContainerConfig
              ? 'container_config'
              : 'NULL'
        },
        requires_trigger,
        ${hasIsMain ? 'COALESCE(is_main, 0)' : "CASE WHEN folder = 'main' THEN 1 ELSE 0 END"},
        ${
          hasServiceId
            ? `COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql(hasAgentType ? 'agent_type' : "'claude-code'")})`
            : legacyServiceIdSql(hasAgentType ? 'agent_type' : "'claude-code'")
        },
        ${hasAgentType ? "COALESCE(agent_type, 'claude-code')" : "'claude-code'"},
        ${hasWorkDir ? 'work_dir' : 'NULL'}
      FROM registered_groups;
    `);

    database.exec(`
      DROP TABLE registered_groups;
      ALTER TABLE registered_groups_new RENAME TO registered_groups;
    `);
  } else {
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main' AND COALESCE(is_main, 0) = 0`,
    );
    database.exec(`
      UPDATE registered_groups
      SET service_id = COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql('agent_type')})
      WHERE service_id IS NULL OR service_id = '';
    `);
  }

  const registeredGroupCols = database
    .prepare('PRAGMA table_info(registered_groups)')
    .all() as Array<{ name: string }>;
  const hasAgentConfig = registeredGroupCols.some(
    (col) => col.name === 'agent_config',
  );
  const hasContainerConfig = registeredGroupCols.some(
    (col) => col.name === 'container_config',
  );
  const hasRegisteredServiceId = registeredGroupCols.some(
    (col) => col.name === 'service_id',
  );
  if (!hasAgentConfig) {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN agent_config TEXT`);
  }
  if (!hasRegisteredServiceId) {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN service_id TEXT DEFAULT '${legacyServiceIds['claude-code']}'`,
    );
    database.exec(`
      UPDATE registered_groups
      SET service_id = COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql('agent_type')})
      WHERE service_id IS NULL OR service_id = '';
    `);
  }
  if (hasContainerConfig) {
    database.exec(
      `UPDATE registered_groups
       SET agent_config = COALESCE(agent_config, container_config)
       WHERE container_config IS NOT NULL`,
    );
  }

  // Migrate sessions table to composite PK (group_folder, service_id)
  const sessionsSql = (
    database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  const sessionCols = database
    .prepare('PRAGMA table_info(sessions)')
    .all() as Array<{ name: string }>;
  const hasSessionServiceId = sessionCols.some(
    (col) => col.name === 'service_id',
  );
  const hasSessionAgentType = sessionCols.some(
    (col) => col.name === 'agent_type',
  );
  if (
    !sessionsSql ||
    !sessionsSql.includes('PRIMARY KEY (group_folder, service_id)')
  ) {
    database.exec(`
      CREATE TABLE sessions_new (
        group_folder TEXT NOT NULL,
        service_id TEXT NOT NULL DEFAULT '${legacyServiceIds['claude-code']}',
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        session_id TEXT NOT NULL,
        PRIMARY KEY (group_folder, service_id)
      );
    `);
    database
      .prepare(
        `INSERT INTO sessions_new (group_folder, service_id, agent_type, session_id)
         SELECT
           group_folder,
           ${
             hasSessionServiceId
               ? `COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql(hasSessionAgentType ? 'agent_type' : "'claude-code'")})`
               : legacyServiceIdSql(
                   hasSessionAgentType ? 'agent_type' : "'claude-code'",
                 )
           },
           ${hasSessionAgentType ? "COALESCE(agent_type, 'claude-code')" : "'claude-code'"},
           session_id
         FROM sessions`,
      )
      .run();
    database.exec(`
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  } else {
    database.exec(`
      UPDATE sessions
      SET service_id = COALESCE(NULLIF(service_id, ''), ${legacyServiceIdSql('agent_type')})
      WHERE service_id IS NULL OR service_id = '';
    `);
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export interface RegisteredGroupAssignment extends RegisteredGroup {
  jid: string;
  channel: string | null;
  isGroup: boolean;
  lastMessageTime: string | null;
}

export interface OfficeTeam {
  team_id: string;
  name: string;
  linked_jid: string | null;
  folder: string | null;
  requires_mention: number | null;
  layout_left: number | null;
  layout_top: number | null;
  layout_width: number | null;
  layout_height: number | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfficeCompanySettings {
  company_name: string | null;
  office_title: string | null;
  office_subtitle: string | null;
  room_layouts_json: string | null;
  updated_at: string;
}

export interface AdminWebChatMessage {
  id: number;
  service_id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  created_at: string;
}

export interface AdminUser {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface AdminSession {
  id: number;
  user_id: number;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

export interface AdminSessionWithUser extends AdminSession {
  username: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  const nextSeq = () => {
    const result = db
      .prepare('INSERT INTO message_sequence DEFAULT VALUES')
      .run() as Database.RunResult;
    return Number(result.lastInsertRowid);
  };

  db.transaction(() => {
    const existing = db
      .prepare('SELECT seq FROM messages WHERE id = ? AND chat_jid = ?')
      .get(msg.id, msg.chat_jid) as { seq: number | null } | undefined;
    const seq = existing?.seq ?? nextSeq();
    db.prepare(
      `INSERT INTO messages (
         id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, chat_jid) DO UPDATE SET
         sender = excluded.sender,
         sender_name = excluded.sender_name,
         content = COALESCE(NULLIF(excluded.content, ''), messages.content),
         timestamp = excluded.timestamp,
         is_from_me = excluded.is_from_me,
         is_bot_message = excluded.is_bot_message`,
    ).run(
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      seq,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
    );
  })();
}

function normalizeMessageRow(
  row: NewMessage & {
    is_from_me?: boolean | number;
    is_bot_message?: boolean | number;
  },
): NewMessage {
  return {
    ...row,
    is_from_me: !!row.is_from_me,
    is_bot_message: !!row.is_bot_message,
  };
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter legacy prefixed outbound messages as a backstop for rows written
  // before explicit bot flags existed. Self-message filtering is channel-specific
  // and happens in message-runtime so cross-bot collaboration still works.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows.map(normalizeMessageRow), newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter legacy prefixed outbound messages as a backstop for rows written
  // before explicit bot flags existed. Self-message filtering is channel-specific
  // and happens in message-runtime so cross-bot collaboration still works.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

function normalizeSeqCursor(
  cursor: string | number | null | undefined,
): number {
  if (typeof cursor === 'number') {
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getLatestMessageSeqAtOrBefore(
  timestamp: string,
  chatJid?: string,
): number {
  if (!timestamp) return 0;
  const row = (
    chatJid
      ? db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM messages
           WHERE chat_jid = ? AND timestamp <= ?`,
          )
          .get(chatJid, timestamp)
      : db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM messages
           WHERE timestamp <= ?`,
          )
          .get(timestamp)
  ) as { maxSeq: number | null };
  return row.maxSeq ?? 0;
}

export function getNewMessagesBySeq(
  jids: string[],
  lastSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newSeqCursor: string } {
  const sinceSeq = normalizeSeqCursor(lastSeqCursor);
  if (jids.length === 0) {
    return { messages: [], newSeqCursor: String(sinceSeq) };
  }

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
    FROM messages
    WHERE seq > ? AND chat_jid IN (${placeholders})
      AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(sinceSeq, ...jids, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;

  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : sinceSeq;
  return {
    messages: rows.map(normalizeMessageRow),
    newSeqCursor: String(lastSeq),
  };
}

export function getMessagesSinceSeq(
  chatJid: string,
  sinceSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  const sinceSeq = normalizeSeqCursor(sinceSeqCursor);
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND seq > ?
      AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceSeq, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

export function getRecentMessages(
  chatJid: string,
  limit: number = 120,
): NewMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
         FROM messages
         WHERE chat_jid = ?
           AND content != '' AND content IS NOT NULL
         ORDER BY seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    )
    .all(chatJid, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

export function getLastHumanMessageTimestamp(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT timestamp FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

export function hasRecentRestartAnnouncement(
  chatJid: string,
  sinceTimestamp: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ?
         AND timestamp >= ?
         AND is_bot_message = 1
         AND (
           content LIKE '재시작 완료.%'
           OR content LIKE '재시작 감지.%'
           OR content LIKE '서비스 재시작으로 이전 작업이 중단됐습니다.%'
         )
       LIMIT 1`,
    )
    .get(chatJid, sinceTimestamp) as { 1: number } | undefined;
  return !!row;
}

export function getOpenWorkItem(
  chatJid: string,
  agentType: AgentType = SERVICE_AGENT_TYPE,
  serviceId: string = SERVICE_ID,
): WorkItem | undefined {
  return db
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ? AND service_id = ? AND agent_type = ? AND status IN ('produced', 'delivery_retry')
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(chatJid, serviceId, agentType) as WorkItem | undefined;
}

export function createProducedWorkItem(input: {
  group_folder: string;
  chat_jid: string;
  service_id?: string;
  agent_type?: AgentType;
  start_seq: number | null;
  end_seq: number | null;
  result_payload: string;
}): WorkItem {
  const now = new Date().toISOString();
  const serviceId = input.service_id || SERVICE_ID;
  const agentType = input.agent_type || SERVICE_AGENT_TYPE;
  const result = db
    .prepare(
      `INSERT INTO work_items (
         group_folder,
         chat_jid,
         service_id,
         agent_type,
         status,
         start_seq,
         end_seq,
         result_payload,
         delivery_attempts,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'produced', ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.group_folder,
      input.chat_jid,
      serviceId,
      agentType,
      input.start_seq,
      input.end_seq,
      input.result_payload,
      now,
      now,
    ) as Database.RunResult;

  return db
    .prepare('SELECT * FROM work_items WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as WorkItem;
}

export function markWorkItemDelivered(
  id: number,
  deliveryMessageId?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE work_items
     SET status = 'delivered',
         delivered_at = ?,
         delivery_message_id = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, deliveryMessageId || null, now, id);
}

export function markWorkItemDeliveryRetry(id: number, error: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE work_items
     SET status = 'delivery_retry',
         delivery_attempts = delivery_attempts + 1,
         last_error = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(error, now, id);
}

export function createTask(
  task: Omit<
    ScheduledTask,
    | 'last_run'
    | 'last_result'
    | 'service_id'
    | 'agent_type'
    | 'ci_provider'
    | 'ci_metadata'
    | 'max_duration_ms'
    | 'status_message_id'
    | 'status_started_at'
  > & {
    service_id?: string | null;
    agent_type?: AgentType | null;
    ci_provider?: ScheduledTask['ci_provider'];
    ci_metadata?: string | null;
    max_duration_ms?: number | null;
    status_message_id?: string | null;
    status_started_at?: string | null;
  },
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, service_id, agent_type, ci_provider, ci_metadata, max_duration_ms, status_message_id, status_started_at, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.service_id || SERVICE_ID,
    task.agent_type || SERVICE_AGENT_TYPE,
    task.ci_provider ?? null,
    task.ci_metadata ?? null,
    task.max_duration_ms ?? null,
    task.status_message_id || null,
    task.status_started_at || null,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

/**
 * Find an existing active/paused CI watcher for the same channel + provider + metadata.
 * Used to prevent duplicate watchers when both agents register for the same CI run.
 */
export function findDuplicateCiWatcher(
  chatJid: string,
  ciProvider: string,
  ciMetadata: string,
): ScheduledTask | undefined {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE chat_jid = ? AND ci_provider = ? AND ci_metadata = ?
         AND status IN ('active', 'paused')
       LIMIT 1`,
    )
    .get(chatJid, ciProvider, ciMetadata) as ScheduledTask | undefined;
}

export function getTasksForGroup(
  groupFolder: string,
  agentType?: AgentType,
  options: TaskQueryOptions = {},
): ScheduledTask[] {
  const serviceId = options.serviceId || SERVICE_ID;
  if (agentType) {
    return db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE group_folder = ? AND service_id = ? AND agent_type = ?
         ORDER BY created_at DESC`,
      )
      .all(groupFolder, serviceId, agentType) as ScheduledTask[];
  }

  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE group_folder = ? AND service_id = ?
       ORDER BY created_at DESC`,
    )
    .all(groupFolder, serviceId) as ScheduledTask[];
}

export function getAllTasks(
  agentType?: AgentType,
  options: TaskQueryOptions = {},
): ScheduledTask[] {
  const includeAllServices = options.allServices === true;
  const serviceId = options.serviceId || SERVICE_ID;

  if (agentType && includeAllServices) {
    return db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE agent_type = ? ORDER BY created_at DESC',
      )
      .all(agentType) as ScheduledTask[];
  }

  if (agentType) {
    return db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE service_id = ? AND agent_type = ?
         ORDER BY created_at DESC`,
      )
      .all(serviceId, agentType) as ScheduledTask[];
  }

  if (includeAllServices) {
    return db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
      .all() as ScheduledTask[];
  }

  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE service_id = ? ORDER BY created_at DESC',
    )
    .all(serviceId) as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'suspended_until'
      | 'ci_metadata'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.suspended_until !== undefined) {
    fields.push('suspended_until = ?');
    values.push(updates.suspended_until);
  }
  if (updates.ci_metadata !== undefined) {
    fields.push('ci_metadata = ?');
    values.push(updates.ci_metadata);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function updateTaskStatusTracking(
  id: string,
  updates: Partial<
    Pick<ScheduledTask, 'status_message_id' | 'status_started_at'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status_message_id !== undefined) {
    fields.push('status_message_id = ?');
    values.push(updates.status_message_id);
  }
  if (updates.status_started_at !== undefined) {
    fields.push('status_started_at = ?');
    values.push(updates.status_started_at);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  const task = getTaskById(id);
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);

  if (!task) return;

  const runtimeTaskId = getTaskRuntimeTaskId(task);
  if (!runtimeTaskId) return;

  const cleanupTargets = [];
  try {
    cleanupTargets.push(
      resolveTaskRuntimeIpcPathFromGroup(task.group_folder, runtimeTaskId),
      resolveTaskSessionsPathFromGroup(task.group_folder, runtimeTaskId),
    );
  } catch (err) {
    logger.warn(
      { taskId: id, groupFolder: task.group_folder, err },
      'Failed to resolve task-scoped cleanup paths',
    );
    return;
  }

  for (const cleanupPath of cleanupTargets) {
    try {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { taskId: id, cleanupPath, err },
        'Failed to remove task-scoped runtime artifacts',
      );
    }
  }
}

export function getDueTasks(
  agentType: AgentType = SERVICE_AGENT_TYPE,
  serviceId: string = SERVICE_ID,
): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND service_id = ? AND agent_type = ? AND next_run IS NOT NULL AND next_run <= ?
      AND (suspended_until IS NULL OR suspended_until <= ?)
    ORDER BY next_run
  `,
    )
    .all(serviceId, agentType, now, now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getRecentConsecutiveErrors(
  taskId: string,
  limit: number = 5,
): string[] {
  const rows = db
    .prepare(
      `SELECT status, error FROM task_run_logs
       WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as Array<{ status: string; error: string | null }>;

  const errors: string[] = [];
  for (const row of rows) {
    if (row.status !== 'error' || !row.error) break;
    errors.push(row.error);
  }
  return errors;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const prefixedKey = `${SERVICE_ID}:${key}`;
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(prefixedKey) as { value: string } | undefined;
  if (row) return row.value;

  // Lazy migration: read unprefixed key and migrate to prefixed
  const old = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (old) {
    db.prepare(
      'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    ).run(prefixedKey, old.value);
    db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
    return old.value;
  }
  return undefined;
}

export function setRouterState(key: string, value: string): void {
  const prefixedKey = `${SERVICE_ID}:${key}`;
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(prefixedKey, value);
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  serviceId: string = SERVICE_ID,
): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND service_id = ?',
    )
    .get(groupFolder, serviceId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  serviceId: string = SERVICE_ID,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, service_id, agent_type, session_id) VALUES (?, ?, ?, ?)',
  ).run(groupFolder, serviceId, SERVICE_AGENT_TYPE, sessionId);
}

export function deleteSession(
  groupFolder: string,
  serviceId: string = SERVICE_ID,
): void {
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND service_id = ?',
  ).run(groupFolder, serviceId);
}

export function getAllSessions(
  serviceId: string = SERVICE_ID,
): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT group_folder, session_id FROM sessions WHERE service_id = ?',
    )
    .all(serviceId) as Array<{
    group_folder: string;
    session_id: string;
  }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

function mapRegisteredGroupRow(row: {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  agent_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  service_id: string | null;
  agent_type: string | null;
  work_dir: string | null;
}): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    serviceId: row.service_id || undefined,
    agentType: (row.agent_type as RegisteredGroup['agentType']) || undefined,
    workDir: row.work_dir || undefined,
  };
}

export function getRegisteredGroup(
  jid: string,
  query: RegisteredGroupQuery = {},
): (RegisteredGroup & { jid: string }) | undefined {
  const serviceId = query.serviceId || SERVICE_ID;
  const row = (
    query.agentType
      ? db
          .prepare(
            `SELECT * FROM registered_groups
             WHERE jid = ? AND service_id = ? AND agent_type = ?`,
          )
          .get(jid, serviceId, query.agentType)
      : db
          .prepare(
            'SELECT * FROM registered_groups WHERE jid = ? AND service_id = ?',
          )
          .get(jid, serviceId)
  ) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        agent_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        service_id: string | null;
        agent_type: string | null;
        work_dir: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return mapRegisteredGroupRow(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, agent_config, requires_trigger, is_main, service_id, agent_type, work_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.agentConfig ? JSON.stringify(group.agentConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.serviceId || SERVICE_ID,
    group.agentType || SERVICE_AGENT_TYPE,
    group.workDir || null,
  );
}

export function deleteRegisteredGroup(
  jid: string,
  serviceId: string = SERVICE_ID,
): void {
  db.prepare(
    'DELETE FROM registered_groups WHERE jid = ? AND service_id = ?',
  ).run(jid, serviceId);
}

export function updateRegisteredGroupName(jid: string, name: string): void {
  db.prepare('UPDATE registered_groups SET name = ? WHERE jid = ?').run(
    name,
    jid,
  );
}

export function getAllRegisteredGroups(
  query: RegisteredGroupQuery = {},
): Record<string, RegisteredGroup> {
  const serviceId = query.serviceId || SERVICE_ID;
  const rows = (
    query.agentType
      ? db
          .prepare(
            `SELECT * FROM registered_groups
             WHERE service_id = ? AND agent_type = ?`,
          )
          .all(serviceId, query.agentType)
      : db
          .prepare('SELECT * FROM registered_groups WHERE service_id = ?')
          .all(serviceId)
  ) as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    agent_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    service_id: string | null;
    agent_type: string | null;
    work_dir: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = mapRegisteredGroupRow(row);
  }
  return result;
}

export function getRegisteredGroupAssignments(
  query: RegisteredGroupAssignmentQuery = {},
): RegisteredGroupAssignment[] {
  const includeAllServices = query.allServices === true;
  const serviceId = query.serviceId || SERVICE_ID;
  const rows = (
    includeAllServices
      ? db
          .prepare(
            `SELECT rg.*, ch.channel AS chat_channel, ch.is_group AS chat_is_group,
                    ch.last_message_time AS chat_last_message_time
             FROM registered_groups rg
             LEFT JOIN chats ch ON ch.jid = rg.jid
             ORDER BY COALESCE(ch.last_message_time, rg.added_at) DESC,
                      rg.name ASC,
                      rg.service_id ASC`,
          )
          .all()
      : db
          .prepare(
            `SELECT rg.*, ch.channel AS chat_channel, ch.is_group AS chat_is_group,
                    ch.last_message_time AS chat_last_message_time
             FROM registered_groups rg
             LEFT JOIN chats ch ON ch.jid = rg.jid
             WHERE rg.service_id = ?
             ORDER BY COALESCE(ch.last_message_time, rg.added_at) DESC,
                      rg.name ASC,
                      rg.service_id ASC`,
          )
          .all(serviceId)
  ) as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    agent_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    service_id: string | null;
    agent_type: string | null;
    work_dir: string | null;
    chat_channel: string | null;
    chat_is_group: number | null;
    chat_last_message_time: string | null;
  }>;

  return rows
    .filter((row) => {
      if (isValidGroupFolder(row.folder)) return true;
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group assignment with invalid folder',
      );
      return false;
    })
    .map((row) => ({
      ...mapRegisteredGroupRow(row),
      channel: row.chat_channel,
      isGroup: row.chat_is_group === 1,
      lastMessageTime: row.chat_last_message_time,
    }));
}

export function getRegisteredGroupServiceCount(jid: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT service_id) AS count
       FROM registered_groups
       WHERE jid = ?`,
    )
    .get(jid) as { count: number | null } | undefined;
  return row?.count ?? 0;
}

export function getRegisteredAgentTypesForJid(jid: string): AgentType[] {
  if (!db) return [];

  const rows = db
    .prepare('SELECT agent_type FROM registered_groups WHERE jid = ?')
    .all(jid) as Array<{ agent_type: string | null }>;

  const types = new Set<AgentType>();
  for (const row of rows) {
    const agentType = row.agent_type as AgentType | null;
    if (agentType === 'claude-code' || agentType === 'codex') {
      types.add(agentType);
    }
  }
  return [...types];
}

export function isPairedRoomJid(jid: string): boolean {
  const types = getRegisteredAgentTypesForJid(jid);
  return types.includes('claude-code') && types.includes('codex');
}

// --- Office team accessors ---

export function getOfficeTeams(): OfficeTeam[] {
  return db
    .prepare(
      `SELECT team_id, name, linked_jid, folder, requires_mention, layout_left, layout_top, layout_width, layout_height, color, created_at, updated_at
       FROM office_teams
       ORDER BY created_at ASC, name ASC`,
    )
    .all() as OfficeTeam[];
}

export function getOfficeTeam(teamId: string): OfficeTeam | undefined {
  return db
    .prepare(
      `SELECT team_id, name, linked_jid, folder, requires_mention, layout_left, layout_top, layout_width, layout_height, color, created_at, updated_at
       FROM office_teams
       WHERE team_id = ?`,
    )
    .get(teamId) as OfficeTeam | undefined;
}

export function upsertOfficeTeam(input: {
  team_id: string;
  name: string;
  linked_jid?: string | null;
  folder?: string | null;
  requires_mention?: boolean | null;
  layout_left?: number | null;
  layout_top?: number | null;
  layout_width?: number | null;
  layout_height?: number | null;
  color?: string | null;
}): OfficeTeam {
  const now = new Date().toISOString();
  const existing = getOfficeTeam(input.team_id);
  db.prepare(
    `INSERT INTO office_teams (
       team_id,
       name,
       linked_jid,
       folder,
       requires_mention,
       layout_left,
       layout_top,
       layout_width,
       layout_height,
       color,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       name = excluded.name,
       linked_jid = excluded.linked_jid,
       folder = excluded.folder,
       requires_mention = excluded.requires_mention,
       layout_left = excluded.layout_left,
       layout_top = excluded.layout_top,
       layout_width = excluded.layout_width,
       layout_height = excluded.layout_height,
       color = excluded.color,
       updated_at = excluded.updated_at`,
  ).run(
    input.team_id,
    input.name,
    input.linked_jid || null,
    input.folder || null,
    input.requires_mention === null
      ? null
      : input.requires_mention === undefined
        ? 1
        : input.requires_mention
          ? 1
          : 0,
    input.layout_left ?? null,
    input.layout_top ?? null,
    input.layout_width ?? null,
    input.layout_height ?? null,
    input.color || null,
    existing?.created_at || now,
    now,
  );
  return getOfficeTeam(input.team_id)!;
}

export function deleteOfficeTeam(teamId: string): void {
  db.prepare('DELETE FROM office_teams WHERE team_id = ?').run(teamId);
}

export function getOfficeCompanySettings(): OfficeCompanySettings | null {
  return (
    (db
      .prepare(
        `SELECT company_name, office_title, office_subtitle, room_layouts_json, updated_at
         FROM office_company_settings
         WHERE id = 1`,
      )
      .get() as OfficeCompanySettings | undefined) || null
  );
}

export function upsertOfficeCompanySettings(input: {
  company_name?: string | null;
  office_title?: string | null;
  office_subtitle?: string | null;
  room_layouts_json?: string | null;
}): OfficeCompanySettings {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO office_company_settings (
       id,
       company_name,
       office_title,
       office_subtitle,
       room_layouts_json,
       updated_at
     ) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       company_name = excluded.company_name,
       office_title = excluded.office_title,
       office_subtitle = excluded.office_subtitle,
       room_layouts_json = excluded.room_layouts_json,
       updated_at = excluded.updated_at`,
  ).run(
    input.company_name || null,
    input.office_title || null,
    input.office_subtitle || null,
    input.room_layouts_json ?? null,
    now,
  );
  return getOfficeCompanySettings()!;
}

export function renameGroupFolderReferences(args: {
  oldFolder: string;
  newFolder: string;
  serviceIds: string[];
  chatJid?: string | null;
}): void {
  if (!db) return;

  const serviceIds = [...new Set(args.serviceIds.filter(Boolean))];
  if (!serviceIds.length || args.oldFolder === args.newFolder) {
    return;
  }

  const placeholders = serviceIds.map(() => '?').join(', ');
  const withChatFilter = args.chatJid ? ' AND chat_jid = ?' : '';
  const withJidFilter = args.chatJid ? ' AND jid = ?' : '';

  const runParams = (base: unknown[]): unknown[] =>
    args.chatJid ? [...base, args.chatJid] : base;

  db.transaction(() => {
    db.prepare(
      `UPDATE registered_groups
       SET folder = ?
       WHERE folder = ?
         AND service_id IN (${placeholders})${withJidFilter}`,
    ).run(...runParams([args.newFolder, args.oldFolder, ...serviceIds]));

    db.prepare(
      `UPDATE sessions
       SET group_folder = ?
       WHERE group_folder = ?
         AND service_id IN (${placeholders})`,
    ).run(args.newFolder, args.oldFolder, ...serviceIds);

    db.prepare(
      `UPDATE scheduled_tasks
       SET group_folder = ?
       WHERE group_folder = ?
         AND service_id IN (${placeholders})${withChatFilter}`,
    ).run(...runParams([args.newFolder, args.oldFolder, ...serviceIds]));

    db.prepare(
      `UPDATE work_items
       SET group_folder = ?
       WHERE group_folder = ?
         AND service_id IN (${placeholders})${withChatFilter}`,
    ).run(...runParams([args.newFolder, args.oldFolder, ...serviceIds]));
  })();
}

// --- Admin web chat accessors ---

export function createAdminWebChatMessage(input: {
  service_id?: string;
  role: AdminWebChatMessage['role'];
  content: string;
}): AdminWebChatMessage {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO admin_web_chat_messages (
         service_id,
         role,
         content,
         created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(input.service_id || SERVICE_ID, input.role, input.content, now) as
    | Database.RunResult
    | undefined;

  return db
    .prepare('SELECT * FROM admin_web_chat_messages WHERE id = ?')
    .get(Number(result?.lastInsertRowid || 0)) as AdminWebChatMessage;
}

export function getAdminWebChatMessages(
  serviceId: string = SERVICE_ID,
  limit: number = 120,
): AdminWebChatMessage[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT id, service_id, role, content, created_at
         FROM admin_web_chat_messages
         WHERE service_id = ?
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`,
    )
    .all(serviceId, limit) as AdminWebChatMessage[];
}

// --- Admin auth accessors ---

export function getAdminUserByUsername(
  username: string,
): AdminUser | undefined {
  return db
    .prepare(
      `SELECT id, username, password_hash, created_at, updated_at, last_login_at
       FROM admin_users
       WHERE username = ?`,
    )
    .get(username) as AdminUser | undefined;
}

export function countAdminUsers(): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM admin_users').get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

export function upsertAdminUser(input: {
  username: string;
  passwordHash: string;
}): AdminUser {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO admin_users (username, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       password_hash = excluded.password_hash,
       updated_at = excluded.updated_at`,
  ).run(input.username, input.passwordHash, now, now);

  return getAdminUserByUsername(input.username)!;
}

export function touchAdminUserLogin(userId: number): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE admin_users
     SET last_login_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, now, userId);
}

export function createAdminSession(input: {
  userId: number;
  tokenHash: string;
  expiresAt: string;
}): AdminSession {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO admin_sessions (
         user_id,
         token_hash,
         created_at,
         expires_at,
         last_used_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.userId, input.tokenHash, now, input.expiresAt, now) as
    | Database.RunResult
    | undefined;

  return db
    .prepare(
      `SELECT id, user_id, token_hash, created_at, expires_at, last_used_at
       FROM admin_sessions
       WHERE id = ?`,
    )
    .get(Number(result?.lastInsertRowid || 0)) as AdminSession;
}

export function getAdminSessionByTokenHash(
  tokenHash: string,
): AdminSessionWithUser | undefined {
  return db
    .prepare(
      `SELECT
         s.id,
         s.user_id,
         s.token_hash,
         s.created_at,
         s.expires_at,
         s.last_used_at,
         u.username
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as AdminSessionWithUser | undefined;
}

export function touchAdminSession(sessionId: number): void {
  db.prepare(
    `UPDATE admin_sessions
     SET last_used_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), sessionId);
}

export function deleteAdminSessionByTokenHash(tokenHash: string): void {
  db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteExpiredAdminSessions(
  now: string = new Date().toISOString(),
): void {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    const data = readJsonFile(filePath);
    if (data === null) return null;
    try {
      fs.renameSync(filePath, `${filePath}.migrated`);
    } catch {
      /* best effort */
    }
    return data;
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
