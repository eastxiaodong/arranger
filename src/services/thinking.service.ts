import type { DatabaseManager } from '../database';
import type { TypedEventEmitter } from '../events/emitter';
import type { ThinkingLog, ThinkingStepType } from '../types';

/**
 * ThinkingLog Service - 管理思考日志
 */
export class ThinkingService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

  /**
   * 创建思考日志
   */
  createThinkingLog(log: Omit<ThinkingLog, 'id' | 'created_at'>): ThinkingLog {
    const now = Date.now();
    const stmt = this.db['db'].prepare(`
      INSERT INTO thinking_logs (
        session_id, agent_id, task_id, step_type, content,
        tool_name, tool_input, tool_output, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
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

    const created: ThinkingLog = {
      id: String(result.lastInsertRowid),
      ...log,
      created_at: now
    };

    try {
      const allLogs = this.getThinkingLogs();
      this.events.emit('thinking_logs_update', allLogs);
    } catch (error) {
      console.error('[ThinkingService] Failed to emit thinking_logs_update:', error);
    }

    return created;
  }

  /**
   * 获取思考日志
   */
  getThinkingLogs(filters?: {
    session_id?: string;
    agent_id?: string;
    task_id?: string;
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

    query += ' ORDER BY created_at ASC';
    const stmt = this.db['db'].prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      ...row,
      tool_input: row.tool_input ? JSON.parse(row.tool_input) : null,
      tool_output: row.tool_output ? JSON.parse(row.tool_output) : null
    }));
  }

  /**
   * 删除思考日志
   */
  deleteThinkingLogs(taskId: string): void {
    const stmt = this.db['db'].prepare('DELETE FROM thinking_logs WHERE task_id = ?');
    stmt.run(taskId);
    try {
      const allLogs = this.getThinkingLogs();
      this.events.emit('thinking_logs_update', allLogs);
    } catch (error) {
      console.error('[ThinkingService] Failed to emit thinking_logs_update after delete:', error);
    }
  }
}
