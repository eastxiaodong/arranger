import * as vscode from 'vscode';
import type { Services } from '../services';
import type { TypedEventEmitter } from '../events/emitter';
import type { WorkflowKernel } from '../workflow';
import type { Task } from '../types';
import type { SchedulerEventPayload, SentinelEventPayload } from './orchestration-types';

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;
const AGENT_HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
const AGENT_WARNING_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;
const TASK_STALLED_TIMEOUT_MS = 20 * 60 * 1000;
const PHASE_TIMEOUT_MS = 15 * 60 * 1000;

const PROOF_REQUIRED_PHASES = new Set(['verify', 'delivery']);
const HUMAN_ESCALATION_LABEL = 'workflow:human_required';
const HUMAN_REMIND_INTERVAL_MS = 5 * 60 * 1000;

export class SentinelService implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private agentWarnings = new Map<string, number>();
  private agentNotificationTimestamps = new Map<string, number>();
  private taskWarnings = new Map<string, number>();
  private phaseWarnings = new Map<string, number>();
  private humanWarnings = new Map<string, number>();
  private schedulerListener: ((event: SchedulerEventPayload) => void) | null = null;

  constructor(
    private readonly services: Services,
    private readonly events: TypedEventEmitter,
    private readonly workflow: WorkflowKernel,
    private readonly output: vscode.OutputChannel,
    private readonly options?: {
      intervalMs?: number;
    }
  ) {}

  start(context: vscode.ExtensionContext) {
    if (this.disposed) {
      return;
    }
    const interval = this.options?.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    context.subscriptions.push(this);
    void this.tick(); // run immediately
    this.output.appendLine('[Sentinel] Service started');
    this.schedulerListener = (event) => this.handleSchedulerSignal(event);
    this.events.on('scheduler_event', this.schedulerListener);
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.schedulerListener) {
      this.events.off('scheduler_event', this.schedulerListener);
      this.schedulerListener = null;
    }
  }

  private async tick() {
    try {
      this.inspectAgents();
      this.inspectTasks();
      this.inspectWorkflows();
    } catch (error: any) {
      this.output.appendLine(`[Sentinel] Tick error: ${error?.message ?? error}`);
    }
  }

  private handleSchedulerSignal(event: SchedulerEventPayload) {
    if (!event) {
      return;
    }
    if (event.type === 'assist_required') {
      this.emitSentinelEvent({
        type: 'assist_required',
        severity: 'warning',
        taskId: event.taskId,
        sessionId: event.sessionId,
        message: '任务缺少专长 Agent，需要协助',
        metadata: event.metadata
      });
      return;
    }
    if (event.type === 'human_required') {
      this.emitSentinelEvent({
        type: 'human_required',
        severity: 'warning',
        taskId: event.taskId,
        sessionId: event.sessionId,
        message: '任务暂无法分配，请人工接管',
        metadata: event.metadata
      });
    }
  }

  private inspectAgents() {
    const agents = this.services.agent.getAllAgents();
    const now = Date.now();
    agents.forEach(agent => {
      if (agent.is_enabled === false) {
        this.agentWarnings.delete(agent.id);
        this.agentNotificationTimestamps.delete(agent.id);
        return;
      }
      const lastHeartbeat = agent.last_heartbeat_at || 0;
      const lastStatusUpdate = agent.status_updated_at || 0;
      const lastActivity = Math.max(lastHeartbeat, lastStatusUpdate);
      const hasRecentHeartbeat = lastActivity > 0 && (now - lastActivity) <= AGENT_HEARTBEAT_TIMEOUT_MS;
      const shouldWarn = agent.status === 'offline' || !hasRecentHeartbeat;
      if (!shouldWarn) {
        this.agentWarnings.delete(agent.id);
        this.agentNotificationTimestamps.delete(agent.id);
        return;
      }
      const lastWarn = this.agentWarnings.get(agent.id) ?? 0;
      if (now - lastWarn < AGENT_HEARTBEAT_TIMEOUT_MS) {
        return;
      }
      this.agentWarnings.set(agent.id, now);
      this.emitSentinelEvent({
        type: 'agent_offline',
        severity: 'warning',
        agentId: agent.id,
        message: `${agent.display_name || agent.id} 已离线或心跳超时`
      });
      const lastNotification = this.agentNotificationTimestamps.get(agent.id) ?? 0;
      if (now - lastNotification >= AGENT_WARNING_NOTIFY_INTERVAL_MS) {
        this.agentNotificationTimestamps.set(agent.id, now);
        this.services.notification?.sendNotification({
          session_id: 'global',
          level: 'warning',
          title: 'Agent 离线',
          message: `${agent.display_name || agent.id} 离线，等待 Scheduler 重新分配或人工接管。`,
          metadata: { agent_id: agent.id }
        });
      }
    });
  }

  private inspectTasks() {
    const tasks = this.services.task.getAllTasks({});
    const now = Date.now();
    const relevantStatuses = new Set(['running', 'assigned']);
    tasks.forEach(task => {
      const needsHuman = this.taskNeedsHuman(task);
      if (needsHuman) {
        this.handleHumanRequired(task, now);
      } else {
        this.humanWarnings.delete(task.id);
      }

      if (!relevantStatuses.has(task.status)) {
        this.taskWarnings.delete(task.id);
        return;
      }
      const startedAt = task.last_started_at || task.updated_at || 0;
      if (!startedAt) {
        return;
      }
      if (now - startedAt < TASK_STALLED_TIMEOUT_MS) {
        return;
      }
      const lastWarn = this.taskWarnings.get(task.id) ?? 0;
      if (now - lastWarn < TASK_STALLED_TIMEOUT_MS) {
        return;
      }
      this.taskWarnings.set(task.id, now);
      this.emitSentinelEvent({
        type: 'task_stalled',
        severity: 'warning',
        taskId: task.id,
        sessionId: task.session_id,
        agentId: task.assigned_to || undefined,
        message: `任务 ${task.title} 运行超时，可能需要重新分配`
      });
      this.services.notification?.sendNotification({
        session_id: task.session_id,
        level: 'warning',
        title: '任务运行超时',
        message: `任务「${task.title}」已运行较长时间，Sentinel 建议检查日志或重新调度。`,
        metadata: this.buildTaskMetadata(task)
      });
    });
  }

  private inspectWorkflows() {
    const instances = this.workflow.listInstances();
    const now = Date.now();
    instances.forEach(instance => {
      Object.values(instance.phaseState).forEach(state => {
        if (state.status !== 'active') {
          this.phaseWarnings.delete(`${instance.id}:${state.id}`);
          return;
        }
        if (state.enteredAt && now - state.enteredAt > PHASE_TIMEOUT_MS) {
          const cacheKey = `${instance.id}:${state.id}`;
          const lastWarn = this.phaseWarnings.get(cacheKey) ?? 0;
          if (now - lastWarn >= PHASE_TIMEOUT_MS) {
            this.phaseWarnings.set(cacheKey, now);
            this.emitSentinelEvent({
              type: 'phase_timeout',
              severity: 'warning',
              workflowInstanceId: instance.id,
              phaseId: state.id,
              sessionId: instance.sessionId,
              message: `阶段 ${state.id} 已运行超过预设时间`
            });
          }
        }
        if (PROOF_REQUIRED_PHASES.has(state.id) && state.proofs.length === 0) {
          this.emitSentinelEvent({
            type: 'proof_missing',
            severity: 'info',
            workflowInstanceId: instance.id,
            phaseId: state.id,
            sessionId: instance.sessionId,
            message: `阶段 ${state.id} 尚未提交 Proof`
          });
        }
        if (Object.keys(state.openDefects).length > 0 && !instance.activePhases.includes('build')) {
          this.emitSentinelEvent({
            type: 'defect_loop',
            severity: 'warning',
            workflowInstanceId: instance.id,
            phaseId: state.id,
            sessionId: instance.sessionId,
            message: `阶段 ${state.id} 存在未关闭缺陷 ${Object.keys(state.openDefects).length} 个`
          });
        }
      });
    });
  }

  private emitSentinelEvent(payload: Omit<SentinelEventPayload, 'timestamp'>) {
    this.events.emit('sentinel_event', {
      ...payload,
      timestamp: Date.now()
    });
  }

  private taskNeedsHuman(task: Task): boolean {
    return Array.isArray(task.labels) && task.labels.includes(HUMAN_ESCALATION_LABEL);
  }

  private handleHumanRequired(task: Task, now: number) {
    if (task.status === 'completed' || task.status === 'failed') {
      this.humanWarnings.delete(task.id);
      return;
    }
    const lastWarn = this.humanWarnings.get(task.id) ?? 0;
    if (now - lastWarn < HUMAN_REMIND_INTERVAL_MS) {
      return;
    }
    this.humanWarnings.set(task.id, now);
    const phaseId = this.extractPhaseId(task.labels ?? undefined);
    this.emitSentinelEvent({
      type: 'human_required',
      severity: 'warning',
      taskId: task.id,
      sessionId: task.session_id,
      phaseId,
      message: `任务「${task.title}」等待人工接管`
    });
  }

  private extractPhaseId(labels?: string[]): string | undefined {
    if (!Array.isArray(labels)) {
      return undefined;
    }
    const marker = labels.find(label => label.startsWith('workflow_phase:'));
    return marker ? marker.replace('workflow_phase:', '') : undefined;
  }

  private buildTaskMetadata(task: Task): Record<string, any> {
    const metadata: Record<string, any> = { task_id: task.id };
    if (task.session_id) {
      metadata.session_id = task.session_id;
    }
    const instanceLabel = (task.labels || []).find(label => label.startsWith('workflow_instance:'));
    if (instanceLabel) {
      metadata.workflow_instance_id = instanceLabel.replace('workflow_instance:', '');
    }
    const phaseId = this.extractPhaseId(task.labels ?? undefined);
    if (phaseId) {
      metadata.workflow_phase_id = phaseId;
    }
    return metadata;
  }
}
