// Task 服务

import { DatabaseManager } from '../../core/database';
import { TypedEventEmitter } from '../../core/events/emitter';
import { NotificationService } from '../communication/notification.service';
import type {
  Task,
  CreateTaskInput,
  TaskMetrics,
  TaskTimeoutRecord,
  TaskStatus,
  TaskBacklogSummary,
  TaskState,
  TaskStateRecord,
  AgentHealthRecord
} from '../../core/types';
import type { StateStore } from '../state';
import type { AgentService } from '../agent/agent.service';
import type { AceContextService } from '../../application/services/ace-context.service';
import type { MessageService } from '../communication/message.service';

const MAX_CONCURRENT_TASKS_PER_SESSION = 3;
const MAX_PARALLEL_SIBLINGS = 1;
const SERIALIZED_SCOPES = new Set(['workspace']);
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_BASE_MS = 60 * 1000; // 60 秒
const MAX_CONCURRENT_PER_AGENT = 1;

interface TimeoutOutcome {
  task: Task;
  action: 'requeued' | 'failed';
  attempt: number;
  timeoutMs: number;
  delayMs?: number;
}

export class TaskService {
  private latestTimeoutRecord: TaskTimeoutRecord | null = null;
  private lastSweepDurationMs = 0;
  private scheduler?: import('../../application/services/scheduler.service').SchedulerService;

  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter,
    private readonly stateStore: StateStore,
    private readonly agentService: AgentService,
    private readonly aceContext?: AceContextService,
    private notificationService?: NotificationService,
    private messageService?: MessageService,
  ) { }

  setScheduler(scheduler: import('../../application/services/scheduler.service').SchedulerService) {
    this.scheduler = scheduler;
  }

  private broadcastTasks(): void {
    const tasks = this.db.getTasks({});
    this.events.emit('tasks_update', tasks);
    this.broadcastTaskBacklogSummaries(tasks);
    tasks.forEach(task => this.syncTaskState(task));
  }

  private broadcastTaskBacklogSummaries(sourceTasks?: Task[]): void {
    const tasks = sourceTasks ?? this.db.getTasks({});
    const summaries = this.computeTaskBacklogSummaries(tasks);
    this.events.emit('task_backlog_update', summaries);
  }

  getBacklogSummaries(sessionId?: string | null): TaskBacklogSummary[] {
    const tasks = sessionId
      ? this.db.getTasks({ session_id: sessionId })
      : this.db.getTasks({});
    return this.computeTaskBacklogSummaries(tasks);
  }

  private computeTaskBacklogSummaries(tasks: Task[]): TaskBacklogSummary[] {
    const groups = new Map<string, TaskBacklogSummary>();
    tasks.forEach(task => {
      const planLabel = this.extractPlanSourceLabel(task.labels);
      const groupKey = planLabel || `session:${task.session_id}`;
      let summary = groups.get(groupKey);
      if (!summary) {
        const sourceTaskId = planLabel ? planLabel.replace('plan_source:', '') : null;
        summary = {
          id: groupKey,
          session_id: task.session_id,
          title: planLabel ? this.resolvePlanSourceTitle(planLabel) : '当前会话任务',
          total: 0,
          completed: 0,
          running: 0,
          blocked: 0,
          pending: 0,
          source_task_id: sourceTaskId || undefined
        };
        groups.set(groupKey, summary);
      }
      summary.total += 1;
      switch (task.status) {
        case 'completed':
          summary.completed += 1;
          break;
        case 'running':
        case 'assigned':
        case 'queued':
          summary.running += 1;
          break;
        case 'blocked':
        case 'paused':
          summary.blocked += 1;
          break;
        default:
          summary.pending += 1;
      }
    });

    return Array.from(groups.values()).sort((a, b) => {
      if (a.session_id !== b.session_id) {
        return a.session_id.localeCompare(b.session_id);
      }
      const outstandingA = a.total - a.completed;
      const outstandingB = b.total - b.completed;
      if (outstandingA !== outstandingB) {
        return outstandingB - outstandingA;
      }
      return a.title.localeCompare(b.title);
    });
  }

  private extractPlanSourceLabel(labels?: string[] | null): string | null {
    if (!Array.isArray(labels)) {
      return null;
    }
    for (const label of labels) {
      if (typeof label === 'string' && label.startsWith('plan_source:')) {
        return label;
      }
    }
    return null;
  }

  private resolvePlanSourceTitle(planLabel: string | null): string {
    if (!planLabel) {
      return '任务计划';
    }
    const sourceTaskId = planLabel.replace('plan_source:', '');
    if (!sourceTaskId) {
      return '任务计划';
    }
    const sourceTask = this.db.getTask(sourceTaskId);
    return sourceTask?.title || '任务计划';
  }

  private scheduleSessions(sessionIds: Set<string>): boolean {
    let changed = false;
    sessionIds.forEach(sessionId => {
      if (!sessionId) {
        return;
      }
      changed = this.enforceScheduling(sessionId) || changed;
    });
    return changed;
  }

  private enforceScheduling(sessionId: string): boolean {
    let tasks = this.db.getTasks({ session_id: sessionId });
    if (tasks.length === 0) {
      return false;
    }
    const reassigned = this.requeueTasksWithUnavailableAgents(tasks);
    if (reassigned) {
      tasks = this.db.getTasks({ session_id: sessionId });
    }
    const recovered = this.recoverStuckTasks(tasks).changed;
    const concurrencyChanged = this.applyConcurrencyRules(tasks);
    return reassigned || recovered || concurrencyChanged;
  }

  private normalizeDependencyList(dependencies: any[], taskId: string): string[] {
    if (!Array.isArray(dependencies)) {
      return [];
    }
    const unique = new Set<string>();
    dependencies.forEach((dep) => {
      if (dep === undefined || dep === null) {
        return;
      }
      const depId = String(dep).trim();
      if (!depId || depId === taskId) {
        return;
      }
      if (!this.db.getTask(depId)) {
        return;
      }
      unique.add(depId);
    });
    return Array.from(unique);
  }

  private reconcileBlockingState(taskId: string): string | null {
    const task = this.db.getTask(taskId);
    if (!task) {
      return null;
    }
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'running') {
      return task.session_id;
    }
    const canExecute = this.canExecuteTask(taskId);
    const desiredStatus: Task['status'] = canExecute
      ? (task.assigned_to ? 'assigned' : 'pending')
      : 'blocked';
    if (desiredStatus !== task.status) {
      const updates: Partial<Task> = { status: desiredStatus };
      if (desiredStatus !== 'blocked') {
        updates.run_after = null;
      }
      this.updateTaskRecord(taskId, updates);
    }
    return task.session_id;
  }

  private reevaluateDependentChain(taskId: string, visited = new Set<string>()): Set<string | null> {
    const tasks = this.db.getTasks({});
    const dependents = tasks.filter(task => task.dependencies?.includes(taskId));
    const sessionIds = new Set<string | null>();
    dependents.forEach(dep => {
      if (visited.has(dep.id)) {
        return;
      }
      visited.add(dep.id);
      const sessionId = this.reconcileBlockingState(dep.id);
      if (sessionId) {
        sessionIds.add(sessionId);
      }
      const nested = this.reevaluateDependentChain(dep.id, visited);
      nested.forEach(id => sessionIds.add(id));
    });
    return sessionIds;
  }

  private updateTaskRecord(id: string, updates: Partial<Task>): Task | null {
    const before = this.db.getTask(id);
    this.db.updateTask(id, updates);
    const updated = this.db.getTask(id);
    if (updated) {
      this.syncTaskState(updated);
      this.evaluateAutoAssign(updated);
      this.reconcileBlockingState(updated.id);
      this.maybeNotifyTaskChange(before, updated);
      this.events.emit('tasks_update', this.db.getTasks({}));
    }
    return updated || null;
  }

  private syncTaskState(task: Task | null) {
    if (!task) {
      return;
    }
    const payload = this.buildTaskStatePayload(task);
    const existing = this.stateStore.getTaskState(task.id);
    if (!existing) {
      this.stateStore.createTaskState(payload);
      return;
    }
    const normalizedState = this.normalizeTaskState(task.status);
    if (existing.state !== normalizedState) {
      this.stateStore.transitionTaskState(task.id, normalizedState, 'sync_status', 'task_service');
    }
    const { taskId, state, previousState, history, createdAt, updatedAt, ...patch } = payload as any;
    this.stateStore.updateTaskState(task.id, patch);
  }

  /**
   * 显式变更任务状态并触发关联操作（状态转移、解阻/阻塞依赖、通知）
   */
  public transitionTaskStatus(id: string, nextStatus: Task['status'], reason: string, actor: string = 'system'): Task | null {
    const task = this.db.getTask(id);
    if (!task) {
      return null;
    }
    if (task.status === nextStatus) {
      return task;
    }
    const before = { ...task };
    const updated = this.updateTaskRecord(id, { status: nextStatus });
    if (updated && nextStatus === 'completed') {
      const sessions = this.unblockDependentTasks(id);
      sessions.forEach(sessionId => this.scheduleSessions(new Set([sessionId])));
      void this.syncAceForTask(updated);
    }
    if (updated && nextStatus === 'failed') {
      this.blockDependentsOnFailure(id, reason || '任务失败', this.db.getTasks({}), new Set());
    }
    if (updated) {
      // 状态转移事件已由 syncTaskState 发出；额外发送通知
      if (this.notificationService) {
        this.notificationService.sendNotification({
          session_id: updated.session_id,
          level: nextStatus === 'failed' ? 'warning' : 'info',
          title: '任务状态变更',
          message: `任务 ${updated.id}：${before.status} -> ${nextStatus}（${reason || actor}）`,
          metadata: {
            task_id: updated.id,
            from: before.status,
            to: nextStatus,
            actor
          }
        });
      }
    }
    return updated;
  }

  private buildTaskStatePayload(task: Task): Omit<TaskStateRecord, 'history' | 'createdAt' | 'updatedAt'> {
    return {
      taskId: task.id,
      sessionId: task.session_id,
      state: this.normalizeTaskState(task.status),
      previousState: null,
      assignedTo: task.assigned_to || null,
      priority: task.priority || 'medium',
      labels: Array.isArray(task.labels) ? task.labels : [],
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      blockedBy: [],
      context: task.metadata?.context && typeof task.metadata.context === 'object'
        ? task.metadata.context
        : {}
    };
  }

  private maybeNotifyTaskChange(prev: Task | null, next: Task) {
    if (!this.notificationService) {
      return;
    }
    const statusChanged = prev ? prev.status !== next.status : true;
    const assigneeChanged = prev ? prev.assigned_to !== next.assigned_to : !!next.assigned_to;
    const priorityChanged = prev ? prev.priority !== next.priority : false;
    if (!statusChanged && !assigneeChanged && !priorityChanged) {
      return;
    }
    const changes: string[] = [];
    if (statusChanged) {
      changes.push(`状态 ${prev?.status || 'new'} → ${next.status}`);
    }
    if (assigneeChanged) {
      changes.push(`指派 ${prev?.assigned_to || '未指派'} → ${next.assigned_to || '未指派'}`);
    }
    if (priorityChanged) {
      changes.push(`优先级 ${prev?.priority || 'medium'} → ${next.priority}`);
    }
    this.notificationService.sendNotification({
      session_id: next.session_id,
      level: next.status === 'failed' ? 'warning' : 'info',
      title: '任务更新',
      message: `任务 ${next.id}：${changes.join('，')}`,
      metadata: {
        task_id: next.id,
        status: next.status,
        assigned_to: next.assigned_to,
        priority: next.priority
      }
    });
  }

  private normalizeTaskState(status: Task['status']): TaskState {
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

  private releaseTaskLock(taskId: string) {
    // Lock service removed - no longer needed
  }

  // 获取所有任务
  getAllTasks(filters?: { session_id?: string; status?: string; assigned_to?: string }): Task[] {
    return this.db.getTasks(filters);
  }

  private evaluateAutoAssign(task: Task): void {
    if (task.assigned_to || !task.intent) {
      return;
    }
    const state = this.stateStore.getTaskState(task.id);
    if (!state) {
      return;
    }
    // 优先使用调度评分统一选人
    try {
      const best = this.scheduler?.tryAssignBestAgent(state);
      if (best) {
        return;
      }
    } catch (error) {
      // ignore scheduler errors, fallback to legacy scoring
    }
    const candidates = this.agentService.getOnlineLLMAgents();
    if (!candidates.length) {
      return;
    }

    // Calculate load for each candidate
    const agentLoads = new Map<string, number>();
    const allRunningTasks = this.db.getTasks({ status: 'running' });
    const allAssignedTasks = this.db.getTasks({ status: 'assigned' });

    [...allRunningTasks, ...allAssignedTasks].forEach(t => {
      if (t.assigned_to) {
        agentLoads.set(t.assigned_to, (agentLoads.get(t.assigned_to) || 0) + 1);
      }
    });

    const difficulty = this.parseTaskDifficulty(task);
    const requiredTier = difficulty === 'high' ? 7 : difficulty === 'medium' ? 5 : 3;
    const priorityWeight = task.priority === 'high' ? 1.5 : task.priority === 'low' ? 0.75 : 1;

    const scoreAgent = (agent: any) => {
      const tags = (agent.capability_tags || agent.capabilities || []).map((c: string) => c.toLowerCase());
      const intentText = `${task.title || ''} ${task.intent || ''}`.toLowerCase();
      let tagScore = 0;
      tags.forEach((tag: string) => {
        if (intentText.includes(tag)) {
          tagScore += 2;
        }
      });
      const reasoning = typeof agent.reasoning_tier === 'number' ? agent.reasoning_tier : 5;
      const cost = typeof agent.cost_factor === 'number' && agent.cost_factor > 0 ? agent.cost_factor : 1;
      const efficiency = reasoning / cost;
      const tierGap = reasoning - requiredTier;

      // Load Penalty: Reduce score by factor of (1 + load * 2)
      // e.g., load 0 -> factor 1 (no penalty)
      // load 1 -> factor 3 (score / 3)
      // load 2 -> factor 5 (score / 5)
      const currentLoad = agentLoads.get(agent.id) || 0;
      const loadPenaltyFactor = 1 + (currentLoad * 2);

      // 高难度优先高推理；低难度鼓励低成本
      const baseScore = (tagScore * 2 + (tierGap * 1.5 + efficiency)) * priorityWeight;

      return baseScore / loadPenaltyFactor;
    };

    const best = [...candidates]
      .map(agent => ({ agent, score: scoreAgent(agent) }))
      .sort((a, b) => b.score - a.score)[0];

    if (best && best.score > 0) {
      this.updateTaskRecord(task.id, { assigned_to: best.agent.id, status: task.status === 'pending' ? 'assigned' : task.status });
      this.events.emit('tasks_update', this.db.getTasks({}));
    }
  }

  private parseTaskDifficulty(task: Task): 'low' | 'medium' | 'high' {
    const label = (task.labels || []).find(l => typeof l === 'string' && l.startsWith('difficulty:'));
    if (label) {
      const level = label.split(':')[1];
      if (level === 'high' || level === 'medium' || level === 'low') {
        return level;
      }
    }
    const metaLevel = (task.metadata as any)?.difficulty;
    if (metaLevel === 'high' || metaLevel === 'medium' || metaLevel === 'low') {
      return metaLevel;
    }
    return 'medium';
  }

  // 获取单个任务
  getTask(id: string): Task | null {
    return this.db.getTask(id);
  }

  addTaskLabels(taskId: string, labels: string[]): void {
    if (!labels || labels.length === 0) {
      return;
    }
    const task = this.db.getTask(taskId);
    if (!task) {
      return;
    }
    const set = new Set<string>(task.labels || []);
    let changed = false;
    labels.forEach(label => {
      if (!label) {
        return;
      }
      if (!set.has(label)) {
        set.add(label);
        changed = true;
      }
    });
    if (changed) {
      this.updateTaskRecord(taskId, { labels: Array.from(set) });
      this.broadcastTasks();
    }
  }

  removeTaskLabelsByPrefix(taskId: string, prefix: string): void {
    if (!prefix) {
      return;
    }
    const task = this.db.getTask(taskId);
    if (!task || !task.labels || task.labels.length === 0) {
      return;
    }
    const filtered = task.labels.filter(label => !label.startsWith(prefix));
    if (filtered.length === task.labels.length) {
      return;
    }
    this.updateTaskRecord(taskId, { labels: filtered });
    this.broadcastTasks();
  }

  // 创建任务
  createTask(task: CreateTaskInput): Task {
    const normalized = this.prepareTaskInput(task);
    const created = this.db.createTask(normalized);
    this.syncTaskState(created);
    this.evaluateAutoAssign(created);
    this.scheduleSessions(new Set([created.session_id]));
    this.broadcastTasks();
    return created;
  }

  createTaskOnceByLabel(uniqueLabel: string, task: CreateTaskInput): Task | null {
    if (!uniqueLabel) {
      throw new Error('unique label is required');
    }
    const normalized = this.prepareTaskInput(task);
    const labels = new Set(normalized.labels ?? []);
    labels.add(uniqueLabel);
    normalized.labels = Array.from(labels);

    const created = this.db.withTransaction(() => {
      if (this.db.taskExistsWithLabel(uniqueLabel)) {
        return null;
      }
      return this.db.createTask(normalized);
    });

    if (created) {
      this.syncTaskState(created);
      this.scheduleSessions(new Set([created.session_id]));
      this.broadcastTasks();
    }
    return created;
  }

  createTasks(tasks: CreateTaskInput[]): Task[] {
    const created = tasks.map(t => this.db.createTask(this.prepareTaskInput(t)));
    created.forEach(task => this.syncTaskState(task));
    created.forEach(task => this.evaluateAutoAssign(task));
    const sessionIds = new Set(created.map(task => task.session_id));
    this.scheduleSessions(sessionIds);
    this.broadcastTasks();
    return created;
  }

  updateTaskDependencies(taskId: string, dependencyIds: string[]): void {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const normalized = this.normalizeDependencyList(dependencyIds, taskId);
    this.updateTaskRecord(taskId, { dependencies: normalized });
    const affectedSessions = new Set<string>();
    const sessionId = this.reconcileBlockingState(taskId);
    if (sessionId) {
      affectedSessions.add(sessionId);
    }
    const dependentSessions = this.reevaluateDependentChain(taskId);
    dependentSessions.forEach(id => {
      if (id) {
        affectedSessions.add(id);
      }
    });
    if (affectedSessions.size > 0) {
      this.scheduleSessions(affectedSessions as Set<string>);
    }
    this.broadcastTasks();
  }

  // 更新任务
  updateTask(id: string, updates: Partial<Task>): void {
    const existing = this.db.getTask(id);
    this.updateTaskRecord(id, updates);
    if (existing) {
      this.scheduleSessions(new Set([existing.session_id]));
    }
    this.broadcastTasks();
  }

  pauseTask(id: string): void {
    const task = this.db.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    if (task.status === 'completed' || task.status === 'failed') {
      throw new Error('无法暂停已结束的任务');
    }
    this.updateTaskRecord(id, { status: 'paused' });
    this.broadcastTasks();
  }

  resumeTask(id: string): void {
    const task = this.db.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    if (task.status !== 'paused' && task.status !== 'blocked') {
      return;
    }
    const canRun = this.canExecuteTask(id);
    const nextStatus: TaskStatus = canRun ? 'assigned' : 'blocked';
    this.updateTaskRecord(id, {
      status: nextStatus,
      run_after: canRun ? null : task.run_after ?? null,
      last_started_at: canRun ? Date.now() : task.last_started_at ?? null
    });
    this.broadcastTasks();
  }

  // 更新任务状态
  updateTaskStatus(id: string, status: Task['status']): void {
    const existing = this.db.getTask(id);
    const updates: Partial<Task> = { status };
    if (status === 'running') {
      updates.last_started_at = Date.now();
      updates.run_after = null;
    } else if (status === 'completed' || status === 'failed') {
      updates.last_started_at = null;
      updates.run_after = null;
    } else if (status === 'assigned') {
      updates.run_after = null;
    }
    const updated = this.updateTaskRecord(id, updates);
    if (updated && (status === 'assigned' || status === 'running')) {
      void this.prefetchAceContext(updated);
    }
    const sessionId = existing?.session_id ?? this.db.getTask(id)?.session_id ?? null;
    if (sessionId) {
      this.scheduleSessions(new Set([sessionId]));
    }
    this.broadcastTasks();
  }

  // 分配任务
  assignTask(taskId: string, agentId: string): void {
    const task = this.db.getTask(taskId);
    if (!task) {
      return;
    }
    const status = this.canExecuteTask(taskId) ? 'assigned' : 'blocked';
    const updated = this.updateTaskRecord(taskId, {
      assigned_to: agentId,
      status,
      run_after: null
    });
    if (updated && status === 'assigned') {
      void this.prefetchAceContext(updated);
    }
    this.scheduleSessions(new Set([task.session_id]));
    this.broadcastTasks();
  }

  claimTaskForAgent(taskId: string, agentId: string): boolean {
    let claimed = false;
    let sessionId: string | null = null;
    this.db.withTransaction(() => {
      const task = this.db.getTask(taskId);
      if (!task) {
        return;
      }
      sessionId = task.session_id;
      if (task.assigned_to && task.assigned_to !== agentId) {
        return;
      }
      if (!this.canExecuteTask(taskId)) {
        return;
      }
      this.updateTaskRecord(taskId, {
        assigned_to: agentId,
        status: 'assigned',
        run_after: null
      });
      claimed = true;
    });
    if (claimed && sessionId) {
      this.scheduleSessions(new Set([sessionId]));
      this.broadcastTasks();
    } else if (claimed) {
      this.broadcastTasks();
    }
    return claimed;
  }

  releaseTaskClaim(taskId: string, agentId?: string): boolean {
    let released = false;
    let sessionId: string | null = null;
    this.db.withTransaction(() => {
      const task = this.db.getTask(taskId);
      if (!task) {
        return;
      }
      if (agentId && task.assigned_to && task.assigned_to !== agentId) {
        return;
      }
      sessionId = task.session_id;
      this.updateTaskRecord(taskId, {
        assigned_to: null,
        status: 'pending',
        run_after: null
      });
      released = true;
    });
    if (released && sessionId) {
      this.scheduleSessions(new Set([sessionId]));
      this.broadcastTasks();
    } else if (released) {
      this.broadcastTasks();
    }
    return released;
  }

  // 完成任务
  completeTask(id: string, result: { summary?: string; details?: string; artifacts?: any[] }): void {
    const existing = this.db.getTask(id);
    this.updateTaskRecord(id, {
      status: 'completed',
      completed_at: Date.now(),
      result_summary: result.summary || null,
      result_details: result.details || null,
      result_artifacts: result.artifacts || null
    });
    this.releaseTaskLock(id);
    const sessionIds = new Set<string>();
    if (existing) {
      sessionIds.add(existing.session_id);
    }
    const affectedSessions = this.unblockDependentTasks(id);
    affectedSessions.forEach(sessionId => sessionIds.add(sessionId));
    this.scheduleSessions(sessionIds);
    this.broadcastTasks();
    const updated = this.db.getTask(id);
    if (updated) {
      this.events.emit('task_completed', updated);
      void this.syncAceForTask(updated);
    }
  }

  // 失败任务
  failTask(id: string, error: string): void {
    const existing = this.db.getTask(id);
    this.updateTaskRecord(id, {
      status: 'failed',
      result_summary: error,
      last_started_at: null,
      run_after: null
    });
    this.releaseTaskLock(id);
    const tasks = this.db.getTasks({});
    const affectedSessions = this.blockDependentsOnFailure(id, error, tasks, new Set());
    const sessionIds = new Set<string>();
    if (existing) {
      this.notifyTaskFailure(existing, error);
      sessionIds.add(existing.session_id);
    }
    affectedSessions.forEach(sessionId => sessionIds.add(sessionId));
    this.scheduleSessions(sessionIds);
    this.broadcastTasks();
  }

  getSubtasks(parentTaskId: string): Task[] {
    return this.db.getTasks({}).filter(task => task.parent_task_id === parentTaskId);
  }

  getDependencies(taskId: string): string[] {
    const task = this.db.getTask(taskId);
    return task?.dependencies ?? [];
  }

  canExecuteTask(taskId: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task) {
      return false;
    }
    if (!task.dependencies || task.dependencies.length === 0) {
      return true;
    }
    return task.dependencies.every(depId => {
      const dep = this.db.getTask(depId);
      return dep && dep.status === 'completed';
    });
  }

  getExecutableTasks(sessionId: string): Task[] {
    const tasks = this.db.getTasks({ session_id: sessionId });
    return tasks
      .filter(task =>
        (task.status === 'assigned' || task.status === 'queued' || task.status === 'blocked') &&
        this.canExecuteTask(task.id) &&
        (!task.run_after || task.run_after <= Date.now())
      )
      .map(task => ({
        task,
        priorityScore: this.computePriorityScore(task),
        scheduleAt: task.run_after || task.created_at
      }))
      .sort((a, b) => {
        if (a.priorityScore !== b.priorityScore) {
          return b.priorityScore - a.priorityScore;
        }
        return a.scheduleAt - b.scheduleAt;
      })
      .map(item => item.task);
  }

  private computePriorityScore(task: Task): number {
    const priorityOrder = { high: 3, medium: 2, low: 1 } as Record<string, number>;
    const base = priorityOrder[task.priority] ?? 2;
    // 引用难度/成本（标签/metadata）进一步加权
    const difficulty = this.parseTaskDifficulty(task);
    const difficultyWeight = difficulty === 'high' ? 1.5 : difficulty === 'medium' ? 1 : 0.7;
    return base * difficultyWeight;
  }

  getTaskMetrics(sessionId?: string): TaskMetrics {
    const snapshot = this.db.getTasks(sessionId ? { session_id: sessionId } : {});
    const metrics = this.calculateTaskMetrics(snapshot, sessionId);
    metrics.sweep_duration_ms = this.lastSweepDurationMs;
    metrics.session_id = sessionId ?? null;
    metrics.scope = sessionId ? 'session' : 'global';
    return metrics;
  }

  runMaintenanceSweep(): TaskMetrics {
    const startedAt = Date.now();
    const tasks = this.db.getTasks({});
    const sessionIds = new Set(tasks.map(task => task.session_id));
    const changed = sessionIds.size > 0 ? this.scheduleSessions(sessionIds) : false;
    const snapshot = changed ? this.db.getTasks({}) : tasks;
    if (changed) {
      this.broadcastTasks();
    }
    this.lastSweepDurationMs = Date.now() - startedAt;
    const metrics = this.calculateTaskMetrics(snapshot);
    metrics.sweep_duration_ms = this.lastSweepDurationMs;
    metrics.session_id = null;
    metrics.scope = 'global';
    return metrics;
  }

  /**
   * 将任务置为运行中（尊重并行限制），未执行则返回 null
   */
  acquireRunnableTask(sessionId: string): Task | null {
    const candidates = this.getExecutableTasks(sessionId);
    if (!candidates.length) {
      return null;
    }
    const task = candidates[0];
    const updated = this.transitionTaskStatus(task.id, 'running', 'acquire_for_execution', 'task_service');
    return updated;
  }

  unblockDependentTasks(completedTaskId: string): Set<string> {
    const blockedTasks = this.db.getTasks({ status: 'blocked' }).filter(task =>
      task.dependencies?.includes(completedTaskId)
    );

    const sessionIds = new Set<string>();
    blockedTasks.forEach(task => {
      if (this.canExecuteTask(task.id)) {
        // 解除阻塞后回到队列等待调度，避免直接占用 slot
        this.updateTaskRecord(task.id, { status: 'queued', run_after: null });
        sessionIds.add(task.session_id);
      }
    });

    return sessionIds;
  }

  private blockDependentsOnFailure(failedTaskId: string, reason: string, tasks: Task[], visited: Set<string>): Set<string> {
    const sessionIds = new Set<string>();
    const dependents = tasks.filter(task => task.dependencies?.includes(failedTaskId));
    dependents.forEach(task => {
      if (visited.has(task.id)) {
        return;
      }
      visited.add(task.id);
      if (task.status !== 'failed') {
        this.updateTaskRecord(task.id, {
          status: 'blocked',
          result_summary: `依赖 ${failedTaskId} 失败：${reason}`
        });
        sessionIds.add(task.session_id);
      }
      if (task.dependencies && task.dependencies.length > 0) {
        const childSessions = this.blockDependentsOnFailure(task.id, reason, tasks, visited);
        childSessions.forEach(sessionId => sessionIds.add(sessionId));
      }
    });
    return sessionIds;
  }

  private recoverStuckTasks(tasks: Task[]): { changed: boolean } {
    let changed = false;
    const now = Date.now();
    const outcomes: TimeoutOutcome[] = [];
    tasks.forEach(task => {
      if (task.status !== 'running') {
        return;
      }
      const lastStarted = task.last_started_at ?? null;
      if (!lastStarted) {
        return;
      }
      const timeoutMs = this.getTimeoutMs(task);
      if (now - lastStarted <= timeoutMs) {
        return;
      }
      const retryCount = task.retry_count ?? 0;
      const maxRetries = this.getMaxRetries(task);
      if (retryCount < maxRetries) {
        const delay = this.computeBackoff(retryCount);
        this.updateTaskRecord(task.id, {
          status: 'queued',
          run_after: now + delay,
          retry_count: retryCount + 1,
          last_started_at: null,
          result_summary: `任务超时 ${Math.round(timeoutMs / 1000)} 秒，自动重试 (#${retryCount + 1})`
        });
        outcomes.push({
          task,
          action: 'requeued',
          attempt: retryCount + 1,
          timeoutMs,
          delayMs: delay
        });
      } else {
        this.updateTaskRecord(task.id, {
          status: 'failed',
          last_started_at: null,
          run_after: null,
          result_summary: `任务超时 ${Math.round(timeoutMs / 1000)} 秒，已达重试上限`
        });
        outcomes.push({
          task,
          action: 'failed',
          attempt: retryCount,
          timeoutMs
        });
      }
      changed = true;
    });

    if (outcomes.length > 0) {
      outcomes.forEach(outcome => this.handleTimeoutOutcome(outcome));
    }
    return { changed };
  }

  private applyConcurrencyRules(tasks: Task[]): boolean {
    const now = Date.now();
    const runningTasks = tasks.filter(task => task.status === 'running');
    let activeSlots = runningTasks.length;
    const siblingUsage = new Map<string, number>();
    const scopeUsage = new Map<string, number>();
    const agentUsage = new Map<string, number>();

    runningTasks.forEach(task => {
      if (task.parent_task_id) {
        siblingUsage.set(task.parent_task_id, (siblingUsage.get(task.parent_task_id) || 0) + 1);
      }
      if (SERIALIZED_SCOPES.has(task.scope)) {
        scopeUsage.set(task.scope, (scopeUsage.get(task.scope) || 0) + 1);
      }
      if (task.assigned_to) {
        agentUsage.set(task.assigned_to, (agentUsage.get(task.assigned_to) || 0) + 1);
      }
    });

    const readyCandidates = tasks.filter(task =>
      (task.status === 'assigned' || task.status === 'queued') &&
      this.canExecuteTask(task.id) &&
      (!task.run_after || task.run_after <= now)
    );

    readyCandidates.sort((a, b) => {
      const statusRank = this.getStatusRank(a.status) - this.getStatusRank(b.status);
      if (statusRank !== 0) {
        return statusRank;
      }
      const priorityRank = this.getPriorityWeight(a.priority) - this.getPriorityWeight(b.priority);
      if (priorityRank !== 0) {
        return priorityRank;
      }
      return a.created_at - b.created_at;
    });

    const updates: Array<{ id: string; updates: Partial<Task> }> = [];

    readyCandidates.forEach(task => {
      if (task.assigned_to) {
        const availability = this.isAgentAvailable(task.assigned_to);
        if (!availability.available) {
          updates.push({
            id: task.id,
            updates: {
              assigned_to: null,
              status: task.status === 'blocked' ? 'blocked' : 'queued'
            }
          });
          return;
        }
      }
      const siblingLimited = this.isSiblingLimited(task, siblingUsage);
      const scopeLimited = this.isScopeLimited(task, scopeUsage);
      const agentLimited = task.assigned_to
        ? (agentUsage.get(task.assigned_to) || 0) >= MAX_CONCURRENT_PER_AGENT
        : false;
      if (activeSlots < MAX_CONCURRENT_TASKS_PER_SESSION && !siblingLimited && !scopeLimited && !agentLimited) {
        if (task.status !== 'assigned') {
          updates.push({ id: task.id, updates: { status: 'assigned' } });
        }
        activeSlots += 1;
        if (task.parent_task_id) {
          siblingUsage.set(task.parent_task_id, (siblingUsage.get(task.parent_task_id) || 0) + 1);
        }
        if (SERIALIZED_SCOPES.has(task.scope)) {
          scopeUsage.set(task.scope, (scopeUsage.get(task.scope) || 0) + 1);
        }
        if (task.assigned_to) {
          agentUsage.set(task.assigned_to, (agentUsage.get(task.assigned_to) || 0) + 1);
        }
      } else if (task.status === 'assigned') {
        updates.push({ id: task.id, updates: { status: 'queued' } });
        activeSlots = Math.max(runningTasks.length, activeSlots - 1);
      }
    });

    if (updates.length === 0) {
      return false;
    }

    updates.forEach(entry => {
      this.updateTaskRecord(entry.id, entry.updates);
    });
    return true;
  }

  private isSiblingLimited(task: Task, usage: Map<string, number>): boolean {
    if (!task.parent_task_id) {
      return false;
    }
    return (usage.get(task.parent_task_id) || 0) >= MAX_PARALLEL_SIBLINGS;
  }

  private isScopeLimited(task: Task, usage: Map<string, number>): boolean {
    if (!SERIALIZED_SCOPES.has(task.scope)) {
      return false;
    }
    return (usage.get(task.scope) || 0) >= 1;
  }

  private getStatusRank(status: Task['status']): number {
    if (status === 'assigned') {
      return 0;
    }
    if (status === 'queued') {
      return 1;
    }
    return 2;
  }

  private getPriorityWeight(priority: Task['priority']): number {
    if (priority === 'high') {
      return 0;
    }
    if (priority === 'medium') {
      return 1;
    }
    return 2;
  }

  private computeBackoff(retryCount: number): number {
    return RETRY_BACKOFF_BASE_MS * Math.pow(2, Math.min(retryCount, 4));
  }

  /**
   * 将指定 Agent 的任务退回队列，供重新调度
   */
  reassignTasksForAgent(agentId: string, reason: string): number {
    const tasks = this.db.getTasks({ assigned_to: agentId });
    if (!tasks || tasks.length === 0) {
      return 0;
    }
    let changed = 0;
    tasks.forEach(task => {
      const nextStatus: Task['status'] = task.status === 'blocked' ? 'blocked' : 'queued';
      this.updateTaskRecord(task.id, {
        assigned_to: null,
        status: nextStatus,
        result_summary: task.result_summary || undefined
      });
      changed++;
      this.notificationService?.sendNotification({
        session_id: task.session_id,
        level: 'warning',
        title: '任务重新排队',
        message: `任务 ${task.id} 的 Agent ${agentId} 不可用，已回队等待重新指派（${reason}）`,
        metadata: {
          task_id: task.id,
          agent_id: agentId,
          reason
        }
      });
    });
    if (changed > 0) {
      this.broadcastTasks();
    }
    return changed;
  }

  private requeueTasksWithUnavailableAgents(tasks: Task[]): boolean {
    let changed = false;
    tasks.forEach(task => {
      if (!task.assigned_to) {
        return;
      }
      if (task.status === 'running') {
        return;
      }
      const availability = this.isAgentAvailable(task.assigned_to);
      if (availability.available) {
        return;
      }
      const previousAssignee = task.assigned_to;
      const nextStatus: Task['status'] = task.status === 'blocked' ? 'blocked' : 'queued';
      this.updateTaskRecord(task.id, {
        assigned_to: null,
        status: nextStatus
      });
      changed = true;
      this.notificationService?.sendNotification({
        session_id: task.session_id,
        level: 'warning',
        title: '任务重新排队',
        message: `任务 ${task.id} 的指派 Agent 不可用（${availability.reason || '未知原因'}），已回到队列等待重新指派。`,
        metadata: {
          task_id: task.id,
          agent_id: previousAssignee,
          reason: availability.reason || 'unavailable_agent'
        }
      });
    });
    return changed;
  }

  private isAgentAvailable(agentId: string): { available: boolean; reason?: string } {
    const agent = this.agentService.getAgent(agentId);
    if (!agent) {
      return { available: false, reason: 'Agent 不存在' };
    }
    if (agent.is_enabled === false) {
      return { available: false, reason: 'Agent 已停用' };
    }
    if (agent.status === 'offline') {
      return { available: false, reason: 'Agent 离线' };
    }
    const health: AgentHealthRecord | null = this.stateStore.getAgentHealth(agentId);
    if (health && (health.status === 'offline' || health.status === 'unhealthy')) {
      return { available: false, reason: 'Agent 健康状态不可用' };
    }
    return { available: true };
  }

  private calculateTaskMetrics(tasks: Task[], sessionId?: string): TaskMetrics {
    const metrics: TaskMetrics = {
      total: tasks.length,
      running: 0,
      queued: 0,
      blocked: 0,
      failed: 0,
      updated_at: Date.now(),
      last_timeout:
        !sessionId || this.latestTimeoutRecord?.session_id === sessionId
          ? this.latestTimeoutRecord
          : null,
      sweep_duration_ms: this.lastSweepDurationMs
    };

    tasks.forEach(task => {
      if (task.status === 'running') {
        metrics.running += 1;
      } else if (task.status === 'queued' || task.status === 'assigned') {
        metrics.queued += 1;
      } else if (task.status === 'blocked') {
        metrics.blocked += 1;
      } else if (task.status === 'failed') {
        metrics.failed += 1;
      }
    });

    return metrics;
  }

  private notifyTaskFailure(task: Task, reason: string): void {
    const message = `任务「${task.title || task.intent || task.id}」失败：${reason}`;
    this.latestTimeoutRecord = {
      task_id: task.id,
      task_title: task.title || task.intent || task.id,
      session_id: task.session_id,
      action: 'task_failed',
      attempt: null,
      timeout_ms: null,
      message,
      occurred_at: Date.now()
    };
    this.notificationService?.sendNotification({
      session_id: task.session_id,
      level: 'error',
      title: '任务失败',
      message,
      metadata: this.buildTaskNotificationMetadata(task)
    });
    this.logTaskEvent(task, 'task_failed', message, { reason });
  }

  private handleTimeoutOutcome(outcome: TimeoutOutcome): void {
    const title =
      outcome.action === 'failed'
        ? '任务超时失败'
        : '任务超时重试';
    const baseName = outcome.task.title || outcome.task.intent || outcome.task.id;
    const summary =
      outcome.action === 'failed'
        ? `任务「${baseName}」超时（>${Math.round(outcome.timeoutMs / 1000)} 秒），已达最大重试次数`
        : `任务「${baseName}」超时（>${Math.round(outcome.timeoutMs / 1000)} 秒），将在 ${Math.round((outcome.delayMs ?? 0) / 1000)} 秒后第 ${outcome.attempt} 次重试`;
    const actionCode = outcome.action === 'failed' ? 'task_timeout_failed' : 'task_timeout_requeued';

    this.latestTimeoutRecord = {
      task_id: outcome.task.id,
      task_title: baseName,
      session_id: outcome.task.session_id,
      action: actionCode,
      attempt: outcome.attempt,
      timeout_ms: outcome.timeoutMs,
      message: summary,
      occurred_at: Date.now()
    };

    this.notificationService?.sendNotification({
      session_id: outcome.task.session_id,
      level: outcome.action === 'failed' ? 'error' : 'warning',
      title,
      message: summary,
      metadata: this.buildTaskNotificationMetadata(outcome.task)
    });

    this.logTaskEvent(outcome.task, actionCode, summary, {
      attempt: outcome.attempt,
      timeout_ms: outcome.timeoutMs,
      delay_ms: outcome.delayMs ?? null
    });
  }

  /**
   * 在任务进入 assigned/运行前，主动从 ACE 检索上下文，提示 Agent 参考历史产出。
   */
  private async prefetchAceContext(task: Task): Promise<void> {
    if (!this.aceContext || typeof this.aceContext.isConfigured !== 'function') {
      return;
    }
    if (!this.aceContext.isConfigured()) {
      return;
    }
    const metadata = task.metadata && typeof task.metadata === 'object' ? { ...task.metadata } : {};
    if (metadata.ace_prefetched) {
      return;
    }
    const query = [task.title, task.intent, task.description].filter(Boolean).join(' ').slice(0, 200);
    try {
      const result = await this.aceContext.search(query || '当前任务');
      metadata.ace_prefetched = true;
      metadata.ace_context = result;
      this.updateTaskRecord(task.id, { metadata });
      this.pushAceContextMessage(task, result, 'success');
      this.notificationService?.sendNotification({
        session_id: task.session_id,
        level: 'info',
        title: 'ACE 检索完成',
        message: `任务 ${task.id} 已检索历史上下文，建议参考`,
        metadata: { task_id: task.id }
      });
    } catch (error: any) {
      metadata.ace_prefetched = true;
      metadata.ace_context_error = error?.message ?? '检索失败';
      this.updateTaskRecord(task.id, { metadata });
      this.pushAceContextMessage(task, metadata.ace_context_error, 'error');
      this.notificationService?.sendNotification({
        session_id: task.session_id,
        level: 'warning',
        title: 'ACE 检索失败',
        message: `任务 ${task.id} 检索失败：${metadata.ace_context_error}`,
        metadata: { task_id: task.id }
      });
    }
  }

  private pushAceContextMessage(task: Task, raw: string, status: 'success' | 'error') {
    if (!this.messageService) return;
    const snippet = (raw || '').toString().slice(0, 600);
    const suffix = raw && raw.length > 600 ? '…' : '';
    const assignedAgent = task.assigned_to || undefined;
    const content = status === 'success'
      ? `ACE 检索到相关上下文（任务 ${task.id}）：${snippet}${suffix}`
      : `ACE 检索失败（任务 ${task.id}）：${snippet}${suffix}`;
    this.messageService.sendMessage({
      id: `ace_ctx_${task.id}_${Date.now()}`,
      session_id: task.session_id,
      agent_id: 'ace_context',
      content,
      priority: 'medium',
      tags: ['ace'],
      reply_to: null,
      references: [`task:${task.id}`],
      reference_type: 'task',
      reference_id: task.id,
      mentions: assignedAgent ? [assignedAgent] : null,
      expires_at: null,
      category: 'agent_summary',
      visibility: 'blackboard',
      payload: {
        status
      }
    });
  }

  private getMaxRetries(task: Task): number {
    if (typeof task.max_retries === 'number' && task.max_retries >= 0) {
      return task.max_retries;
    }
    return DEFAULT_MAX_RETRIES;
  }

  private getTimeoutMs(task: Task): number {
    if (typeof task.timeout_seconds === 'number' && task.timeout_seconds > 0) {
      return task.timeout_seconds * 1000;
    }
    return DEFAULT_TASK_TIMEOUT_MS;
  }

  private buildTaskNotificationMetadata(task: Task): Record<string, any> {
    const metadata: Record<string, any> = { task_id: task.id };
    return metadata;
  }

  private prepareTaskInput(task: CreateTaskInput): CreateTaskInput {
    const normalizedTitle = this.humanizeTaskTitle(task);
    const baseDependencies = Array.from(new Set((task.dependencies || []).filter(Boolean).map(dep => String(dep))));
    const dependencies = this.mergeCrossBatchDependencies(task, baseDependencies);
    const canExecute = dependencies.length === 0 || dependencies.every(depId => {
      const depTask = this.db.getTask(depId);
      return depTask && depTask.status === 'completed';
    });

    let status = task.status;
    if (!status || status === 'pending' || status === 'assigned' || status === 'running') {
      if (!canExecute) {
        status = 'blocked';
      } else if (task.assigned_to) {
        status = 'assigned';
      } else {
        status = status || 'pending';
      }
    }

    // 处理任务类型标签
    const labels = new Set(task.labels ?? []);
    const taskType = task.metadata?.task_type || task.metadata?.type;
    if (taskType && ['requirement', 'bug', 'documentation', 'misc'].includes(taskType)) {
      labels.add(`type:${taskType}`);
    }

    return {
      ...task,
      title: normalizedTitle,
      status,
      dependencies,
      labels: Array.from(labels),
      retry_count: task.retry_count ?? 0,
      max_retries: task.max_retries ?? null,
      timeout_seconds: task.timeout_seconds ?? null,
      run_after: task.run_after ?? null,
      last_started_at: task.last_started_at ?? null
    };
  }

  /**
   * 记录用户反馈/协助笔记，写入任务 metadata 并推送黑板
   */
  recordUserFeedback(taskId: string, feedback: { type: 'task' | 'process' | 'priority'; content: string; author?: string }): void {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`任务 ${taskId} 不存在`);
    }
    const entry = {
      id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: feedback.type,
      content: feedback.content,
      author: feedback.author || 'user',
      created_at: Date.now()
    };
    const metadata = task.metadata ? { ...task.metadata } : {};
    const feedbackList = Array.isArray((metadata as any).feedback) ? [...(metadata as any).feedback] : [];
    feedbackList.unshift(entry);
    (metadata as any).feedback = feedbackList.slice(0, 50);
    const updates: Partial<Task> = { metadata };
    if (feedback.type === 'priority') {
      const lowered = feedback.content.toLowerCase();
      if (lowered.includes('高') || lowered.includes('high')) {
        updates.priority = 'high';
      } else if (lowered.includes('低') || lowered.includes('low')) {
        updates.priority = 'low';
      } else if (lowered.includes('中') || lowered.includes('medium') || lowered.includes('中等')) {
        updates.priority = 'medium';
      }
    }
    this.updateTask(taskId, updates);
    this.messageService?.sendMessage({
      id: `fb_msg_${entry.id}`,
      session_id: task.session_id,
      agent_id: feedback.author || 'user',
      content: `📌 任务反馈（${feedback.type}）：${feedback.content}`,
      priority: feedback.type === 'priority' ? 'high' : 'medium',
      tags: ['feedback', feedback.type],
      reply_to: null,
      references: [taskId],
      reference_type: 'task',
      reference_id: taskId,
      mentions: null,
      expires_at: null,
      category: 'user',
      visibility: 'blackboard',
      payload: { feedback_id: entry.id }
    });
  }

  /**
   * 跨批次依赖归并：同一会话/计划/目标的任务自动依赖未完成的上游任务
   */
  private mergeCrossBatchDependencies(task: CreateTaskInput, baseDeps: string[]): string[] {
    const merged = new Set<string>(baseDeps);
    const planLabel = this.extractPlanSourceLabel(task.labels);
    const goalId = (task.metadata as any)?.goal_id || (task.metadata as any)?.plan_root_id || null;
    const parentId = task.parent_task_id || null;

    if (!planLabel && !goalId && !parentId) {
      return Array.from(merged);
    }

    const unfinishedStatuses = new Set<Task['status']>([
      'pending',
      'queued',
      'assigned',
      'running',
      'blocked',
      'paused'
    ]);
    const sessionTasks = this.db.getTasks({ session_id: task.session_id });
    sessionTasks.forEach(existing => {
      if (existing.id === task.id) {
        return;
      }
      if (!unfinishedStatuses.has(existing.status)) {
        return;
      }
      const existingPlan = this.extractPlanSourceLabel(existing.labels);
      const existingGoal = (existing.metadata as any)?.goal_id || (existing.metadata as any)?.plan_root_id || null;
      const samePlan = planLabel && existingPlan === planLabel;
      const sameGoal = goalId && existingGoal && goalId === existingGoal;
      const sameParentChain = parentId && (existing.parent_task_id === parentId || existing.id === parentId);
      if (samePlan || sameGoal || sameParentChain) {
        merged.add(existing.id);
      }
    });

    return Array.from(merged);
  }

  private humanizeTaskTitle(task: CreateTaskInput): string {
    const rawTitle = (task.title || '').trim();
    const intent = (task.intent || '').trim();
    if (rawTitle && rawTitle.toLowerCase() !== intent.toLowerCase()) {
      return rawTitle;
    }
    const titleMap: Record<string, string> = {
      coordinate_requirement: '需求编排',
      clarify_requirement: '需求澄清',
      implement_requirement: '需求实现',
      implement_ui: '界面实现',
      implement_backend: '接口实现',
      deliver_requirement: '联调交付',
      respond_to_command: '指令处理',
      answer_question: '问题处理',
      evaluate_suggestion: '建议评估',
      handle_warning: '告警处理'
    };
    const prefix = titleMap[intent.toLowerCase()] || '任务';
    const snippet = this.extractSnippet(task.description || task.intent || '');
    return snippet ? `${prefix}：${snippet}` : prefix;
  }

  private extractSnippet(text?: string | null, max = 24): string {
    if (!text) {
      return '';
    }
    const sanitized = text.replace(/\s+/g, ' ').trim();
    if (!sanitized) {
      return '';
    }
    return sanitized.length > max ? sanitized.slice(0, max) + '…' : sanitized;
  }

  private logTaskEvent(task: Task, action: string, summary: string | null, payload?: Record<string, any> | null) {
    // Governance logging removed
  }

  private async syncAceForTask(task: Task): Promise<void> {
    if (!this.aceContext) {
      return;
    }
    try {
      if (!this.aceContext.isConfigured()) {
        return;
      }
      await this.aceContext.refreshIndex();
      this.notificationService?.sendNotification({
        session_id: task.session_id,
        level: 'info',
        title: 'ACE 已同步',
        message: `任务 ${task.id} 结果已写入索引`,
        metadata: { taskId: task.id }
      });
    } catch (error: any) {
      console.warn('[TaskService] ACE 索引失败:', error?.message || error);
      this.notificationService?.sendNotification({
        session_id: task.session_id,
        level: 'warning',
        title: 'ACE 同步失败',
        message: `任务 ${task.id} 索引失败：${error?.message || error}`,
        metadata: { taskId: task.id, error: error?.message || String(error) }
      });
    }
  }
}
