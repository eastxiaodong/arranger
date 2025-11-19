/**
 * 状态编排层核心实现
 * 单一事实源（SSOT），集中管理所有业务状态
 */

import { TypedEventEmitter } from '../../core/events/emitter';
import { DatabaseManager } from '../../core/database';
import type {
  Task,
  TaskStateRecord,
  TaskStateTransition,
  AssistRequest,
  AgentHealthRecord,
  SensitiveKeyword,
  SensitiveOperationLog,
  TaskState,
  AssistState,
  AgentHealthStatus,
  TaskStateFilter,
  AssistRequestFilter,
  AgentHealthFilter,
  SensitiveKeywordFilter,
  AceStateRecord,
  AceRunUpdatePayload,
  AceRunSummary,
  AceRunType,
  ToolRun,
  ToolRunFilter,
  Conversation,
  Message
} from '../../core/types';

/**
 * 定义了任务状态之间所有合法的转移路径。
 * key: 当前状态 (from)
 * value: Set<下一个合法状态 (to)>
 */
const TASK_STATE_TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  'pending': new Set(['active', 'blocked']),
  'active': new Set(['blocked', 'needs-confirm', 'finalizing', 'failed']),
  'blocked': new Set(['reassigning', 'active']),
  'needs-confirm': new Set(['active', 'blocked']),
  'reassigning': new Set(['active', 'blocked']),
  'finalizing': new Set(['done']),
  'failed': new Set(['reassigning', 'blocked']),
  'done': new Set([]), // 终态，不可转移
};

export class StateStore {
  private taskStates = new Map<string, TaskStateRecord>();
  private assistRequests = new Map<string, AssistRequest>();
  private agentHealth = new Map<string, AgentHealthRecord>();
  private conversations = new Map<string, Conversation>(); // 新增：用于存储对话历史
  private sensitiveKeywords = new Map<string, SensitiveKeyword>();
  private sensitiveOperationLogs: SensitiveOperationLog[] = [];
  private aceStates = new Map<string, AceStateRecord>();
  private toolRuns: ToolRun[] = [];
  private readonly toolRunCacheLimit = 500;
  private initialized = false;
  
