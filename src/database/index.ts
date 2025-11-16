import { SqlJsDb } from './sql-js-db';
import type {
  Session,
  Task,
  FileChange,
  CreateTaskInput,
  BlackboardEntry,
  Topic,
  Vote,
  Approval,
  Lock,
  Notification,
  ThinkingLog,
  TaskResult,
  GovernanceHistoryEntry,
  ProofRecord,
  BlackboardCategory,
  BlackboardVisibility,
  ToolRun,
  ToolRunStatus
} from '../types';

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export class DatabaseManager {
  private db: any; // SqlJsDb with better-sqlite3-like API

  private constructor(db: any) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<DatabaseManager> {
    const db = await SqlJsDb.create(dbPath);
    const manager = new DatabaseManager(db);
    manager.initialize();
    return manager;
  }

  private initialize() {
    this.initializeTables();
    this.ensureAllColumns();
    this.createIndexes();
  }

  withTransaction<T>(callback: () => T): T {
    let transactionStarted = false;
    let committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE TRANSACTION');
      transactionStarted = true;
    } catch (beginError) {
      console.error('[Database] Failed to begin transaction:', describeError(beginError));
      throw beginError;
    }

    try {
      const result = callback();
      if (transactionStarted) {
        try {
          this.db.exec('COMMIT');
          committed = true;
        } catch (commitError: any) {
          const message = describeError(commitError);
          if (message.includes('no transaction is active')) {
            committed = true;
            console.warn('[Database] Commit skipped: transaction already closed');
          } else {
            throw commitError;
          }
        }
      }
      return result;
    } catch (error) {
      if (transactionStarted && !committed) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackError: any) {
          const msg = describeError(rollbackError);
          if (!msg.includes('no transaction is active')) {
            console.error('[Database] Rollback failed:', msg);
          }
        }
      }
      throw error;
    }
  }

  /**
   * 初始化所有表（只创建基础结构，不包含可选列）
   */
  private initializeTables() {
    // Sessions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );
    `);

    // Tasks
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        intent TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Blackboard Entries
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blackboard_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        priority TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'agent_summary',
        visibility TEXT NOT NULL DEFAULT 'blackboard',
        created_at INTEGER NOT NULL,
        tags TEXT,
        reply_to TEXT,
        message_references TEXT,
        reference_type TEXT,
        reference_id TEXT,
        mentions TEXT,
        expires_at INTEGER,
        payload TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Topics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        vote_type TEXT NOT NULL,
        timeout_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Votes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        choice TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topics(id)
      );
    `);

    // Approvals
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        approver_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `);

    // Locks
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        resource TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Notifications
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Tool Runs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        task_id TEXT,
        workflow_instance_id TEXT,
        tool_name TEXT NOT NULL,
        runner TEXT NOT NULL,
        source TEXT,
        command TEXT,
        input TEXT,
        output TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        created_by TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Governance History
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT,
        summary TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Thinking Logs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thinking_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // File Changes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT,
        diff TEXT,
        line_changes TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `);

    // Proof Records
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proof_records (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        workflow_id TEXT NOT NULL,
        workflow_instance_id TEXT NOT NULL,
        phase_id TEXT NOT NULL,
        proof_type TEXT NOT NULL,
        task_id TEXT,
        description TEXT,
        evidence_uri TEXT,
        hash TEXT,
        acknowledgers TEXT,
        created_by TEXT,
        attestation_status TEXT NOT NULL DEFAULT 'pending',
        attestor_id TEXT,
        attested_at INTEGER,
        attestation_note TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
  }

  /**
   * 确保所有可选列都存在（迁移逻辑）
   */
  private ensureAllColumns() {
    // 通用的列检查和添加函数
    const ensureColumn = (tableName: string, columnName: string, sql: string, post?: () => void) => {
      const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(col => col.name));

      if (!columnNames.has(columnName)) {
        try {
          this.db.prepare(sql).run();
          console.log(`[Migration] Added column ${tableName}.${columnName}`);
          if (post) {
            post();
          }
        } catch (error: any) {
          if (!error.message?.includes('duplicate column name')) {
            console.error(`[Migration] Error adding column ${tableName}.${columnName}:`, error);
          }
        }
      }
    };

    ensureColumn('sessions', 'metadata', "ALTER TABLE sessions ADD COLUMN metadata TEXT");

    // ==================== Tasks 表迁移 ====================
    ensureColumn('tasks', 'title', "ALTER TABLE tasks ADD COLUMN title TEXT", () => {
      this.db.prepare("UPDATE tasks SET title = intent WHERE title IS NULL OR title = ''").run();
    });
    ensureColumn('tasks', 'description', "ALTER TABLE tasks ADD COLUMN description TEXT");
    ensureColumn('tasks', 'priority', "ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium'", () => {
      this.db.prepare("UPDATE tasks SET priority = 'medium' WHERE priority IS NULL OR priority = ''").run();
    });
    ensureColumn('tasks', 'labels', "ALTER TABLE tasks ADD COLUMN labels TEXT");
    ensureColumn('tasks', 'due_at', "ALTER TABLE tasks ADD COLUMN due_at INTEGER");
    ensureColumn('tasks', 'assigned_to', "ALTER TABLE tasks ADD COLUMN assigned_to TEXT");
    ensureColumn('tasks', 'completed_at', "ALTER TABLE tasks ADD COLUMN completed_at INTEGER");
    ensureColumn('tasks', 'result_summary', "ALTER TABLE tasks ADD COLUMN result_summary TEXT");
    ensureColumn('tasks', 'result_details', "ALTER TABLE tasks ADD COLUMN result_details TEXT");
    ensureColumn('tasks', 'result_artifacts', "ALTER TABLE tasks ADD COLUMN result_artifacts TEXT");
    ensureColumn('tasks', 'parent_task_id', "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT");
    ensureColumn('tasks', 'dependencies', "ALTER TABLE tasks ADD COLUMN dependencies TEXT", () => {
      this.db.prepare("UPDATE tasks SET dependencies = '[]' WHERE dependencies IS NULL OR dependencies = ''").run();
    });
    ensureColumn('tasks', 'run_after', "ALTER TABLE tasks ADD COLUMN run_after INTEGER");
    ensureColumn('tasks', 'retry_count', "ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    ensureColumn('tasks', 'max_retries', "ALTER TABLE tasks ADD COLUMN max_retries INTEGER");
    ensureColumn('tasks', 'timeout_seconds', "ALTER TABLE tasks ADD COLUMN timeout_seconds INTEGER");
    ensureColumn('tasks', 'last_started_at', "ALTER TABLE tasks ADD COLUMN last_started_at INTEGER");
    ensureColumn('tasks', 'metadata', "ALTER TABLE tasks ADD COLUMN metadata TEXT");

    // ==================== Blackboard Entries 表迁移 ====================
    ensureColumn('blackboard_entries', 'tags', "ALTER TABLE blackboard_entries ADD COLUMN tags TEXT");
    ensureColumn('blackboard_entries', 'reply_to', "ALTER TABLE blackboard_entries ADD COLUMN reply_to TEXT");
    ensureColumn('blackboard_entries', 'message_references', "ALTER TABLE blackboard_entries ADD COLUMN message_references TEXT");
    ensureColumn('blackboard_entries', 'reference_type', "ALTER TABLE blackboard_entries ADD COLUMN reference_type TEXT");
    ensureColumn('blackboard_entries', 'reference_id', "ALTER TABLE blackboard_entries ADD COLUMN reference_id TEXT");
    ensureColumn('blackboard_entries', 'mentions', "ALTER TABLE blackboard_entries ADD COLUMN mentions TEXT");
    ensureColumn('blackboard_entries', 'expires_at', "ALTER TABLE blackboard_entries ADD COLUMN expires_at INTEGER");
    ensureColumn('blackboard_entries', 'category', "ALTER TABLE blackboard_entries ADD COLUMN category TEXT", () => {
      this.db.prepare(`
        UPDATE blackboard_entries
        SET category = CASE
          WHEN agent_id = 'user' THEN 'user'
          WHEN message_type = 'system' THEN 'system_event'
          ELSE 'agent_summary'
        END
        WHERE category IS NULL OR category = ''
      `).run();
    });
    ensureColumn('blackboard_entries', 'visibility', "ALTER TABLE blackboard_entries ADD COLUMN visibility TEXT", () => {
      this.db.prepare(`
        UPDATE blackboard_entries
        SET visibility = CASE
          WHEN message_type = 'system' THEN 'event_log'
          ELSE 'blackboard'
        END
        WHERE visibility IS NULL OR visibility = ''
      `).run();
    });
    ensureColumn('blackboard_entries', 'payload', "ALTER TABLE blackboard_entries ADD COLUMN payload TEXT");


    // ==================== Topics 表迁移 ====================
    ensureColumn('topics', 'task_id', "ALTER TABLE topics ADD COLUMN task_id TEXT");
    ensureColumn('topics', 'description', "ALTER TABLE topics ADD COLUMN description TEXT");
    ensureColumn('topics', 'required_roles', "ALTER TABLE topics ADD COLUMN required_roles TEXT");
    ensureColumn('topics', 'result', "ALTER TABLE topics ADD COLUMN result TEXT");
    ensureColumn('topics', 'created_by', "ALTER TABLE topics ADD COLUMN created_by TEXT");

    // ==================== Votes 表迁移 ====================
    ensureColumn('votes', 'comment', "ALTER TABLE votes ADD COLUMN comment TEXT");

    // ==================== Approvals 表迁移 ====================
    ensureColumn('approvals', 'comment', "ALTER TABLE approvals ADD COLUMN comment TEXT");
    ensureColumn('approvals', 'created_by', "ALTER TABLE approvals ADD COLUMN created_by TEXT");
    ensureColumn('approvals', 'session_id', "ALTER TABLE approvals ADD COLUMN session_id TEXT", () => {
      this.db.exec(`
        UPDATE approvals
        SET session_id = (
          SELECT session_id FROM tasks WHERE tasks.id = approvals.task_id LIMIT 1
        )
        WHERE session_id IS NULL
      `);
      const now = Date.now();
      this.db.prepare(`
        INSERT OR IGNORE INTO sessions (id, created_at, updated_at)
        VALUES (?, ?, ?)
      `).run('default', now, now);
      this.db.exec("UPDATE approvals SET session_id = 'default' WHERE session_id IS NULL");
    });

    // ==================== Notifications 表迁移 ====================
    ensureColumn('notifications', 'read', "ALTER TABLE notifications ADD COLUMN read INTEGER NOT NULL DEFAULT 0");
    ensureColumn('notifications', 'metadata', "ALTER TABLE notifications ADD COLUMN metadata TEXT");

    // ==================== Thinking Logs 表迁移 ====================
    ensureColumn('thinking_logs', 'task_id', "ALTER TABLE thinking_logs ADD COLUMN task_id TEXT");
    ensureColumn('thinking_logs', 'content', "ALTER TABLE thinking_logs ADD COLUMN content TEXT");
    ensureColumn('thinking_logs', 'tool_name', "ALTER TABLE thinking_logs ADD COLUMN tool_name TEXT");
    ensureColumn('thinking_logs', 'tool_input', "ALTER TABLE thinking_logs ADD COLUMN tool_input TEXT");
    ensureColumn('thinking_logs', 'tool_output', "ALTER TABLE thinking_logs ADD COLUMN tool_output TEXT");
    ensureColumn('governance_history', 'session_id', "ALTER TABLE governance_history ADD COLUMN session_id TEXT", () => {
      const entries = this.db.prepare('SELECT id, type, entity_id FROM governance_history').all() as any[];
      const topicStmt = this.db.prepare('SELECT session_id FROM topics WHERE id = ?');
      const approvalStmt = this.db.prepare('SELECT session_id FROM approvals WHERE id = ?');
      const updateStmt = this.db.prepare('UPDATE governance_history SET session_id = ? WHERE id = ?');
      const now = Date.now();
      const ensureSessionStmt = this.db.prepare(`
        INSERT OR IGNORE INTO sessions (id, created_at, updated_at)
        VALUES (?, ?, ?)
      `);

      entries.forEach(entry => {
        let sessionId: string | null = null;
        if (entry.type === 'vote') {
          const row = topicStmt.get(entry.entity_id) as any;
          sessionId = row?.session_id ?? null;
        } else if (entry.type === 'approval') {
          const row = approvalStmt.get(entry.entity_id) as any;
          sessionId = row?.session_id ?? null;
        }
        if (!sessionId) {
          sessionId = 'default';
        }
        ensureSessionStmt.run(sessionId, now, now);
        updateStmt.run(sessionId, entry.id);
      });
    });
    // ==================== 数据修复 ====================
    // 确保 tasks 表的默认值
    this.db.prepare("UPDATE tasks SET priority = 'medium' WHERE priority IS NULL OR priority = ''").run();
    this.db.prepare("UPDATE tasks SET title = COALESCE(title, intent) WHERE title IS NULL OR title = ''").run();
  }

  /**
   * 创建索引
   */
  private createIndexes() {
    // 清理投票重复数据，确保唯一索引可创建
    this.db.exec(`
      DELETE FROM votes
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM votes
        GROUP BY topic_id, agent_id
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_blackboard_type ON blackboard_entries(message_type);
      CREATE INDEX IF NOT EXISTS idx_topics_session ON topics(session_id);
      CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
      CREATE INDEX IF NOT EXISTS idx_votes_topic ON votes(topic_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);
      CREATE INDEX IF NOT EXISTS idx_locks_holder ON locks(holder_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_session ON notifications(session_id);
      CREATE INDEX IF NOT EXISTS idx_thinking_logs_task ON thinking_logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_thinking_logs_agent ON thinking_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_task ON file_changes(task_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_agent ON file_changes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_topic_agent_unique ON votes(topic_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_governance_history_type ON governance_history(type);
      CREATE INDEX IF NOT EXISTS idx_governance_history_entity ON governance_history(entity_id);
      CREATE INDEX IF NOT EXISTS idx_governance_history_created_at ON governance_history(created_at);
      CREATE INDEX IF NOT EXISTS idx_governance_history_session ON governance_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_proof_records_session ON proof_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_proof_records_instance ON proof_records(workflow_instance_id);
      CREATE INDEX IF NOT EXISTS idx_proof_records_phase ON proof_records(phase_id);
      CREATE INDEX IF NOT EXISTS idx_proof_records_status ON proof_records(attestation_status);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_session ON tool_runs(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_task ON tool_runs(task_id);
    `);
  }

  // ==================== Sessions ====================
  
  createSession(id: string, metadata: Record<string, any> | null = null): Session {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, now, now, metadata ? JSON.stringify(metadata) : null);
    return { id, created_at: now, updated_at: now, metadata: metadata ?? null };
  }

  getSession(id: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as (Session & { metadata?: string | null }) | null;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
  }

  getAllSessions(): Session[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC');
    const rows = stmt.all() as Array<Session & { metadata?: string | null }>;
    return rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
  }

  updateSessionMetadata(id: string, metadata: Record<string, any> | null): Session | null {
    const stmt = this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?');
    stmt.run(metadata ? JSON.stringify(metadata) : null, Date.now(), id);
    return this.getSession(id);
  }

  deleteSessionCascade(id: string): void {
    const existing = this.getSession(id);
    if (!existing) {
      return;
    }
    this.withTransaction(() => {
      const sessionId = id;
      const deleteVotesStmt = this.db.prepare(`
        DELETE FROM votes WHERE topic_id IN (
          SELECT id FROM topics WHERE session_id = ?
        )
      `);
      const tablesWithSession = [
        'file_changes',
        'thinking_logs',
        'notifications',
        'blackboard_entries',
        'topics',
        'tasks',
        'approvals',
        'governance_history',
        'locks',
        'proof_records'
      ];

      deleteVotesStmt.run(sessionId);
      tablesWithSession.forEach((table) => {
        const stmt = this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`);
        stmt.run(sessionId);
      });

      const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      stmt.run(sessionId);
    });
  }


  // ==================== Tasks ====================
  
  createTask(task: CreateTaskInput): Task {
    const now = Date.now();
    const title = task.title || task.intent;
    const description = task.description ?? null;
    const priority = task.priority || 'medium';
    const labels = task.labels ? JSON.stringify(task.labels) : null;
    const dueAt = task.due_at ?? null;
    const completedAt = task.completed_at ?? null;
    const resultSummary = task.result_summary ?? null;
    const resultDetails = task.result_details ?? null;
    const resultArtifacts = task.result_artifacts ? JSON.stringify(task.result_artifacts) : null;
    const parentTaskId = task.parent_task_id ?? null;
    const dependenciesJson = JSON.stringify(task.dependencies ?? []);
    const runAfter = task.run_after ?? null;
    const retryCount = typeof task.retry_count === 'number' ? task.retry_count : 0;
    const maxRetries = task.max_retries ?? null;
    const timeoutSeconds = task.timeout_seconds ?? null;
    const lastStartedAt = task.last_started_at ?? null;
    const metadataJson = task.metadata ? JSON.stringify(task.metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, session_id, title, intent, description, scope, priority, labels, due_at,
        status, assigned_to, created_at, updated_at, completed_at,
        result_summary, result_details, result_artifacts,
        parent_task_id, dependencies, run_after, retry_count, max_retries, timeout_seconds, last_started_at,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.session_id,
      title,
      task.intent,
      description,
      task.scope,
      priority,
      labels,
      dueAt,
      task.status,
      task.assigned_to || null,
      now,
      now,
      completedAt,
      resultSummary,
      resultDetails,
      resultArtifacts,
      parentTaskId,
      dependenciesJson,
      runAfter,
      retryCount,
      maxRetries,
      timeoutSeconds,
      lastStartedAt,
      metadataJson
    );

    return {
      ...task,
      title,
      description,
      priority,
      labels: task.labels ?? null,
      due_at: dueAt,
      result_summary: resultSummary,
      result_details: resultDetails,
      result_artifacts: task.result_artifacts ?? null,
      parent_task_id: parentTaskId,
      dependencies: JSON.parse(dependenciesJson),
      run_after: runAfter,
      retry_count: retryCount,
      max_retries: maxRetries,
      timeout_seconds: timeoutSeconds,
      last_started_at: lastStartedAt,
      completed_at: completedAt,
      metadata: task.metadata ?? null,
      created_at: now,
      updated_at: now
    };
  }

  taskExistsWithLabel(label: string): boolean {
    if (!label) {
      return false;
    }
    const token = `"${label}"`;
    const stmt = this.db.prepare(
      'SELECT 1 FROM tasks WHERE labels IS NOT NULL AND instr(labels, ?) > 0 LIMIT 1'
    );
    const row = stmt.get(token);
    return Boolean(row);
  }

  getTask(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) {
      return null;
    }
    return this.mapTaskRow(row);
  }

  getTasks(filters?: { session_id?: string; status?: string; assigned_to?: string }): Task[] {
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: any[] = [];
    
    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.assigned_to) {
      query += ' AND assigned_to = ?';
      params.push(filters.assigned_to);
    }
    
    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapTaskRow(row));
  }

  updateTask(id: string, updates: Partial<Task>): void {
    const fields: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];
    
    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.intent !== undefined) {
      fields.push('intent = ?');
      values.push(updates.intent);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.scope !== undefined) {
      fields.push('scope = ?');
      values.push(updates.scope);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.labels !== undefined) {
      fields.push('labels = ?');
      values.push(updates.labels ? JSON.stringify(updates.labels) : null);
    }
    if (updates.due_at !== undefined) {
      fields.push('due_at = ?');
      values.push(updates.due_at);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.assigned_to !== undefined) {
      fields.push('assigned_to = ?');
      values.push(updates.assigned_to);
    }
    if (updates.completed_at !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completed_at);
    }
    if (updates.result_summary !== undefined) {
      fields.push('result_summary = ?');
      values.push(updates.result_summary);
    }
    if (updates.result_details !== undefined) {
      fields.push('result_details = ?');
      values.push(updates.result_details);
    }
    if (updates.result_artifacts !== undefined) {
      fields.push('result_artifacts = ?');
      values.push(updates.result_artifacts ? JSON.stringify(updates.result_artifacts) : null);
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.parent_task_id !== undefined) {
      fields.push('parent_task_id = ?');
      values.push(updates.parent_task_id);
    }
    if (updates.dependencies !== undefined) {
      fields.push('dependencies = ?');
      values.push(JSON.stringify(updates.dependencies ?? []));
    }
    if (updates.run_after !== undefined) {
      fields.push('run_after = ?');
      values.push(updates.run_after);
    }
    if (updates.retry_count !== undefined) {
      fields.push('retry_count = ?');
      values.push(updates.retry_count);
    }
    if (updates.max_retries !== undefined) {
      fields.push('max_retries = ?');
      values.push(updates.max_retries);
    }
    if (updates.timeout_seconds !== undefined) {
      fields.push('timeout_seconds = ?');
      values.push(updates.timeout_seconds);
    }
    if (updates.last_started_at !== undefined) {
      fields.push('last_started_at = ?');
      values.push(updates.last_started_at);
    }
    
    values.push(id);
    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  private mapTaskRow(row: any): Task {
    return {
      id: row.id,
      session_id: row.session_id,
      title: row.title ?? row.intent,
      intent: row.intent,
      description: row.description ?? null,
      scope: row.scope,
      priority: row.priority ?? 'medium',
      labels: row.labels ? JSON.parse(row.labels) : null,
      due_at: row.due_at ?? null,
      status: row.status,
      assigned_to: row.assigned_to ?? null,
      parent_task_id: row.parent_task_id ?? null,
      dependencies: row.dependencies ? JSON.parse(row.dependencies) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at ?? null,
      result_summary: row.result_summary ?? null,
      result_details: row.result_details ?? null,
      result_artifacts: row.result_artifacts ? JSON.parse(row.result_artifacts) : null,
      run_after: row.run_after ?? null,
      retry_count: row.retry_count ?? 0,
      max_retries: row.max_retries ?? null,
      timeout_seconds: row.timeout_seconds ?? null,
      last_started_at: row.last_started_at ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    } as Task;
  }

  private mapToolRunRow(row: any): ToolRun {
    return {
      id: row.id,
      session_id: row.session_id ?? null,
      task_id: row.task_id ?? null,
      workflow_instance_id: row.workflow_instance_id ?? null,
      tool_name: row.tool_name,
      runner: row.runner,
      source: row.source ?? null,
      command: row.command ?? null,
      input: row.input ? JSON.parse(row.input) : null,
      output: row.output ? JSON.parse(row.output) : null,
      status: row.status,
      exit_code: row.exit_code ?? null,
      error: row.error ?? null,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at ?? null,
      created_by: row.created_by ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
  }

  saveTaskResult(taskId: string, result: TaskResult): void {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET result_summary = ?, result_details = ?, result_artifacts = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      result.summary,
      result.details,
      result.artifacts ? JSON.stringify(result.artifacts) : null,
      result.completed_at,
      Date.now(),
      taskId
    );
  }

  getTaskResult(taskId: string): TaskResult | null {
    const stmt = this.db.prepare(`
      SELECT id as task_id, result_summary AS summary, result_details AS details, result_artifacts, completed_at
      FROM tasks
      WHERE id = ?
    `);
    const row = stmt.get(taskId) as any;
    if (!row) {
      return null;
    }
    return {
      task_id: row.task_id,
      summary: row.summary ?? null,
      details: row.details ?? null,
      artifacts: row.result_artifacts ? JSON.parse(row.result_artifacts) : null,
      completed_at: row.completed_at ?? null
    };
  }

  private mapFileChangeRow(row: any): FileChange {
    return {
      id: row.id,
      session_id: row.session_id,
      task_id: row.task_id ?? null,
      agent_id: row.agent_id,
      file_path: row.file_path,
      change_type: row.change_type,
      old_content: row.old_content ?? null,
      new_content: row.new_content ?? null,
      diff: row.diff ?? null,
      line_changes: row.line_changes ? JSON.parse(row.line_changes) : null,
      reason: row.reason ?? null,
      created_at: row.created_at
    };
  }

  // ==================== File Changes ====================

  createFileChange(change: Omit<FileChange, 'id' | 'created_at'>): FileChange {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO file_changes (
        session_id, task_id, agent_id, file_path, change_type,
        old_content, new_content, diff, line_changes, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      change.session_id,
      change.task_id || null,
      change.agent_id,
      change.file_path,
      change.change_type,
      change.old_content || null,
      change.new_content || null,
      change.diff || null,
      change.line_changes ? JSON.stringify(change.line_changes) : null,
      change.reason || null,
      now
    );

    const row = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
    const created = this.getFileChange(row?.id ?? 0);
    if (!created) {
      throw new Error('Failed to load created file change');
    }
    return created;
  }

  getFileChange(id: number): FileChange | null {
    const stmt = this.db.prepare('SELECT * FROM file_changes WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) {
      return null;
    }
    return this.mapFileChangeRow(row);
  }

  getFileChanges(filters?: { session_id?: string; task_id?: string; agent_id?: string; file_path?: string }): FileChange[] {
    let query = 'SELECT * FROM file_changes WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.task_id) {
      query += ' AND task_id = ?';
      params.push(filters.task_id);
    }
    if (filters?.agent_id) {
      query += ' AND agent_id = ?';
      params.push(filters.agent_id);
    }
    if (filters?.file_path) {
      query += ' AND file_path = ?';
      params.push(filters.file_path);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapFileChangeRow(row));
  }

  deleteFileChange(id: number): void {
    const stmt = this.db.prepare('DELETE FROM file_changes WHERE id = ?');
    stmt.run(id);
  }

  createThinkingLog(log: Omit<ThinkingLog, 'created_at'>): ThinkingLog {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO thinking_logs (
        id, session_id, agent_id, task_id, step_type, content,
        tool_name, tool_input, tool_output, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      log.id,
      log.session_id,
      log.agent_id,
      log.task_id || null,
      log.step_type,
      log.content || null,
      log.tool_name || null,
      log.tool_input ? JSON.stringify(log.tool_input) : null,
      log.tool_output ? JSON.stringify(log.tool_output) : null,
      now
    );

    return {
      ...log,
      content: log.content ?? null,
      tool_name: log.tool_name ?? null,
      tool_input: log.tool_input ?? null,
      tool_output: log.tool_output ?? null,
      created_at: now
    };
  }

  getThinkingLogs(filters?: {
    session_id?: string;
    agent_id?: string;
    task_id?: string;
    limit?: number;
  }): ThinkingLog[] {
    let query = 'SELECT * FROM thinking_logs WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.agent_id) {
      query += ' AND agent_id = ?';
      params.push(filters.agent_id);
    }
    if (filters?.task_id) {
      query += ' AND task_id = ?';
      params.push(filters.task_id);
    }

    query += ' ORDER BY created_at DESC';

    if (filters?.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      agent_id: row.agent_id,
      task_id: row.task_id ?? null,
      step_type: row.step_type,
      content: row.content ?? null,
      tool_name: row.tool_name ?? null,
      tool_input: row.tool_input ? JSON.parse(row.tool_input) : null,
      tool_output: row.tool_output ? JSON.parse(row.tool_output) : null,
      created_at: row.created_at
    }));
  }

  // ==================== Blackboard Entries ====================
  
  createBlackboardEntry(entry: Omit<BlackboardEntry, 'created_at'>): BlackboardEntry {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO blackboard_entries (
        id, session_id, agent_id, message_type, content, priority,
        category, visibility, tags, reply_to, message_references, reference_type,
        reference_id, mentions, expires_at, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.session_id,
      entry.agent_id,
      entry.message_type,
      entry.content,
      entry.priority,
      entry.category,
      entry.visibility,
      entry.tags ? JSON.stringify(entry.tags) : null,
      entry.reply_to || null,
      entry.references ? JSON.stringify(entry.references) : null,
      entry.reference_type || null,
      entry.reference_id || null,
      entry.mentions ? JSON.stringify(entry.mentions) : null,
      entry.expires_at || null,
      entry.payload ? JSON.stringify(entry.payload) : null,
      now
    );

    return { ...entry, created_at: now };
  }

  getBlackboardEntries(filters?: {
    session_id?: string;
    message_type?: string;
    priority?: string;
    category?: BlackboardCategory;
    visibility?: BlackboardVisibility;
    limit?: number;
  }): BlackboardEntry[] {
    let query = 'SELECT * FROM blackboard_entries WHERE 1=1';
    const params: any[] = [];
    
    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.message_type) {
      query += ' AND message_type = ?';
      params.push(filters.message_type);
    }
    if (filters?.priority) {
      query += ' AND priority = ?';
      params.push(filters.priority);
    }
    if (filters?.category) {
      query += ' AND category = ?';
      params.push(filters.category);
    }
    if (filters?.visibility) {
      query += ' AND visibility = ?';
      params.push(filters.visibility);
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (filters?.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.hydrateBlackboardRow(row));
  }

  getBlackboardEntry(id: string): BlackboardEntry | null {
    const stmt = this.db.prepare('SELECT * FROM blackboard_entries WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) {
      return null;
    }
    return this.hydrateBlackboardRow(row);
  }

  private hydrateBlackboardRow(row: any): BlackboardEntry {
    const derivedCategory: BlackboardCategory =
      (row.category && row.category.length > 0
        ? row.category
        : (row.agent_id === 'user'
          ? 'user'
          : (row.message_type === 'system' ? 'system_event' : 'agent_summary'))) as BlackboardCategory;
    const derivedVisibility: BlackboardVisibility =
      (row.visibility && row.visibility.length > 0
        ? row.visibility
        : (row.message_type === 'system' ? 'event_log' : 'blackboard')) as BlackboardVisibility;

    return {
      id: row.id,
      session_id: row.session_id,
      agent_id: row.agent_id,
      message_type: row.message_type,
      content: row.content,
      priority: row.priority,
      category: derivedCategory,
      visibility: derivedVisibility,
      tags: row.tags ? JSON.parse(row.tags) : null,
      reply_to: row.reply_to || null,
      references: row.message_references ? JSON.parse(row.message_references) : null,
      reference_type: row.reference_type || null,
      reference_id: row.reference_id || null,
      mentions: row.mentions ? JSON.parse(row.mentions) : null,
      expires_at: row.expires_at || null,
      payload: row.payload ? JSON.parse(row.payload) : null,
      created_at: row.created_at
    };
  }

  updateBlackboardEntry(
    id: string,
    updates: Partial<Pick<BlackboardEntry, 'message_type' | 'priority' | 'tags' | 'references' | 'reference_type' | 'reference_id' | 'payload'>>
  ): BlackboardEntry | null {
    const existing = this.getBlackboardEntry(id);
    if (!existing) {
      return null;
    }
    const next: BlackboardEntry = {
      ...existing,
      ...updates,
      tags: updates.tags !== undefined ? updates.tags : existing.tags,
      references: updates.references !== undefined ? updates.references : existing.references,
      reference_type: updates.reference_type !== undefined ? updates.reference_type : existing.reference_type,
      reference_id: updates.reference_id !== undefined ? updates.reference_id : existing.reference_id,
      payload: updates.payload !== undefined ? updates.payload : existing.payload,
      message_type: updates.message_type ?? existing.message_type,
      priority: updates.priority ?? existing.priority
    };

    const stmt = this.db.prepare(`
      UPDATE blackboard_entries
      SET message_type = ?, priority = ?, tags = ?, message_references = ?, reference_type = ?, reference_id = ?, payload = ?
      WHERE id = ?
    `);
    stmt.run(
      next.message_type,
      next.priority,
      next.tags ? JSON.stringify(next.tags) : null,
      next.references ? JSON.stringify(next.references) : null,
      next.reference_type || null,
      next.reference_id || null,
      next.payload ? JSON.stringify(next.payload) : null,
      id
    );
    return next;
  }

  deleteBlackboardEntry(id: string): void {
    const stmt = this.db.prepare('DELETE FROM blackboard_entries WHERE id = ?');
    stmt.run(id);
  }

  // ==================== Topics ====================

  createTopic(topic: Omit<Topic, 'created_at'>): Topic {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO topics (
        id, session_id, task_id, title, description, vote_type,
        required_roles, created_by, timeout_at, status, result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      topic.id,
      topic.session_id,
      topic.task_id || null,
      topic.title,
      topic.description || null,
      topic.vote_type,
      topic.required_roles ? JSON.stringify(topic.required_roles) : null,
      topic.created_by,
      topic.timeout_at,
      topic.status,
      topic.result || null,
      now
    );

    return { ...topic, created_at: now };
  }

  getTopic(id: string): Topic | null {
    const stmt = this.db.prepare('SELECT * FROM topics WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      ...row,
      required_roles: row.required_roles ? JSON.parse(row.required_roles) : null
    };
  }

  getTopics(filters?: { session_id?: string; status?: string; task_id?: string }): Topic[] {
    let query = 'SELECT * FROM topics WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.task_id) {
      query += ' AND task_id = ?';
      params.push(filters.task_id);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    // 为每个 topic 关联查询 votes
    return rows.map(row => {
      const votes = this.getVotes(row.id);

      // 根据 vote_type 生成 options
      let options: Array<{ value: string; label: string }>;
      if (row.vote_type === 'approval') {
        options = [
          { value: 'approve', label: '赞成' },
          { value: 'reject', label: '反对' }
        ];
      } else if (row.vote_type === 'choice') {
        // 对于 choice 类型，从 votes 中提取唯一的选项
        const uniqueChoices = [...new Set(votes.map(v => v.choice))];
        options = uniqueChoices.map(choice => ({
          value: choice,
          label: choice
        }));
      } else {
        options = [];
      }

      return {
        ...row,
        required_roles: row.required_roles ? JSON.parse(row.required_roles) : null,
        votes,
        options
      };
    });
  }

  updateTopic(id: string, updates: Partial<Topic>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.result !== undefined) {
      fields.push('result = ?');
      values.push(updates.result);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE topics SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  // ==================== Votes ====================

  createVote(vote: Omit<Vote, 'id' | 'created_at'>): Vote {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO votes (topic_id, agent_id, choice, comment, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      vote.topic_id,
      vote.agent_id,
      vote.choice,
      vote.comment || null,
      now
    );

    return {
      id: result.lastInsertRowid as number,
      ...vote,
      created_at: now
    };
  }

  getVotes(topicId: string): Vote[] {
    const stmt = this.db.prepare('SELECT * FROM votes WHERE topic_id = ? ORDER BY created_at ASC');
    return stmt.all(topicId) as Vote[];
  }

  getVotesForTopic(topicId: string): Vote[] {
    return this.getVotes(topicId);
  }

  getVoteByTopicAndAgent(topicId: string, agentId: string): Vote | null {
    const stmt = this.db.prepare(`
      SELECT * FROM votes
      WHERE topic_id = ?
        AND agent_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(topicId, agentId) as Vote | undefined;
    return row ?? null;
  }

  // ==================== Approvals ====================

  createApproval(approval: Omit<Approval, 'id' | 'created_at'>): Approval {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO approvals (session_id, task_id, created_by, approver_id, decision, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      approval.session_id,
      approval.task_id,
      approval.created_by,
      approval.approver_id,
      approval.decision,
      approval.comment || null,
      now
    );

    return {
      id: result.lastInsertRowid as number,
      ...approval,
      created_at: now
    };
  }

  getApprovals(filters?: { session_id?: string; task_id?: string; decision?: string; approver_id?: string }): Approval[] {
    let query = 'SELECT * FROM approvals WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.task_id) {
      query += ' AND task_id = ?';
      params.push(filters.task_id);
    }
    if (filters?.decision) {
      query += ' AND decision = ?';
      params.push(filters.decision);
    }
    if (filters?.approver_id) {
      query += ' AND approver_id = ?';
      params.push(filters.approver_id);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Approval[];
  }

  getApproval(id: number): Approval | null {
    const stmt = this.db.prepare('SELECT * FROM approvals WHERE id = ?');
    const row = stmt.get(id) as Approval | undefined;
    return row || null;
  }

  updateApproval(id: number, updates: Partial<Approval>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.decision !== undefined) {
      fields.push('decision = ?');
      values.push(updates.decision);
    }
    if (updates.comment !== undefined) {
      fields.push('comment = ?');
      values.push(updates.comment);
    }
    if (updates.approver_id !== undefined) {
      fields.push('approver_id = ?');
      values.push(updates.approver_id);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE approvals SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  // ==================== Locks ====================

  createLock(lock: Lock): Lock {
    const stmt = this.db.prepare(`
      INSERT INTO locks (resource, holder_id, session_id, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    try {
      stmt.run(lock.resource, lock.holder_id, lock.session_id, lock.expires_at);
      return lock;
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT') {
        throw new Error('Resource already locked');
      }
      throw error;
    }
  }

  getLock(resource: string): Lock | null {
    const stmt = this.db.prepare('SELECT * FROM locks WHERE resource = ?');
    return stmt.get(resource) as Lock | null;
  }

  getLocks(filters?: { session_id?: string; holder_id?: string }): Lock[] {
    let query = 'SELECT * FROM locks WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.holder_id) {
      query += ' AND holder_id = ?';
      params.push(filters.holder_id);
    }

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Lock[];
  }

  deleteLock(resource: string): void {
    const stmt = this.db.prepare('DELETE FROM locks WHERE resource = ?');
    stmt.run(resource);
  }

  deleteExpiredLocks(): void {
    const now = Date.now();
    const stmt = this.db.prepare('DELETE FROM locks WHERE expires_at < ?');
    stmt.run(now);
  }

  deleteAgentLocks(agentId: string): void {
    const stmt = this.db.prepare('DELETE FROM locks WHERE holder_id = ?');
    stmt.run(agentId);
  }

  deleteSessionLocks(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM locks WHERE session_id = ?');
    stmt.run(sessionId);
  }

  // ==================== Notifications ====================

  createNotification(notification: Omit<Notification, 'id' | 'created_at'>): Notification {
    const now = Date.now();
    const metadataJson = notification.metadata !== undefined && notification.metadata !== null
      ? JSON.stringify(notification.metadata)
      : null;
    const stmt = this.db.prepare(`
      INSERT INTO notifications (session_id, level, title, message, metadata, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      notification.session_id,
      notification.level,
      notification.title,
      notification.message,
      metadataJson,
      notification.read ? 1 : 0,
      now
    );

    return {
      id: result.lastInsertRowid as number,
      ...notification,
      metadata: notification.metadata ?? null,
      read: !!notification.read,
      created_at: now
    };
  }

  private parseNotificationMetadata(value: any): Record<string, any> | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (error) {
        console.warn('[Database] Failed to parse notification metadata', error);
        return null;
      }
    }
    if (typeof value === 'object') {
      return value as Record<string, any>;
    }
    return null;
  }

  private deserializeNotificationRow(row: any): Notification {
    return {
      ...row,
      metadata: this.parseNotificationMetadata(row?.metadata),
      read: row.read === 1
    };
  }

  getNotifications(filters?: { session_id?: string; read?: boolean }): Notification[] {
    let query = 'SELECT * FROM notifications WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.read !== undefined) {
      query += ' AND read = ?';
      params.push(filters.read ? 1 : 0);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.deserializeNotificationRow(row));
  }

  getNotification(id: number): Notification | null {
    const stmt = this.db.prepare('SELECT * FROM notifications WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) {
      return null;
    }
    return this.deserializeNotificationRow(row);
  }

  markNotificationAsRead(id: number): void {
    const stmt = this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
    stmt.run(id);
  }

  updateNotification(id: number, updates: Partial<Notification>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.read !== undefined) {
      fields.push('read = ?');
      values.push(updates.read ? 1 : 0);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE notifications SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deleteNotification(id: number): void {
    const stmt = this.db.prepare('DELETE FROM notifications WHERE id = ?');
    stmt.run(id);
  }

  // ==================== Tool Runs ====================

  createToolRun(run: {
    id: string;
    session_id?: string | null;
    task_id?: string | null;
    workflow_instance_id?: string | null;
    tool_name: string;
    runner: string;
    source?: string | null;
    command?: string | null;
    input?: Record<string, any> | null;
    output?: Record<string, any> | null;
    status: ToolRunStatus;
    exit_code?: number | null;
    error?: string | null;
    started_at?: number;
    completed_at?: number | null;
    created_by?: string | null;
    metadata?: Record<string, any> | null;
  }): ToolRun {
    const now = Date.now();
    const startedAt = run.started_at ?? now;
    const stmt = this.db.prepare(`
      INSERT INTO tool_runs (
        id, session_id, task_id, workflow_instance_id, tool_name, runner, source,
        command, input, output, status, exit_code, error, created_at, started_at,
        completed_at, created_by, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      run.id,
      run.session_id ?? null,
      run.task_id ?? null,
      run.workflow_instance_id ?? null,
      run.tool_name,
      run.runner,
      run.source ?? null,
      run.command ?? null,
      run.input ? JSON.stringify(run.input) : null,
      run.output ? JSON.stringify(run.output) : null,
      run.status,
      run.exit_code ?? null,
      run.error ?? null,
      now,
      startedAt,
      run.completed_at ?? null,
      run.created_by ?? null,
      run.metadata ? JSON.stringify(run.metadata) : null
    );

    return this.getToolRun(run.id)!;
  }

  updateToolRun(id: string, updates: Partial<ToolRun>): ToolRun | null {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.session_id !== undefined) {
      fields.push('session_id = ?');
      values.push(updates.session_id);
    }
    if (updates.task_id !== undefined) {
      fields.push('task_id = ?');
      values.push(updates.task_id);
    }
    if (updates.workflow_instance_id !== undefined) {
      fields.push('workflow_instance_id = ?');
      values.push(updates.workflow_instance_id);
    }
    if (updates.tool_name !== undefined) {
      fields.push('tool_name = ?');
      values.push(updates.tool_name);
    }
    if (updates.runner !== undefined) {
      fields.push('runner = ?');
      values.push(updates.runner);
    }
    if (updates.source !== undefined) {
      fields.push('source = ?');
      values.push(updates.source);
    }
    if (updates.command !== undefined) {
      fields.push('command = ?');
      values.push(updates.command);
    }
    if (updates.input !== undefined) {
      fields.push('input = ?');
      values.push(updates.input ? JSON.stringify(updates.input) : null);
    }
    if (updates.output !== undefined) {
      fields.push('output = ?');
      values.push(updates.output ? JSON.stringify(updates.output) : null);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.exit_code !== undefined) {
      fields.push('exit_code = ?');
      values.push(updates.exit_code);
    }
    if (updates.error !== undefined) {
      fields.push('error = ?');
      values.push(updates.error ?? null);
    }
    if (updates.started_at !== undefined) {
      fields.push('started_at = ?');
      values.push(updates.started_at);
    }
    if (updates.completed_at !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completed_at);
    }
    if (updates.created_by !== undefined) {
      fields.push('created_by = ?');
      values.push(updates.created_by ?? null);
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    if (fields.length === 0) {
      return this.getToolRun(id);
    }

    const stmt = this.db.prepare(`UPDATE tool_runs SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values, id);
    return this.getToolRun(id);
  }

  getToolRun(id: string): ToolRun | null {
    const stmt = this.db.prepare('SELECT * FROM tool_runs WHERE id = ?');
    const row = stmt.get(id);
    if (!row) {
      return null;
    }
    return this.mapToolRunRow(row);
  }

  getToolRuns(filters?: { session_id?: string | null; task_id?: string; statuses?: ToolRunStatus[]; limit?: number }): ToolRun[] {
    let query = 'SELECT * FROM tool_runs WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.task_id) {
      query += ' AND task_id = ?';
      params.push(filters.task_id);
    }
    if (filters?.statuses && filters.statuses.length > 0) {
      const placeholders = filters.statuses.map(() => '?').join(', ');
      query += ` AND status IN (${placeholders})`;
      params.push(...filters.statuses);
    }

    query += ' ORDER BY created_at DESC';
    if (filters?.limit && Number.isFinite(filters.limit)) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapToolRunRow(row));
  }

  // ==================== Governance History ====================

  createGovernanceHistoryEntry(entry: Omit<GovernanceHistoryEntry, 'id' | 'created_at'>): GovernanceHistoryEntry {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO governance_history (session_id, type, entity_id, action, actor_id, summary, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      entry.session_id,
      entry.type,
      entry.entity_id,
      entry.action,
      entry.actor_id || null,
      entry.summary || null,
      entry.payload ? JSON.stringify(entry.payload) : null,
      now
    );

    return {
      id: Number(result.lastInsertRowid),
      ...entry,
      payload: entry.payload ?? null,
      created_at: now
    };
  }

  getGovernanceHistoryEntries(filters?: {
    type?: GovernanceHistoryEntry['type'];
    entity_id?: string;
    entity_ids?: string[];
    session_id?: string;
    entity_query?: string;
    action?: string;
    search?: string;
    start_time?: number;
    end_time?: number;
    limit?: number;
    offset?: number;
  }): GovernanceHistoryEntry[] {
    let query = 'SELECT * FROM governance_history WHERE 1=1';
    const params: any[] = [];

    if (filters?.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.entity_id) {
      query += ' AND entity_id = ?';
      params.push(filters.entity_id);
    }
    if (filters?.entity_ids && filters.entity_ids.length > 0) {
      const placeholders = filters.entity_ids.map(() => '?').join(', ');
      query += ` AND entity_id IN (${placeholders})`;
      params.push(...filters.entity_ids);
    }
    if (filters?.entity_query) {
      query += ' AND (entity_id LIKE ? OR payload LIKE ?)';
      const pattern = `%${filters.entity_query}%`;
      params.push(pattern, pattern);
    }
    if (filters?.action) {
      query += ' AND action = ?';
      params.push(filters.action);
    }
    if (filters?.search) {
      query += ' AND (summary LIKE ? OR payload LIKE ? OR actor_id LIKE ? OR entity_id LIKE ?)';
      const pattern = `%${filters.search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    if (filters?.start_time) {
      query += ' AND created_at >= ?';
      params.push(filters.start_time);
    }
    if (filters?.end_time) {
      query += ' AND created_at <= ?';
      params.push(filters.end_time);
    }

    query += ' ORDER BY created_at DESC';
    if (filters?.limit && Number.isFinite(filters.limit)) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    if (filters?.offset && filters.offset > 0) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapGovernanceHistoryRow(row));
  }

  private mapGovernanceHistoryRow(row: any): GovernanceHistoryEntry {
    return {
      id: row.id,
      session_id: row.session_id,
      type: row.type,
      entity_id: row.entity_id,
      action: row.action,
      actor_id: row.actor_id,
      summary: row.summary,
      payload: row.payload ? JSON.parse(row.payload) : null,
      created_at: row.created_at
    };
  }

  // ==================== Proof Records ====================

  upsertProofRecord(record: { id: string } & Partial<Omit<ProofRecord, 'id' | 'created_at' | 'updated_at'>> & {
    created_at?: number;
    updated_at?: number;
  }): ProofRecord {
    if (!record?.id) {
      throw new Error('Proof record id is required');
    }
    const existing = this.getProofRecord(record.id);
    if (!existing) {
      const requiredFields: Array<keyof ProofRecord> = ['workflow_id', 'workflow_instance_id', 'phase_id', 'proof_type'];
      requiredFields.forEach(field => {
        if ((record as any)[field] === undefined || (record as any)[field] === null) {
          throw new Error(`Proof record ${field} is required`);
        }
      });
    }
    const now = Date.now();
    const merged: ProofRecord = {
      id: record.id,
      session_id: record.session_id ?? existing?.session_id ?? null,
      workflow_id: record.workflow_id ?? existing?.workflow_id ?? '',
      workflow_instance_id: record.workflow_instance_id ?? existing?.workflow_instance_id ?? '',
      phase_id: record.phase_id ?? existing?.phase_id ?? '',
      proof_type: record.proof_type ?? existing?.proof_type ?? 'work',
      task_id: record.task_id ?? existing?.task_id ?? null,
      description: record.description ?? existing?.description ?? null,
      evidence_uri: record.evidence_uri ?? existing?.evidence_uri ?? null,
      hash: record.hash ?? existing?.hash ?? null,
      acknowledgers: record.acknowledgers ?? existing?.acknowledgers ?? null,
      created_by: record.created_by ?? existing?.created_by ?? null,
      attestation_status: record.attestation_status ?? existing?.attestation_status ?? 'pending',
      attestor_id: record.attestor_id ?? existing?.attestor_id ?? null,
      attested_at: record.attested_at ?? existing?.attested_at ?? null,
      attestation_note: record.attestation_note ?? existing?.attestation_note ?? null,
      metadata: record.metadata ?? existing?.metadata ?? null,
      created_at: existing?.created_at ?? record.created_at ?? now,
      updated_at: record.updated_at ?? now
    };

    if (!merged.workflow_id || !merged.workflow_instance_id || !merged.phase_id) {
      throw new Error('Proof record missing workflow metadata');
    }

    const acknowledgersJson = merged.acknowledgers ? JSON.stringify(merged.acknowledgers) : null;
    const metadataJson = merged.metadata ? JSON.stringify(merged.metadata) : null;

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE proof_records
        SET
          session_id = ?,
          workflow_id = ?,
          workflow_instance_id = ?,
          phase_id = ?,
          proof_type = ?,
          task_id = ?,
          description = ?,
          evidence_uri = ?,
          hash = ?,
          acknowledgers = ?,
          created_by = ?,
          attestation_status = ?,
          attestor_id = ?,
          attested_at = ?,
          attestation_note = ?,
          metadata = ?,
          updated_at = ?
        WHERE id = ?
      `);
      stmt.run(
        merged.session_id,
        merged.workflow_id,
        merged.workflow_instance_id,
        merged.phase_id,
        merged.proof_type,
        merged.task_id,
        merged.description,
        merged.evidence_uri,
        merged.hash,
        acknowledgersJson,
        merged.created_by,
        merged.attestation_status,
        merged.attestor_id,
        merged.attested_at,
        merged.attestation_note,
        metadataJson,
        merged.updated_at,
        merged.id
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO proof_records (
          id,
          session_id,
          workflow_id,
          workflow_instance_id,
          phase_id,
          proof_type,
          task_id,
          description,
          evidence_uri,
          hash,
          acknowledgers,
          created_by,
          attestation_status,
          attestor_id,
          attested_at,
          attestation_note,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        merged.id,
        merged.session_id,
        merged.workflow_id,
        merged.workflow_instance_id,
        merged.phase_id,
        merged.proof_type,
        merged.task_id,
        merged.description,
        merged.evidence_uri,
        merged.hash,
        acknowledgersJson,
        merged.created_by,
        merged.attestation_status,
        merged.attestor_id,
        merged.attested_at,
        merged.attestation_note,
        metadataJson,
        merged.created_at,
        merged.updated_at
      );
    }

    return this.getProofRecord(merged.id)!;
  }

  getProofRecord(id: string): ProofRecord | null {
    const stmt = this.db.prepare('SELECT * FROM proof_records WHERE id = ?');
    const row = stmt.get(id);
    if (!row) {
      return null;
    }
    return this.mapProofRecordRow(row);
  }

  getProofRecords(filters?: {
    session_id?: string | null;
    workflow_instance_id?: string;
    workflow_id?: string;
    phase_id?: string;
    attestation_status?: ProofRecord['attestation_status'];
  }): ProofRecord[] {
    let query = 'SELECT * FROM proof_records WHERE 1=1';
    const params: any[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }
    if (filters?.workflow_instance_id) {
      query += ' AND workflow_instance_id = ?';
      params.push(filters.workflow_instance_id);
    }
    if (filters?.workflow_id) {
      query += ' AND workflow_id = ?';
      params.push(filters.workflow_id);
    }
    if (filters?.phase_id) {
      query += ' AND phase_id = ?';
      params.push(filters.phase_id);
    }
    if (filters?.attestation_status) {
      query += ' AND attestation_status = ?';
      params.push(filters.attestation_status);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params);
    return (rows as any[]).map(row => this.mapProofRecordRow(row));
  }

  updateProofAttestation(
    proofId: string,
    payload: {
      attestation_status: ProofRecord['attestation_status'];
      attestor_id?: string | null;
      attestation_note?: string | null;
      attested_at?: number | null;
    }
  ): ProofRecord | null {
    const existing = this.getProofRecord(proofId);
    if (!existing) {
      return null;
    }
    const attestedAt = payload.attestation_status === 'pending'
      ? null
      : payload.attested_at ?? Date.now();
    const attestorProvided = Object.prototype.hasOwnProperty.call(payload, 'attestor_id');
    const noteProvided = Object.prototype.hasOwnProperty.call(payload, 'attestation_note');
    return this.upsertProofRecord({
      id: proofId,
      attestation_status: payload.attestation_status,
      attestor_id: attestorProvided ? (payload.attestor_id ?? null) : existing.attestor_id,
      attestation_note: noteProvided ? (payload.attestation_note ?? null) : existing.attestation_note,
      attested_at: attestedAt
    });
  }

  private mapProofRecordRow(row: any): ProofRecord {
    return {
      id: row.id,
      session_id: row.session_id ?? null,
      workflow_id: row.workflow_id,
      workflow_instance_id: row.workflow_instance_id,
      phase_id: row.phase_id,
      proof_type: row.proof_type,
      task_id: row.task_id ?? null,
      description: row.description ?? null,
      evidence_uri: row.evidence_uri ?? null,
      hash: row.hash ?? null,
      acknowledgers: row.acknowledgers ? JSON.parse(row.acknowledgers) : null,
      created_by: row.created_by ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      attestation_status: row.attestation_status ?? 'pending',
      attestor_id: row.attestor_id ?? null,
      attested_at: row.attested_at ?? null,
      attestation_note: row.attestation_note ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
  }

  close() {
    this.db.close();
  }
}
