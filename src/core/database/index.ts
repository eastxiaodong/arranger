import { SqlJsDb } from './sql-js-db';
import type {
  Session,
  Task,
  FileChange,
  CreateTaskInput,
  BlackboardEntry,
  Notification,
  ThinkingLog,
  TaskResult,
  BlackboardCategory,
  BlackboardVisibility,
  ToolRun,
  ToolRunStatus,
  TaskStateRecord,
  AssistRequest,
  SensitiveKeyword,
  SensitiveOperationLog,
  AceStateRecord
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
   * 初始化所有表（只创建核心字段和主外键约束）
   * 其他字段通过 ensureAllColumns() 动态添加，确保结构稳定性和可追溯性
   */
  private initializeTables() {
    // Sessions - 会话表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Tasks - 任务表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Blackboard Entries - 黑板消息表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blackboard_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Notifications - 通知表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // Tool Runs - 工具执行记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_runs (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        runner TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);

    // Thinking Logs - 思考日志表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thinking_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // State Store tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_task_states (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        previous_state TEXT,
        assigned_to TEXT,
        priority TEXT,
        labels TEXT,
        dependencies TEXT,
        blocked_by TEXT,
        context TEXT,
        history TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_assist_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        session_id TEXT,
        requester_id TEXT,
        target_agent_id TEXT,
        required_capabilities TEXT,
        priority TEXT,
        state TEXT,
        description TEXT,
        context TEXT,
        assigned_to TEXT,
        response_deadline INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_sensitive_keywords (
        id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        action TEXT NOT NULL,
        category TEXT,
        description TEXT,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_sensitive_operation_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        session_id TEXT,
        agent_id TEXT,
        operation TEXT,
        matched_keywords TEXT,
        risk_level TEXT,
        action TEXT,
        user_confirmed INTEGER,
        blocked INTEGER,
        context TEXT,
        timestamp INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_ace_states (
        workspace_root TEXT PRIMARY KEY,
        project_root TEXT,
        last_run_type TEXT,
        last_run_at INTEGER,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        failure_streak INTEGER,
        last_failure_message TEXT,
        last_index TEXT,
        last_search TEXT,
        last_test TEXT,
        updated_at INTEGER NOT NULL
      );
    `);

    // File Changes - 文件变更记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
  }

  /**
   * 确保所有字段都存在（迁移逻辑）
   * 所有非核心字段都通过此方法动态添加，确保数据库结构的演进可追溯
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

    // ==================== Sessions 表字段 ====================
    ensureColumn('sessions', 'metadata', "ALTER TABLE sessions ADD COLUMN metadata TEXT");

    // ==================== Tasks 表字段 ====================
    ensureColumn('tasks', 'intent', "ALTER TABLE tasks ADD COLUMN intent TEXT");
    ensureColumn('tasks', 'scope', "ALTER TABLE tasks ADD COLUMN scope TEXT");
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
    ensureColumn('tasks', 'retry_count', "ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0");
    ensureColumn('tasks', 'max_retries', "ALTER TABLE tasks ADD COLUMN max_retries INTEGER");
    ensureColumn('tasks', 'timeout_seconds', "ALTER TABLE tasks ADD COLUMN timeout_seconds INTEGER");
    ensureColumn('tasks', 'last_started_at', "ALTER TABLE tasks ADD COLUMN last_started_at INTEGER");
    ensureColumn('tasks', 'metadata', "ALTER TABLE tasks ADD COLUMN metadata TEXT");

    // ==================== Blackboard Entries 表字段 ====================
    ensureColumn('blackboard_entries', 'priority', "ALTER TABLE blackboard_entries ADD COLUMN priority TEXT DEFAULT 'normal'");
    ensureColumn('blackboard_entries', 'category', "ALTER TABLE blackboard_entries ADD COLUMN category TEXT DEFAULT 'agent_summary'", () => {
      this.db.prepare(`
        UPDATE blackboard_entries
        SET category = CASE
          WHEN agent_id = 'user' THEN 'user'
          ELSE 'agent_summary'
        END
        WHERE category IS NULL OR category = ''
      `).run();
    });
    ensureColumn('blackboard_entries', 'visibility', "ALTER TABLE blackboard_entries ADD COLUMN visibility TEXT DEFAULT 'blackboard'", () => {
      this.db.prepare(`
        UPDATE blackboard_entries
        SET visibility = 'blackboard'
        WHERE visibility IS NULL OR visibility = ''
      `).run();
    });
    ensureColumn('blackboard_entries', 'tags', "ALTER TABLE blackboard_entries ADD COLUMN tags TEXT");
    ensureColumn('blackboard_entries', 'reply_to', "ALTER TABLE blackboard_entries ADD COLUMN reply_to TEXT");
    ensureColumn('blackboard_entries', 'message_references', "ALTER TABLE blackboard_entries ADD COLUMN message_references TEXT");
    ensureColumn('blackboard_entries', 'reference_type', "ALTER TABLE blackboard_entries ADD COLUMN reference_type TEXT");
    ensureColumn('blackboard_entries', 'reference_id', "ALTER TABLE blackboard_entries ADD COLUMN reference_id TEXT");
    ensureColumn('blackboard_entries', 'mentions', "ALTER TABLE blackboard_entries ADD COLUMN mentions TEXT");
    ensureColumn('blackboard_entries', 'expires_at', "ALTER TABLE blackboard_entries ADD COLUMN expires_at INTEGER");
    ensureColumn('blackboard_entries', 'payload', "ALTER TABLE blackboard_entries ADD COLUMN payload TEXT");

    // ==================== Notifications 表字段 ====================
    ensureColumn('notifications', 'read', "ALTER TABLE notifications ADD COLUMN read INTEGER DEFAULT 0");
    ensureColumn('notifications', 'metadata', "ALTER TABLE notifications ADD COLUMN metadata TEXT");

    // ==================== Tool Runs 表字段 ====================
    ensureColumn('tool_runs', 'session_id', "ALTER TABLE tool_runs ADD COLUMN session_id TEXT");
    ensureColumn('tool_runs', 'task_id', "ALTER TABLE tool_runs ADD COLUMN task_id TEXT");
    ensureColumn('tool_runs', 'workflow_instance_id', "ALTER TABLE tool_runs ADD COLUMN workflow_instance_id TEXT");
    ensureColumn('tool_runs', 'source', "ALTER TABLE tool_runs ADD COLUMN source TEXT");
    ensureColumn('tool_runs', 'command', "ALTER TABLE tool_runs ADD COLUMN command TEXT");
    ensureColumn('tool_runs', 'input', "ALTER TABLE tool_runs ADD COLUMN input TEXT");
    ensureColumn('tool_runs', 'output', "ALTER TABLE tool_runs ADD COLUMN output TEXT");
    ensureColumn('tool_runs', 'exit_code', "ALTER TABLE tool_runs ADD COLUMN exit_code INTEGER");
    ensureColumn('tool_runs', 'error', "ALTER TABLE tool_runs ADD COLUMN error TEXT");
    ensureColumn('tool_runs', 'completed_at', "ALTER TABLE tool_runs ADD COLUMN completed_at INTEGER");
    ensureColumn('tool_runs', 'created_by', "ALTER TABLE tool_runs ADD COLUMN created_by TEXT");
    ensureColumn('tool_runs', 'metadata', "ALTER TABLE tool_runs ADD COLUMN metadata TEXT");

    // ==================== Governance History 表字段 ====================
    ensureColumn('governance_history', 'actor_id', "ALTER TABLE governance_history ADD COLUMN actor_id TEXT");
    ensureColumn('governance_history', 'summary', "ALTER TABLE governance_history ADD COLUMN summary TEXT");
    ensureColumn('governance_history', 'payload', "ALTER TABLE governance_history ADD COLUMN payload TEXT");

    // ==================== Thinking Logs 表字段 ====================
    ensureColumn('thinking_logs', 'step_type', "ALTER TABLE thinking_logs ADD COLUMN step_type TEXT");
    ensureColumn('thinking_logs', 'task_id', "ALTER TABLE thinking_logs ADD COLUMN task_id TEXT");
    ensureColumn('thinking_logs', 'content', "ALTER TABLE thinking_logs ADD COLUMN content TEXT");
    ensureColumn('thinking_logs', 'tool_name', "ALTER TABLE thinking_logs ADD COLUMN tool_name TEXT");
    ensureColumn('thinking_logs', 'tool_input', "ALTER TABLE thinking_logs ADD COLUMN tool_input TEXT");
    ensureColumn('thinking_logs', 'tool_output', "ALTER TABLE thinking_logs ADD COLUMN tool_output TEXT");

    // ==================== File Changes 表字段 ====================
    ensureColumn('file_changes', 'task_id', "ALTER TABLE file_changes ADD COLUMN task_id TEXT");
    ensureColumn('file_changes', 'change_type', "ALTER TABLE file_changes ADD COLUMN change_type TEXT");
    ensureColumn('file_changes', 'old_content', "ALTER TABLE file_changes ADD COLUMN old_content TEXT");
    ensureColumn('file_changes', 'new_content', "ALTER TABLE file_changes ADD COLUMN new_content TEXT");
    ensureColumn('file_changes', 'diff', "ALTER TABLE file_changes ADD COLUMN diff TEXT");
    ensureColumn('file_changes', 'line_changes', "ALTER TABLE file_changes ADD COLUMN line_changes TEXT");
    ensureColumn('file_changes', 'reason', "ALTER TABLE file_changes ADD COLUMN reason TEXT");

    // ==================== 数据修复和默认值设置 ====================
    // 确保 tasks 表的默认值
    this.db.prepare("UPDATE tasks SET priority = 'medium' WHERE priority IS NULL OR priority = ''").run();
    this.db.prepare("UPDATE tasks SET title = COALESCE(title, intent) WHERE title IS NULL OR title = ''").run();
    this.db.prepare("UPDATE tasks SET dependencies = '[]' WHERE dependencies IS NULL OR dependencies = ''").run();
  }

  /**
   * 创建索引
   */
  private createIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_session ON notifications(session_id);
      CREATE INDEX IF NOT EXISTS idx_thinking_logs_task ON thinking_logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_thinking_logs_agent ON thinking_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_task ON file_changes(task_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_agent ON file_changes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);
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
      const tablesWithSession = [
        'file_changes',
        'thinking_logs',
        'notifications',
        'blackboard_entries',
        'tasks',
        'tool_runs',
        'state_task_states',
        'state_assist_requests',
        'state_sensitive_operation_logs'
      ];

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

  getStateTaskStates(): TaskStateRecord[] {
    const stmt = this.db.prepare('SELECT * FROM state_task_states');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapStateTaskRow(row));
  }

  upsertStateTaskState(record: TaskStateRecord): TaskStateRecord {
    const stmt = this.db.prepare(`
      INSERT INTO state_task_states (
        task_id, session_id, state, previous_state, assigned_to, priority,
        labels, dependencies, blocked_by, context, history, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        session_id = excluded.session_id,
        state = excluded.state,
        previous_state = excluded.previous_state,
        assigned_to = excluded.assigned_to,
        priority = excluded.priority,
        labels = excluded.labels,
        dependencies = excluded.dependencies,
        blocked_by = excluded.blocked_by,
        context = excluded.context,
        history = excluded.history,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.taskId,
      record.sessionId,
      record.state,
      record.previousState,
      record.assignedTo,
      record.priority,
      this.serializeJson(record.labels),
      this.serializeJson(record.dependencies),
      this.serializeJson(record.blockedBy),
      this.serializeJson(record.context),
      this.serializeJson(record.history),
      record.createdAt,
      record.updatedAt
    );

    return record;
  }

  deleteStateTaskState(taskId: string): void {
    this.db.prepare('DELETE FROM state_task_states WHERE task_id = ?').run(taskId);
  }

  getStateAssistRequests(): AssistRequest[] {
    const stmt = this.db.prepare('SELECT * FROM state_assist_requests');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapStateAssistRow(row));
  }

  getStateSensitiveKeywords(): SensitiveKeyword[] {
    const stmt = this.db.prepare('SELECT * FROM state_sensitive_keywords');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapStateSensitiveKeywordRow(row));
  }

  getStateSensitiveOperationLogs(limit?: number): SensitiveOperationLog[] {
    let sql = 'SELECT * FROM state_sensitive_operation_logs ORDER BY timestamp DESC';
    const params: any[] = [];
    if (limit && Number.isFinite(limit)) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapStateSensitiveOperationRow(row));
  }

  getStateAceStates(): AceStateRecord[] {
    const stmt = this.db.prepare('SELECT * FROM state_ace_states');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapStateAceRow(row));
  }

  upsertStateAssistRequest(request: AssistRequest): AssistRequest {
    const stmt = this.db.prepare(`
      INSERT INTO state_assist_requests (
        id, task_id, session_id, requester_id, target_agent_id,
        required_capabilities, priority, state, description, context,
        assigned_to, response_deadline, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        session_id = excluded.session_id,
        requester_id = excluded.requester_id,
        target_agent_id = excluded.target_agent_id,
        required_capabilities = excluded.required_capabilities,
        priority = excluded.priority,
        state = excluded.state,
        description = excluded.description,
        context = excluded.context,
        assigned_to = excluded.assigned_to,
        response_deadline = excluded.response_deadline,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `);

    stmt.run(
      request.id,
      request.taskId,
      request.sessionId,
      request.requesterId,
      request.targetAgentId,
      this.serializeJson(request.requiredCapabilities),
      request.priority,
      request.state,
      request.description,
      this.serializeJson(request.context),
      request.assignedTo,
      request.responseDeadline,
      request.createdAt,
      request.updatedAt,
      request.completedAt
    );

    return request;
  }

  deleteStateAssistRequest(id: string): void {
    this.db.prepare('DELETE FROM state_assist_requests WHERE id = ?').run(id);
  }

  upsertStateSensitiveKeyword(keyword: SensitiveKeyword): SensitiveKeyword {
    const stmt = this.db.prepare(`
      INSERT INTO state_sensitive_keywords (
        id, keyword, risk_level, action, category, description, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        keyword = excluded.keyword,
        risk_level = excluded.risk_level,
        action = excluded.action,
        category = excluded.category,
        description = excluded.description,
        enabled = excluded.enabled,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      keyword.id,
      keyword.keyword,
      keyword.riskLevel,
      keyword.action,
      keyword.category ?? null,
      keyword.description ?? null,
      keyword.enabled ? 1 : 0,
      keyword.createdAt,
      keyword.updatedAt
    );

    return keyword;
  }

  deleteStateSensitiveKeyword(id: string): void {
    this.db.prepare('DELETE FROM state_sensitive_keywords WHERE id = ?').run(id);
  }

  appendStateSensitiveOperationLog(log: SensitiveOperationLog): void {
    const stmt = this.db.prepare(`
      INSERT INTO state_sensitive_operation_logs (
        id, task_id, session_id, agent_id, operation, matched_keywords,
        risk_level, action, user_confirmed, blocked, context, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      log.id,
      log.taskId ?? null,
      log.sessionId ?? null,
      log.agentId ?? null,
      log.operation ?? null,
      JSON.stringify(log.matchedKeywords ?? []),
      log.riskLevel ?? null,
      log.action ?? null,
      log.userConfirmed === null || log.userConfirmed === undefined ? null : (log.userConfirmed ? 1 : 0),
      log.blocked ? 1 : 0,
      log.context ? JSON.stringify(log.context) : null,
      log.timestamp
    );
  }

  upsertStateAceState(record: AceStateRecord): AceStateRecord {
    const stmt = this.db.prepare(`
      INSERT INTO state_ace_states (
        workspace_root, project_root, last_run_type, last_run_at, last_success_at,
        last_failure_at, failure_streak, last_failure_message, last_index, last_search, last_test, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_root) DO UPDATE SET
        project_root = excluded.project_root,
        last_run_type = excluded.last_run_type,
        last_run_at = excluded.last_run_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        failure_streak = excluded.failure_streak,
        last_failure_message = excluded.last_failure_message,
        last_index = excluded.last_index,
        last_search = excluded.last_search,
        last_test = excluded.last_test,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.workspaceRoot,
      record.projectRoot,
      record.lastRunType,
      record.lastRunAt,
      record.lastSuccessAt,
      record.lastFailureAt,
      record.failureStreak,
      record.lastFailureMessage,
      record.lastIndex ? JSON.stringify(record.lastIndex) : null,
      record.lastSearch ? JSON.stringify(record.lastSearch) : null,
      record.lastTest ? JSON.stringify(record.lastTest) : null,
      record.updatedAt
    );
    return record;
  }

  deleteStateAceState(workspaceRoot: string): void {
    this.db.prepare('DELETE FROM state_ace_states WHERE workspace_root = ?').run(workspaceRoot);
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

  private mapStateTaskRow(row: any): TaskStateRecord {
    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      state: row.state,
      previousState: row.previous_state ?? null,
      assignedTo: row.assigned_to ?? null,
      priority: row.priority ?? 'medium',
      labels: row.labels ? JSON.parse(row.labels) : [],
      dependencies: row.dependencies ? JSON.parse(row.dependencies) : [],
      blockedBy: row.blocked_by ? JSON.parse(row.blocked_by) : [],
      context: row.context ? JSON.parse(row.context) : {},
      history: row.history ? JSON.parse(row.history) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapStateAssistRow(row: any): AssistRequest {
    return {
      id: row.id,
      taskId: row.task_id ?? '',
      sessionId: row.session_id ?? '',
      requesterId: row.requester_id ?? '',
      targetAgentId: row.target_agent_id ?? null,
      requiredCapabilities: row.required_capabilities ? JSON.parse(row.required_capabilities) : [],
      priority: row.priority ?? 'normal',
      state: row.state ?? 'requested',
      description: row.description ?? '',
      context: row.context ? JSON.parse(row.context) : {},
      assignedTo: row.assigned_to ?? null,
      responseDeadline: row.response_deadline ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null
    };
  }

  private serializeJson(value: any): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    return JSON.stringify(value);
  }

  private mapStateSensitiveKeywordRow(row: any): SensitiveKeyword {
    return {
      id: row.id,
      keyword: row.keyword,
      riskLevel: row.risk_level,
      action: row.action,
      category: row.category ?? null,
      description: row.description ?? null,
      enabled: !!row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapStateSensitiveOperationRow(row: any): SensitiveOperationLog {
    return {
      id: row.id,
      taskId: row.task_id ?? null,
      sessionId: row.session_id ?? null,
      agentId: row.agent_id ?? null,
      operation: row.operation ?? null,
      matchedKeywords: row.matched_keywords ? JSON.parse(row.matched_keywords) : [],
      riskLevel: row.risk_level ?? null,
      action: row.action ?? null,
      userConfirmed: row.user_confirmed === null ? null : !!row.user_confirmed,
      blocked: !!row.blocked,
      context: row.context ? JSON.parse(row.context) : {},
      timestamp: row.timestamp
    };
  }

  private mapStateAceRow(row: any): AceStateRecord {
    return {
      workspaceRoot: row.workspace_root,
      projectRoot: row.project_root ?? null,
      lastRunType: row.last_run_type ?? null,
      lastRunAt: row.last_run_at ?? null,
      lastSuccessAt: row.last_success_at ?? null,
      lastFailureAt: row.last_failure_at ?? null,
      failureStreak: row.failure_streak ?? 0,
      lastFailureMessage: row.last_failure_message ?? null,
      lastIndex: row.last_index ? JSON.parse(row.last_index) : null,
      lastSearch: row.last_search ? JSON.parse(row.last_search) : null,
      lastTest: row.last_test ? JSON.parse(row.last_test) : null,
      updatedAt: row.updated_at ?? Date.now()
    };
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
        id, session_id, agent_id, content, priority,
        category, visibility, tags, reply_to, message_references, reference_type,
        reference_id, mentions, expires_at, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.session_id,
      entry.agent_id,
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
          : 'agent_summary')) as BlackboardCategory;
    const derivedVisibility: BlackboardVisibility =
      (row.visibility && row.visibility.length > 0
        ? row.visibility
        : 'blackboard') as BlackboardVisibility;

    return {
      id: row.id,
      session_id: row.session_id,
      agent_id: row.agent_id,
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
    updates: Partial<Pick<BlackboardEntry, 'content' | 'priority' | 'tags' | 'references' | 'reference_type' | 'reference_id' | 'payload'>>
  ): BlackboardEntry | null {
    const existing = this.getBlackboardEntry(id);
    if (!existing) {
      return null;
    }
    const next: BlackboardEntry = {
      ...existing,
      ...updates,
      content: updates.content !== undefined ? updates.content : existing.content,
      tags: updates.tags !== undefined ? updates.tags : existing.tags,
      references: updates.references !== undefined ? updates.references : existing.references,
      reference_type: updates.reference_type !== undefined ? updates.reference_type : existing.reference_type,
      reference_id: updates.reference_id !== undefined ? updates.reference_id : existing.reference_id,
      payload: updates.payload !== undefined ? updates.payload : existing.payload,
      priority: updates.priority ?? existing.priority
    };

    const stmt = this.db.prepare(`
      UPDATE blackboard_entries
      SET content = ?, priority = ?, tags = ?, message_references = ?, reference_type = ?, reference_id = ?, payload = ?
      WHERE id = ?
    `);
    stmt.run(
      next.content,
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

  // ==================== Topics/Votes 已移除 ====================

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
    const sessionId = run.session_id ?? 'global';
    const stmt = this.db.prepare(`
      INSERT INTO tool_runs (
        id, session_id, task_id, workflow_instance_id, tool_name, runner, source,
        command, input, output, status, exit_code, error, created_at, started_at,
        completed_at, created_by, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      run.id,
      sessionId,
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

  // ==================== Governance History (REMOVED) ====================

  close() {
    this.db.close();
  }
}