  constructor(
    private readonly db: DatabaseManager,
    private readonly events: TypedEventEmitter
  ) {}

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.reloadAll();
    this.initialized = true;
  }

  dispose(): void {
    this.initialized = false;
  }

  reset(): void {
    this.taskStates.clear();
    this.assistRequests.clear();
    this.agentHealth.clear();
    this.conversations.clear();
    this.sensitiveKeywords.clear();
    this.sensitiveOperationLogs = [];
    this.aceStates.clear();
    this.toolRuns = [];
    this.initialized = false;
    this.events.emit('state:all_cleared', null);
  }

  private reloadAll() {
    this.taskStates.clear();
    const storedTasks = this.db.getStateTaskStates();
    if (storedTasks.length) {
      storedTasks.forEach(record => this.taskStates.set(record.taskId, record));
    } else {
      this.seedTaskStatesFromTasks();
    }

    this.assistRequests.clear();
    const storedAssists = this.db.getStateAssistRequests();
    storedAssists.forEach(request => this.assistRequests.set(request.id, request));

    this.conversations.clear();
    const storedConversations = this.db.getConversations({});
    storedConversations.forEach(convo => this.conversations.set(convo.id, convo));

    this.toolRuns = this.db.getToolRuns({ limit: this.toolRunCacheLimit });

    this.sensitiveKeywords.clear();
    this.db.getStateSensitiveKeywords().forEach(keyword => this.sensitiveKeywords.set(keyword.id, keyword));
    this.sensitiveOperationLogs = this.db.getStateSensitiveOperationLogs(1000);

    this.aceStates.clear();
    this.db.getStateAceStates().forEach(state => this.aceStates.set(state.workspaceRoot, state));
  }

  private seedTaskStatesFromTasks() {
    const tasks = this.db.getTasks({});
    tasks.forEach(task => {
      const record = this.buildTaskStateFromTask(task);
      this.persistTaskState(record);
    });
  }

  private buildTaskStateFromTask(task: Task): TaskStateRecord {
    return {
      taskId: task.id,
      sessionId: task.session_id,
      state: this.normalizeLegacyTaskState(task.status),
      previousState: null,
      assignedTo: task.assigned_to || null,
      priority: task.priority || 'medium',
      labels: Array.isArray(task.labels) ? task.labels : [],
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      blockedBy: [],
      context: task.metadata?.context && typeof task.metadata.context === 'object'
        ? task.metadata.context
        : {},
      history: [],
      createdAt: task.created_at,
      updatedAt: task.updated_at ?? task.created_at
    };
  }

  private normalizeLegacyTaskState(status: Task['status']): TaskState {
    switch (status) {
      case 'running':
        return 'active';
      case 'needs-confirm':
        return 'needs-confirm';
      case 'completed':
        return 'done';
      case 'failed':
        return 'failed';
      case 'blocked':
      case 'paused':
        return 'blocked';
      case 'queued':
      case 'assigned':
        return 'pending';
      case 'pending':
      default:
        return 'pending';
    }
  }

  // ==================== 任务状态管理 ====================

  getTaskState(taskId: string): TaskStateRecord | null {
    return this.taskStates.get(taskId) || null;
  }

  queryTaskStates(filter: TaskStateFilter): TaskStateRecord[] {
    let results = Array.from(this.taskStates.values());
    
    if (filter.taskId) {
      results = results.filter(t => t.taskId === filter.taskId);
    }
    if (filter.sessionId) {
      results = results.filter(t => t.sessionId === filter.sessionId);
    }
    if (filter.state) {
      results = results.filter(t => t.state === filter.state);
    }
    if (filter.assignedTo) {
      results = results.filter(t => t.assignedTo === filter.assignedTo);
    }
    if (filter.labels && filter.labels.length > 0) {
      results = results.filter(t => 
        filter.labels!.some(label => t.labels.includes(label))
      );
    }
    
    return results;
  }

  createTaskState(record: Omit<TaskStateRecord, 'history' | 'createdAt' | 'updatedAt'>): TaskStateRecord {
    const now = Date.now();
    const taskState: TaskStateRecord = {
      ...record,
      history: [],
      createdAt: now,
      updatedAt: now
    };
    this.persistTaskState(taskState);
    this.events.emit('state:task_created', taskState); // 强类型事件
    
    return taskState;
  }

  transitionTaskState(
    taskId: string,
    newState: TaskState,
    reason: string,
    triggeredBy: string
  ): TaskStateRecord | null {
    const taskState = this.taskStates.get(taskId);
    if (!taskState) {
      return null;
    }

    if (taskState.state === newState) {
      return taskState;
    }

    const allowedNextStates = TASK_STATE_TRANSITIONS[taskState.state];
    if (!allowedNextStates || !allowedNextStates.has(newState)) {
      console.warn(
        `[StateStore] 拒绝非法状态转移: 从 ${taskState.state} 到 ${newState}。原因: ${reason}, 操作者: ${triggeredBy}`
      );
      return taskState;
    }

    const transition: TaskStateTransition = {
      from: taskState.state,
      to: newState,
      reason,
      triggeredBy,
      timestamp: Date.now()
    };

    taskState.previousState = taskState.state;
    taskState.state = newState;
    taskState.history.push(transition);
    taskState.updatedAt = Date.now();

    this.persistTaskState(taskState);
    this.events.emit('state:task_transitioned', { taskState, transition }); // 强类型事件
    
    return taskState;
  }

  updateTaskState(taskId: string, updates: Partial<Omit<TaskStateRecord, 'taskId' | 'history' | 'createdAt'>>): TaskStateRecord | null {
    const taskState = this.taskStates.get(taskId);
    if (!taskState) {
      return null;
    }

    Object.assign(taskState, updates, { updatedAt: Date.now() });
    this.persistTaskState(taskState);
    this.events.emit('state:task_updated', taskState); // 强类型事件
    
    return taskState;
  }

  deleteTaskState(taskId: string): boolean {
    const deleted = this.taskStates.delete(taskId);
    if (deleted) {
      this.db.deleteStateTaskState(taskId);
      this.events.emit('state:task_deleted', taskId); // 强类型事件
    }
    return deleted;
  }

  private persistTaskState(record: TaskStateRecord) {
    this.db.upsertStateTaskState(record);
    this.taskStates.set(record.taskId, record);
  }

  // ==================== 协助请求管理 ====================

  getAssistRequest(id: string): AssistRequest | null {
    return this.assistRequests.get(id) || null;
  }

  queryAssistRequests(filter: AssistRequestFilter): AssistRequest[] {
    let results = Array.from(this.assistRequests.values());
    
    if (filter.id) {
      results = results.filter(r => r.id === filter.id);
    }
    if (filter.taskId) {
      results = results.filter(r => r.taskId === filter.taskId);
    }
    if (filter.sessionId) {
      results = results.filter(r => r.sessionId === filter.sessionId);
    }
    if (filter.requesterId) {
      results = results.filter(r => r.requesterId === filter.requesterId);
    }
    if (filter.targetAgentId) {
      results = results.filter(r => r.targetAgentId === filter.targetAgentId);
    }
    if (filter.state) {
      results = results.filter(r => r.state === filter.state);
    }
    if (filter.priority) {
      results = results.filter(r => r.priority === filter.priority);
    }
    
    return results;
  }

  createAssistRequest(request: Omit<AssistRequest, 'createdAt' | 'updatedAt' | 'completedAt'>): AssistRequest {
    const now = Date.now();
    const assistRequest: AssistRequest = {
      ...request,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    this.persistAssistRequest(assistRequest);
    this.events.emit('state:assist_created', assistRequest); // 强类型事件
    
    return assistRequest;
  }

  updateAssistRequest(id: string, updates: Partial<Omit<AssistRequest, 'id' | 'createdAt'>>): AssistRequest | null {
    const request = this.assistRequests.get(id);
    if (!request) {
      return null;
    }

    Object.assign(request, updates, { updatedAt: Date.now() });
    
    if (updates.state && ['completed', 'timeout', 'cancelled'].includes(updates.state)) {
      request.completedAt = Date.now();
    }

    this.persistAssistRequest(request);
    this.events.emit('state:assist_updated', request); // 强类型事件
    
    return request;
  }

  deleteAssistRequest(id: string): boolean {
    const deleted = this.assistRequests.delete(id);
    if (deleted) {
      this.db.deleteStateAssistRequest(id);
      this.events.emit('state:assist_deleted', id); // 强类型事件
    }
    return deleted;
  }

  private persistAssistRequest(request: AssistRequest) {
    this.db.upsertStateAssistRequest(request);
    this.assistRequests.set(request.id, request);
  }

  // ==================== Agent 健康管理 ====================

  getAgentHealth(agentId: string): AgentHealthRecord | null {
    return this.agentHealth.get(agentId) || null;
  }

  queryAgentHealth(filter: AgentHealthFilter): AgentHealthRecord[] {
    let results = Array.from(this.agentHealth.values());
    
    if (filter.agentId) {
      results = results.filter(h => h.agentId === filter.agentId);
    }
    if (filter.status) {
      results = results.filter(h => h.status === filter.status);
    }
    if (filter.minActiveTaskCount !== undefined) {
      results = results.filter(h => h.activeTaskCount >= filter.minActiveTaskCount!);
    }
    if (filter.maxActiveTaskCount !== undefined) {
      results = results.filter(h => h.activeTaskCount <= filter.maxActiveTaskCount!);
    }
    
    return results;
  }

  updateAgentHealth(agentId: string, updates: Partial<Omit<AgentHealthRecord, 'agentId'>>): AgentHealthRecord {
    const now = Date.now();
    const existing = this.agentHealth.get(agentId) ?? {
      agentId,
      status: 'healthy',
      lastHeartbeat: now,
      activeTaskCount: 0,
      completedTaskCount: 0,
      failedTaskCount: 0,
      avgResponseTime: 0,
      errorRate: 0,
      capabilities: [],
      metadata: {},
      updatedAt: now
    };

    const health: AgentHealthRecord = { ...existing, ...updates, updatedAt: now };
    
    this.agentHealth.set(agentId, health);
    this.events.emit('state:agent_health_updated', health); // 强类型事件
    
    return health;
  }

  deleteAgentHealth(agentId: string): boolean {
    const deleted = this.agentHealth.delete(agentId);
    if (deleted) {
      this.events.emit('state:agent_health_deleted', agentId); // 强类型事件
    }
    return deleted;
  }

  // ==================== 对话历史管理 ====================

  getConversation(id: string): Conversation | null {
    return this.conversations.get(id) || null;
  }

  createConversation(convo: Omit<Conversation, 'createdAt' | 'updatedAt' | 'messages'>): Conversation {
    const now = Date.now();
    const newConversation: Conversation = {
      ...convo,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.upsertConversation(newConversation);
    this.conversations.set(newConversation.id, newConversation);
    this.events.emit('state:conversation_created', newConversation); // 强类型事件
    return newConversation;
  }

  addMessageToConversation(conversationId: string, message: Message): Conversation | null {
    const convo = this.conversations.get(conversationId);
    if (!convo) {
      return null;
    }
    convo.messages.push(message);
    convo.updatedAt = Date.now();
    this.db.upsertConversation(convo);
    this.conversations.set(conversationId, convo);
    this.events.emit('state:conversation_updated', convo); // 强类型事件
    return convo;
  }

  deleteConversation(id: string): boolean {
    const deleted = this.conversations.delete(id);
    if (deleted) {
      this.db.deleteConversation(id);
      this.events.emit('state:conversation_deleted', id); // 强类型事件
    }
    return deleted;
  }

  // ==================== 工具运行记录 ====================

  getToolRun(runId: string): ToolRun | null {
    const cached = this.toolRuns.find(run => run.id === runId);
    if (cached) {
      return cached;
    }
    const record = this.db.getToolRun(runId);
    if (record) {
      this.upsertToolRunCache(record);
    }
    return record ?? null;
  }

  getToolRuns(filter?: ToolRunFilter): ToolRun[] {
    let runs = [...this.toolRuns];

    if (filter?.session_id) {
      runs = runs.filter(run => run.session_id === filter.session_id);
    }
    if (filter?.task_id) {
      runs = runs.filter(run => run.task_id === filter.task_id);
    }
    if (filter?.statuses && filter.statuses.length > 0) {
      const statusSet = new Set(filter.statuses);
      runs = runs.filter(run => statusSet.has(run.status));
    }

    const limit = filter?.limit ?? (filter?.session_id ? this.toolRunCacheLimit : 200);
    return runs.slice(0, limit);
  }

  createToolRun(run: Parameters<DatabaseManager['createToolRun']>[0]): ToolRun {
    const record = this.db.createToolRun({
      ...run,
      session_id: run.session_id ?? 'global'
    });
    this.upsertToolRunCache(record);
    this.events.emit('state:tool_run_created', record); // 强类型事件
    this.emitToolRunsUpdate(run.session_id ?? null);
    return record;
  }

  updateToolRun(id: string, updates: Partial<ToolRun>): ToolRun | null {
    const record = this.db.updateToolRun(id, updates);
    if (!record) {
      return null;
    }
    this.upsertToolRunCache(record);
    this.events.emit('state:tool_run_updated', record); // 强类型事件
    this.emitToolRunsUpdate(record.session_id ?? null);
    return record;
  }

  emitToolRunsUpdate(sessionId?: string | null): void {
    const runs = this.getToolRuns(sessionId ? { session_id: sessionId } : undefined);
    this.events.emit('tool_runs_update', runs);
  }

  private upsertToolRunCache(run: ToolRun): void {
    const index = this.toolRuns.findIndex(item => item.id === run.id);
    if (index >= 0) {
      this.toolRuns.splice(index, 1);
    }
    this.toolRuns.unshift(run);
    if (this.toolRuns.length > this.toolRunCacheLimit) {
      this.toolRuns.length = this.toolRunCacheLimit;
    }
  }

  // ==================== ACE 状态 ====================

  getAceState(workspaceRoot?: string): AceStateRecord | null {
    if (workspaceRoot) {
      return this.aceStates.get(workspaceRoot) || null;
    }
    const iterator = this.aceStates.values().next();
    return iterator.done ? null : iterator.value;
  }

  getAllAceStates(): AceStateRecord[] {
    return Array.from(this.aceStates.values());
  }

  updateAceState(workspaceRoot: string, update: AceRunUpdatePayload): AceStateRecord {
    const now = Date.now();
    const record = this.ensureAceStateRecord(workspaceRoot);
    const summaryKey = this.resolveAceSummaryKey(update.type);
    const currentSummary = record[summaryKey];
    let summary: AceRunSummary;

    if (!currentSummary || currentSummary.runId !== update.runId) {
      summary = {
        runId: update.runId,
        type: update.type,
        status: update.status,
        startedAt: now,
        completedAt: update.stage === 'end' ? now : null,
        projectRoot: update.metadata?.projectRoot ?? record.projectRoot,
        query: update.query ?? null,
        message: update.message ?? null,
        stats: update.metadata?.stats ?? null
      };
    } else {
      summary = currentSummary;
      if (update.stage === 'start') {
        summary.startedAt = now;
        summary.completedAt = null;
      } else if (update.stage === 'end') {
        summary.completedAt = now;
      }
      summary.status = update.status;
      if (update.query !== undefined) {
        summary.query = update.query;
      }
      if (update.message !== undefined) {
        summary.message = update.message;
      }
      if (update.metadata?.stats) {
        summary.stats = update.metadata.stats;
      }
      if (update.metadata?.projectRoot) {
        summary.projectRoot = update.metadata.projectRoot;
      }
    }

    if (update.metadata?.projectRoot) {
      record.projectRoot = update.metadata.projectRoot;
    }

    record[summaryKey] = summary;
    record.lastRunType = update.type;
    record.lastRunAt = now;
    record.updatedAt = now;

    if (update.stage === 'end') {
      if (update.status === 'succeeded') {
        record.lastSuccessAt = now;
        record.failureStreak = 0;
        record.lastFailureMessage = null;
      } else if (update.status === 'failed') {
        record.failureStreak = (record.failureStreak || 0) + 1;
        record.lastFailureAt = now;
        record.lastFailureMessage = update.message ?? null;
      }
    }

    this.events.emit('state:ace_state_updated', record); // 强类型事件
    this.db.upsertStateAceState(record);
    return record;
  }

  clearAceState(workspaceRoot: string): boolean {
    const deleted = this.aceStates.delete(workspaceRoot);
    if (deleted) {
      this.db.deleteStateAceState(workspaceRoot);
    }
    return deleted;
  }

  // ==================== 敏感关键字管理 ====================

  getSensitiveKeyword(id: string): SensitiveKeyword | null {
    return this.sensitiveKeywords.get(id) || null;
  }

  querySensitiveKeywords(filter: SensitiveKeywordFilter): SensitiveKeyword[] {
    let results = Array.from(this.sensitiveKeywords.values());
    
    if (filter.keyword) {
      results = results.filter(k => k.keyword.includes(filter.keyword!));
    }
    if (filter.riskLevel) {
      results = results.filter(k => k.riskLevel === filter.riskLevel);
    }
    if (filter.action) {
      results = results.filter(k => k.action === filter.action);
    }
    if (filter.category) {
      results = results.filter(k => k.category === filter.category);
    }
    if (filter.enabled !== undefined) {
      results = results.filter(k => k.enabled === filter.enabled);
    }
    
    return results;
  }

  createSensitiveKeyword(keyword: Omit<SensitiveKeyword, 'createdAt' | 'updatedAt'>): SensitiveKeyword {
    const now = Date.now();
    const record: SensitiveKeyword = {
      ...keyword,
      createdAt: now,
      updatedAt: now
    };
    this.db.upsertStateSensitiveKeyword(record);
    this.sensitiveKeywords.set(keyword.id, record);
    this.events.emit('state:keyword_created', record); // 强类型事件
    
    return record;
  }

  updateSensitiveKeyword(id: string, updates: Partial<Omit<SensitiveKeyword, 'id' | 'createdAt'>>): SensitiveKeyword | null {
    const keyword = this.sensitiveKeywords.get(id);
    if (!keyword) {
      return null;
    }

    Object.assign(keyword, updates, { updatedAt: Date.now() });
    this.db.upsertStateSensitiveKeyword(keyword);
    this.events.emit('state:keyword_updated', keyword); // 强类型事件
    
    return keyword;
  }

  deleteSensitiveKeyword(id: string): boolean {
    const deleted = this.sensitiveKeywords.delete(id);
    if (deleted) {
      this.db.deleteStateSensitiveKeyword(id);
      this.events.emit('state:keyword_deleted', id); // 强类型事件
    }
    return deleted;
  }

  // ==================== 敏感操作日志 ====================

  logSensitiveOperation(log: SensitiveOperationLog): void {
    this.db.appendStateSensitiveOperationLog(log);
    this.sensitiveOperationLogs.push(log);
    this.events.emit('state:sensitive_operation_logged', log); // 强类型事件
    
    // 保留最近 10000 条日志
    if (this.sensitiveOperationLogs.length > 10000) {
      this.sensitiveOperationLogs = this.sensitiveOperationLogs.slice(-10000);
    }
  }

  querySensitiveOperationLogs(filter: {
    taskId?: string;
    sessionId?: string;
    agentId?: string;
    riskLevel?: string;
    blocked?: boolean;
    limit?: number;
  }): SensitiveOperationLog[] {
    let results = [...this.sensitiveOperationLogs];
    
    if (filter.taskId) {
      results = results.filter(l => l.taskId === filter.taskId);
    }
    if (filter.sessionId) {
      results = results.filter(l => l.sessionId === filter.sessionId);
    }
    if (filter.agentId) {
      results = results.filter(l => l.agentId === filter.agentId);
    }
    if (filter.riskLevel) {
      results = results.filter(l => l.riskLevel === filter.riskLevel);
    }
    if (filter.blocked !== undefined) {
      results = results.filter(l => l.blocked === filter.blocked);
    }
    
    // 按时间倒序
    results.sort((a, b) => b.timestamp - a.timestamp);
    
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }
    
    return results;
  }

  // ==================== 统计和分析 ====================

  getTaskStateStats(sessionId?: string): {
    total: number;
    byState: Record<TaskState, number>;
    byPriority: Record<string, number>;
  } {
    const tasks = sessionId
      ? this.queryTaskStates({ sessionId })
      : Array.from(this.taskStates.values());

    const stats = tasks.reduce((acc, task) => {
      acc.byState[task.state] = (acc.byState[task.state] || 0) + 1;
      acc.byPriority[task.priority] = (acc.byPriority[task.priority] || 0) + 1;
      return acc;
    }, { byState: {} as Record<TaskState, number>, byPriority: {} as Record<string, number> });

    return {
      total: tasks.length,
      byState: stats.byState,
      byPriority: stats.byPriority
    };
  }

  getAgentHealthStats(): {
    total: number;
    byStatus: Record<AgentHealthStatus, number>;
    totalActiveTasks: number;
    avgResponseTime: number;
    avgErrorRate: number;
  } {
    const agents = Array.from(this.agentHealth.values());

    const stats = agents.reduce((acc, agent) => {
      acc.byStatus[agent.status] = (acc.byStatus[agent.status] || 0) + 1;
      acc.totalActiveTasks += agent.activeTaskCount;
      acc.totalResponseTime += agent.avgResponseTime;
      acc.totalErrorRate += agent.errorRate;
      return acc;
    }, { byStatus: {} as Record<AgentHealthStatus, number>, totalActiveTasks: 0, totalResponseTime: 0, totalErrorRate: 0 });

    return {
      total: agents.length,
      byStatus: stats.byStatus,
      totalActiveTasks: stats.totalActiveTasks,
      avgResponseTime: agents.length > 0 ? stats.totalResponseTime / agents.length : 0,
      avgErrorRate: agents.length > 0 ? stats.totalErrorRate / agents.length : 0
    };
  }

  // ==================== 清理和维护 ====================

  clearSession(sessionId: string): void {
    // 清理任务状态
    const taskIds: string[] = [];
    this.taskStates.forEach((task, id) => {
      if (task.sessionId === sessionId) {
        taskIds.push(id);
      }
    });
    taskIds.forEach(id => this.taskStates.delete(id));

    // 清理协助请求
    const assistIds: string[] = [];
    this.assistRequests.forEach((request, id) => {
      if (request.sessionId === sessionId) {
        assistIds.push(id);
      }
    });
    assistIds.forEach(id => this.assistRequests.delete(id));

    // 清理对话历史
    const convoIds: string[] = [];
    this.conversations.forEach((convo, id) => {
      if (convo.sessionId === sessionId) {
        convoIds.push(id);
      }
    });
    convoIds.forEach(id => this.conversations.delete(id));

    // 清理敏感操作日志
    this.sensitiveOperationLogs = this.sensitiveOperationLogs.filter(
      log => log.sessionId !== sessionId
    );
    const beforeLength = this.toolRuns.length;
    this.toolRuns = this.toolRuns.filter(run => run.session_id !== sessionId);
    if (this.toolRuns.length !== beforeLength) {
      this.emitToolRunsUpdate();
    }

    this.events.emit('state:session_cleared', sessionId); // 强类型事件
  }

  clearAll(): void {
    this.taskStates.clear();
    this.assistRequests.clear();
    this.agentHealth.clear();
    this.conversations.clear();
    this.sensitiveOperationLogs = [];
    this.aceStates.clear();
    this.toolRuns = [];
    this.events.emit('state:all_cleared', null); // 强类型事件
  }

  private ensureAceStateRecord(workspaceRoot: string): AceStateRecord {
    let record = this.aceStates.get(workspaceRoot);
    if (!record) {
      record = {
        workspaceRoot,
        projectRoot: null,
        lastRunType: null,
        lastRunAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        failureStreak: 0,
        lastFailureMessage: null,
        lastIndex: null,
        lastSearch: null,
        lastTest: null,
        updatedAt: Date.now()
      };
      this.aceStates.set(workspaceRoot, record);
    }
    return record;
  }

  private resolveAceSummaryKey(type: AceRunType): 'lastIndex' | 'lastSearch' | 'lastTest' {
    switch (type) {
      case 'search':
        return 'lastSearch';
      case 'test':
        return 'lastTest';
      case 'index':
      default:
        return 'lastIndex';
    }
  }
}
