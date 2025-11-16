// Task 服务

import { DatabaseManager } from '../database';
import { TypedEventEmitter } from '../events/emitter';
import { NotificationService } from './notification.service';
import { GovernanceHistoryService } from './governance-history.service';
import { LockService } from './lock.service';
import type { Task, CreateTaskInput, TaskMetrics, TaskTimeoutRecord, TaskStatus, TaskBacklogSummary } from '../types';
import type { PolicyEnforcer } from './policy-enforcer.service';

const MAX_CONCURRENT_TASKS_PER_SESSION = 3;
const MAX_PARALLEL_SIBLINGS = 1;
const SERIALIZED_SCOPES = new Set(['workspace']);
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_BASE_MS = 60 * 1000; // 60 秒

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
  private policyEnforcer?: PolicyEnforcer;

  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter,
    private notificationService?: NotificationService,
    private governanceHistory?: GovernanceHistoryService,
    private lockService?: LockService
  ) {}

  setPolicyEnforcer(enforcer: PolicyEnforcer) {
    this.policyEnforcer = enforcer;
  }

  private broadcastTasks(): void {
    const tasks = this.db.getTasks({});
    this.events.emit('tasks_update', tasks);
    this.broadcastTaskBacklogSummaries(tasks);
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
    const tasks = this.db.getTasks({ session_id: sessionId });
    if (tasks.length === 0) {
      return false;
    }
    const recovered = this.recoverStuckTasks(tasks).changed;
    const concurrencyChanged = this.applyConcurrencyRules(tasks);
    return recovered || concurrencyChanged;
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
      this.db.updateTask(taskId, updates);
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

  private releaseTaskLock(taskId: string) {
    if (!this.lockService) {
      return;
    }
    const resource = `lock:task:${taskId}`;
    try {
      this.lockService.release(resource);
    } catch (error) {
      console.warn('[TaskService] Failed to release lock', resource, error);
    }
  }

  // 获取所有任务
  getAllTasks(filters?: { session_id?: string; status?: string; assigned_to?: string }): Task[] {
    return this.db.getTasks(filters);
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
      this.db.updateTask(taskId, { labels: Array.from(set) });
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
    this.db.updateTask(taskId, { labels: filtered });
    this.broadcastTasks();
  }

  // 创建任务
  createTask(task: CreateTaskInput): Task {
    const normalized = this.prepareTaskInput(task);
    const created = this.db.createTask(normalized);
    this.scheduleSessions(new Set([created.session_id]));
    this.broadcastTasks();
    this.policyEnforcer?.handleTaskCreated(created);
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
      this.scheduleSessions(new Set([created.session_id]));
      this.broadcastTasks();
      this.policyEnforcer?.handleTaskCreated(created);
    }
    return created;
  }

  createTasks(tasks: CreateTaskInput[]): Task[] {
    const created = tasks.map(t => this.db.createTask(this.prepareTaskInput(t)));
    const sessionIds = new Set(created.map(task => task.session_id));
    this.scheduleSessions(sessionIds);
    this.broadcastTasks();
    created.forEach(task => this.policyEnforcer?.handleTaskCreated(task));
    return created;
  }

  updateTaskDependencies(taskId: string, dependencyIds: string[]): void {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const normalized = this.normalizeDependencyList(dependencyIds, taskId);
    this.db.updateTask(taskId, { dependencies: normalized });
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
    this.db.updateTask(id, updates);
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
    this.db.updateTask(id, { status: 'paused' });
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
    this.db.updateTask(id, {
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
    this.db.updateTask(id, updates);
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
    this.db.updateTask(taskId, {
      assigned_to: agentId,
      status,
      run_after: null
    });
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
      this.db.updateTask(taskId, {
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
      this.db.updateTask(taskId, {
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
    this.db.updateTask(id, {
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
    }
  }

  // 失败任务
  failTask(id: string, error: string): void {
    const existing = this.db.getTask(id);
    this.db.updateTask(id, {
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
    return tasks.filter(task =>
      task.status === 'assigned' &&
      this.canExecuteTask(task.id) &&
      (!task.run_after || task.run_after <= Date.now())
    );
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

  unblockDependentTasks(completedTaskId: string): Set<string> {
    const blockedTasks = this.db.getTasks({ status: 'blocked' }).filter(task =>
      task.dependencies?.includes(completedTaskId)
    );

    const sessionIds = new Set<string>();
    blockedTasks.forEach(task => {
      if (this.canExecuteTask(task.id)) {
        this.db.updateTask(task.id, { status: 'assigned', run_after: null });
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
        this.db.updateTask(task.id, {
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
        this.db.updateTask(task.id, {
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
        this.db.updateTask(task.id, {
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

    runningTasks.forEach(task => {
      if (task.parent_task_id) {
        siblingUsage.set(task.parent_task_id, (siblingUsage.get(task.parent_task_id) || 0) + 1);
      }
      if (SERIALIZED_SCOPES.has(task.scope)) {
        scopeUsage.set(task.scope, (scopeUsage.get(task.scope) || 0) + 1);
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
      const siblingLimited = this.isSiblingLimited(task, siblingUsage);
      const scopeLimited = this.isScopeLimited(task, scopeUsage);
      if (activeSlots < MAX_CONCURRENT_TASKS_PER_SESSION && !siblingLimited && !scopeLimited) {
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
      } else if (task.status === 'assigned') {
        updates.push({ id: task.id, updates: { status: 'queued' } });
        activeSlots = Math.max(runningTasks.length, activeSlots - 1);
      }
    });

    if (updates.length === 0) {
      return false;
    }

    updates.forEach(entry => {
      this.db.updateTask(entry.id, entry.updates);
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

  private extractWorkflowInstanceId(task: Task): string | null {
    if (!task || !Array.isArray(task.labels)) {
      return null;
    }
    const match = task.labels.find(label => typeof label === 'string' && label.startsWith('workflow_instance:'));
    return match ? match.replace('workflow_instance:', '') : null;
  }

  private buildTaskNotificationMetadata(task: Task): Record<string, any> {
    const metadata: Record<string, any> = { task_id: task.id };
    const instanceId = this.extractWorkflowInstanceId(task);
    if (instanceId) {
      metadata.workflow_instance_id = instanceId;
    }
    return metadata;
  }

  private prepareTaskInput(task: CreateTaskInput): CreateTaskInput {
    const normalizedTitle = this.humanizeTaskTitle(task);
    const dependencies = (task.dependencies || []).filter(Boolean);
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

    return {
      ...task,
      title: normalizedTitle,
      status,
      dependencies,
      retry_count: task.retry_count ?? 0,
      max_retries: task.max_retries ?? null,
      timeout_seconds: task.timeout_seconds ?? null,
      run_after: task.run_after ?? null,
      last_started_at: task.last_started_at ?? null
    };
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
    if (!this.governanceHistory) {
      return;
    }
    this.governanceHistory.recordEntry({
      session_id: task.session_id,
      type: 'task',
      entity_id: task.id,
      action,
      actor_id: 'system',
      summary,
      payload: payload ?? null
    });
  }
}
