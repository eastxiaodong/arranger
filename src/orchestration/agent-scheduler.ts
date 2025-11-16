import * as vscode from 'vscode';
import type { Services } from '../services';
import type { TypedEventEmitter } from '../events/emitter';
import type { Agent, Task } from '../types';
import { AgentRuntimePool } from './agent-runtime-pool';
import type { SchedulerEventPayload } from './orchestration-types';
import { deriveTaskRoles, deriveTaskCapabilities, deriveTaskTools, extractAssistTarget, priorityWeight } from './orchestration-utils';

interface AgentSchedulerOptions {
  maxConcurrentTasksPerAgent?: number;
  assignmentCooldownMs?: number;
}

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_ASSIGNMENT_COOLDOWN_MS = 3000;
const AGENT_EXCLUDE_LABEL_PREFIX = 'agent_exclude:';
const WORKFLOW_ASSIST_LABEL = 'workflow:assist_required';
const WORKFLOW_HUMAN_LABEL = 'workflow:human_required';

interface CandidatePlan {
  entries: Array<{ agent: Agent; degraded: boolean }>;
  requireAssist: boolean;
  needsAssist: boolean;
  requiredCapabilities: string[];
  requiredTools: string[];
  metadata: {
    requiredCapabilities: string[];
    requiredTools: string[];
  };
}

export class AgentScheduler implements vscode.Disposable {
  private disposed = false;
  private agentSnapshot: Agent[] = [];
  private taskCooldown = new Map<string, number>();
  private agentAssignmentLoad = new Map<string, number>();
  private taskListener: ((tasks: Task[]) => void) | null = null;
  private agentListener: ((agents: Agent[]) => void) | null = null;

  constructor(
    private readonly services: Services,
    private readonly events: TypedEventEmitter,
    private readonly runtimePool: AgentRuntimePool,
    private readonly output: vscode.OutputChannel,
    private readonly options?: AgentSchedulerOptions
  ) {}

  start(context: vscode.ExtensionContext) {
    if (this.disposed) {
      return;
    }
    this.agentSnapshot = this.services.agent.getAllAgents();
    this.agentListener = (agents) => {
      this.agentSnapshot = agents;
    };
    this.taskListener = (tasks) => this.handleTasksUpdate(tasks);
    this.events.on('agents_update', this.agentListener);
    this.events.on('tasks_update', this.taskListener);
    // Prime current state
    this.handleTasksUpdate(this.services.task.getAllTasks({}));
    context.subscriptions.push(this);
    this.output.appendLine('[AgentScheduler] Started');
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.agentListener) {
      this.events.off('agents_update', this.agentListener);
      this.agentListener = null;
    }
    if (this.taskListener) {
      this.events.off('tasks_update', this.taskListener);
      this.taskListener = null;
    }
  }

  private handleTasksUpdate(tasks: Task[]) {
    if (this.disposed) {
      return;
    }
    this.recalculateAssignmentLoad(tasks);
    const pending = tasks
      .filter(task =>
        task.status === 'pending' &&
        !task.assigned_to &&
        this.services.task.canExecuteTask(task.id)
      )
      .sort((a, b) => this.priorityWeight(b) - this.priorityWeight(a));

    pending.forEach(task => this.tryScheduleTask(task));
  }

  private recalculateAssignmentLoad(tasks: Task[]) {
    const load = new Map<string, number>();
    tasks.forEach(task => {
      if (!task.assigned_to) {
        return;
      }
      if (task.status === 'assigned' || task.status === 'running') {
        load.set(task.assigned_to, (load.get(task.assigned_to) || 0) + 1);
      }
    });
    this.agentAssignmentLoad = load;
  }

  private tryScheduleTask(task: Task) {
    const cooldownUntil = this.taskCooldown.get(task.id) ?? 0;
    if (cooldownUntil > Date.now()) {
      return;
    }
    this.taskCooldown.set(task.id, Date.now() + this.assignmentCooldownMs());
    void this.tryAssignWithFallback(task);
  }

  private async tryAssignWithFallback(task: Task) {
    const assistTarget = extractAssistTarget(task);
    if (assistTarget) {
      const preferred = this.agentSnapshot.find(agent =>
        agent.id === assistTarget && this.baseAgentEligible(agent)
      );
      if (preferred) {
        const assigned = await this.assignTaskToAgent(task, preferred, false);
        if (assigned) {
          return;
        }
      } else {
        this.emitSchedulerEvent({
          type: 'queued',
          taskId: task.id,
          sessionId: task.session_id,
          reason: 'assist_target_unavailable',
          metadata: { assistTarget }
        });
      }
    }

    const plan = this.buildAgentCandidates(task);
    if (!plan.entries.length) {
      this.markHumanRequired(task, 'no_available_agent');
      this.emitSchedulerEvent({
        type: 'queued',
        taskId: task.id,
        sessionId: task.session_id,
        reason: 'no_available_agent'
      });
      return;
    }

    if (plan.needsAssist) {
      this.markAssistRequired(task, plan.requiredCapabilities, plan.requiredTools);
    } else if (plan.requireAssist) {
      this.services.task.removeTaskLabelsByPrefix(task.id, WORKFLOW_ASSIST_LABEL);
    }

    for (const candidate of plan.entries) {
      const assigned = await this.assignTaskToAgent(task, candidate.agent, candidate.degraded, plan.metadata);
      if (assigned) {
        return;
      }
    }
    this.emitSchedulerEvent({
      type: 'queued',
      taskId: task.id,
      sessionId: task.session_id,
      reason: 'no_agent_ready'
    });
  }

  private buildAgentCandidates(task: Task): CandidatePlan {
    const requiredRoles = deriveTaskRoles(task).map(role => role.toLowerCase());
    const requiredCapabilities = deriveTaskCapabilities(task);
    const requiredTools = deriveTaskTools(task);
    const requireSpecialization = requiredCapabilities.length > 0 || requiredTools.length > 0;
    const excludedAgents = this.getExcludedAgents(task);
    const eligibleAgents = this.agentSnapshot.filter(agent =>
      this.baseAgentEligible(agent) && !excludedAgents.has(agent.id)
    );
    if (!eligibleAgents.length) {
      return {
        entries: [],
        requireAssist: requireSpecialization,
        needsAssist: requireSpecialization,
        requiredCapabilities,
        requiredTools,
        metadata: { requiredCapabilities, requiredTools }
      };
    }

    const enriched = eligibleAgents.map(agent => {
      const capabilityScore = this.capabilityScore(agent, requiredCapabilities);
      const toolCoverage = this.toolCoverageScore(agent, requiredTools);
      const roleMatch = this.matchesRoles(agent, requiredRoles);
      const specializationSatisfied =
        !requireSpecialization ||
        (
          (requiredCapabilities.length === 0 || capabilityScore > 0) &&
          (requiredTools.length === 0 || toolCoverage >= requiredTools.length)
        );
      const performance = this.agentPerformanceScore(agent);
      const load = this.agentLoad(agent.id);
      const score =
        (roleMatch ? 1.5 : 0) +
        capabilityScore * 2 +
        toolCoverage +
        performance -
        load * 0.2;
      return {
        agent,
        degraded: requireSpecialization && !specializationSatisfied,
        score
      };
    });

    const sorted = enriched.sort((a, b) => {
      if (a.degraded !== b.degraded) {
        return Number(a.degraded) - Number(b.degraded);
      }
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const statusDiff = this.statusWeight(a.agent) - this.statusWeight(b.agent);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      const loadDiff = this.agentLoad(a.agent.id) - this.agentLoad(b.agent.id);
      if (loadDiff !== 0) {
        return loadDiff;
      }
      return (a.agent.status_updated_at || 0) - (b.agent.status_updated_at || 0);
    });

    const specializedMatches = sorted.filter(entry => !entry.degraded).length;
    return {
      entries: sorted.map(entry => ({
        agent: entry.agent,
        degraded: entry.degraded
      })),
      requireAssist: requireSpecialization,
      needsAssist: requireSpecialization && specializedMatches === 0,
      requiredCapabilities,
      requiredTools,
      metadata: {
        requiredCapabilities,
        requiredTools
      }
    };
  }

  private markAssistRequired(task: Task, requiredCapabilities: string[], requiredTools: string[]) {
    this.services.task.addTaskLabels(task.id, [WORKFLOW_ASSIST_LABEL]);
    this.emitSchedulerEvent({
      type: 'assist_required',
      taskId: task.id,
      sessionId: task.session_id,
      metadata: {
        requiredCapabilities,
        requiredTools
      }
    });
    this.services.notification?.sendNotification({
      session_id: task.session_id,
      level: 'warning',
      title: '调度请求协助',
      message: `任务「${task.title}」缺少专长 Agent，已进入协助队列`,
      metadata: this.buildTaskNotificationMetadata(task)
    });
  }

  private markHumanRequired(task: Task, reason: string) {
    this.services.task.addTaskLabels(task.id, [WORKFLOW_HUMAN_LABEL]);
    this.emitSchedulerEvent({
      type: 'human_required',
      taskId: task.id,
      sessionId: task.session_id,
      reason
    });
    this.services.notification?.sendNotification({
      session_id: task.session_id,
      level: 'warning',
      title: '任务等待人工接管',
      message: `任务「${task.title}」暂无法分派，原因：${reason}`,
      metadata: this.buildTaskNotificationMetadata(task)
    });
  }

  private getExcludedAgents(task: Task): Set<string> {
    const result = new Set<string>();
    task.labels?.forEach(label => {
      if (label.startsWith(AGENT_EXCLUDE_LABEL_PREFIX)) {
        result.add(label.replace(AGENT_EXCLUDE_LABEL_PREFIX, ''));
      }
    });
    return result;
  }

  private matchesRoles(agent: Agent, requiredRoles: string[]): boolean {
    if (requiredRoles.length === 0) {
      return true;
    }
    const agentRoles = (agent.roles || []).map(role => role.toLowerCase());
    return requiredRoles.some(role => agentRoles.includes(role));
  }

  private matchesCapabilities(agent: Agent, requiredCapabilities: string[]): boolean {
    if (requiredCapabilities.length === 0) {
      return true;
    }
    const agentCaps = (agent.capabilities || []).map(cap => cap.toLowerCase());
    return requiredCapabilities.some(cap => agentCaps.includes(cap));
  }

  private capabilityScore(agent: Agent, requiredCapabilities: string[]): number {
    if (!requiredCapabilities.length) {
      return 0;
    }
    const agentCaps = (agent.capabilities || []).map(cap => cap.toLowerCase());
    return requiredCapabilities.filter(cap => agentCaps.includes(cap)).length;
  }

  private toolCoverageScore(agent: Agent, requiredTools: string[]): number {
    if (!requiredTools.length) {
      return 0;
    }
    const permissions = (agent.tool_permissions || []).map(tool => tool.toLowerCase());
    return requiredTools.filter(tool => permissions.includes(tool.toLowerCase())).length;
  }

  private agentPerformanceScore(agent: Agent): number {
    const metrics = agent.metrics || undefined;
    const successRate = typeof metrics?.success_rate === 'number'
      ? Math.min(Math.max(metrics.success_rate, 0), 1)
      : 0.5;
    const latency = metrics?.average_response_ms ?? 4000;
    const latencyScore = 1 - Math.min(1, latency / 8000);
    return successRate * 0.7 + latencyScore * 0.3;
  }

  private priorityWeight(task: Task): number {
    return priorityWeight(task);
  }

  private agentLoad(agentId: string): number {
    return this.agentAssignmentLoad.get(agentId) ?? 0;
  }

  private emitSchedulerEvent(payload: Omit<SchedulerEventPayload, 'timestamp'>) {
    this.events.emit('scheduler_event', {
      ...payload,
      timestamp: Date.now()
    });
  }

  private assignmentCooldownMs() {
    return this.options?.assignmentCooldownMs ?? DEFAULT_ASSIGNMENT_COOLDOWN_MS;
  }
  private agentEligible(agent: Agent, requiredRoles: string[]): boolean {
    if (!this.baseAgentEligible(agent)) {
      return false;
    }
    if (requiredRoles.length === 0) {
      return true;
    }
    const agentRoles = (agent.roles || []).map(role => role.toLowerCase());
    return requiredRoles.some(role => agentRoles.includes(role));
  }

  private baseAgentEligible(agent: Agent): boolean {
    if (agent.is_enabled === false) {
      return false;
    }
    if (agent.status === 'offline') {
      return false;
    }
    const hasLLM = !!agent.llm_provider && !!agent.llm_api_key;
    if (!hasLLM) {
      return false;
    }
    const maxConcurrent = this.options?.maxConcurrentTasksPerAgent ?? DEFAULT_MAX_CONCURRENT;
    if (this.agentLoad(agent.id) >= maxConcurrent) {
      return false;
    }
    return true;
  }

  private sortAgents(agents: Agent[]): Agent[] {
    return agents.slice().sort((a, b) => {
      const loadDiff = this.agentLoad(a.id) - this.agentLoad(b.id);
      if (loadDiff !== 0) {
        return loadDiff;
      }
      const statusDiff = this.statusWeight(a) - this.statusWeight(b);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return (a.status_updated_at || 0) - (b.status_updated_at || 0);
    });
  }

  private statusWeight(agent: Agent): number {
    if (agent.status === 'online') return 0;
    if (agent.status === 'busy') return 1;
    return 2;
  }

  private async assignTaskToAgent(task: Task, agent: Agent, degraded = false, planMeta?: CandidatePlan['metadata']): Promise<boolean> {
    try {
      await this.runtimePool.ensureEngine(agent.id);
    } catch (error: any) {
      this.handleAgentUnavailable(task, agent, error);
      return false;
    }

    const claimed = this.services.task.claimTaskForAgent(task.id, agent.id);
    if (claimed) {
      this.agentAssignmentLoad.set(agent.id, this.agentLoad(agent.id) + 1);
      if (!degraded) {
        this.services.task.removeTaskLabelsByPrefix(task.id, WORKFLOW_ASSIST_LABEL);
      }
      this.emitSchedulerEvent({
        type: 'assigned',
        taskId: task.id,
        agentId: agent.id,
        sessionId: task.session_id,
        metadata: degraded
          ? {
              degraded: true,
              requiredCapabilities: planMeta?.requiredCapabilities ?? [],
              requiredTools: planMeta?.requiredTools ?? []
            }
          : undefined
      });
      const prefix = degraded ? '[AgentScheduler][fallback]' : '[AgentScheduler]';
      this.output.appendLine(`${prefix} Assigned task ${task.id} to ${agent.display_name || agent.id}`);
      return true;
    }

    this.emitSchedulerEvent({
      type: 'skipped',
      taskId: task.id,
      agentId: agent.id,
      sessionId: task.session_id,
      reason: 'claim_failed'
    });
    return false;
  }

  private handleAgentUnavailable(task: Task, agent: Agent, error: any) {
    this.output.appendLine(`[AgentScheduler] Failed to start agent ${agent.id}: ${error?.message ?? error}`);
    this.emitSchedulerEvent({
      type: 'skipped',
      taskId: task.id,
      agentId: agent.id,
      sessionId: task.session_id,
      reason: 'agent_unavailable',
      metadata: { error: error?.message ?? String(error) }
    });
    this.requestTakeoverApproval(task, agent, error);
    this.services.task.addTaskLabels(task.id, [`${AGENT_EXCLUDE_LABEL_PREFIX}${agent.id}`]);
  }

  private requestTakeoverApproval(task: Task, failedAgent: Agent, error?: any) {
    const approvalService = this.services.approval;
    if (!approvalService) {
      return;
    }
    const existing = approvalService.getAllApprovals({
      task_id: task.id,
      decision: 'pending'
    });
    if (existing && existing.length > 0) {
      return;
    }
    const sessionId = task.session_id || 'global';
    const comment = `Agent ${failedAgent.display_name || failedAgent.id} 不可用，原因：${error?.message ?? error ?? '未知'}`;
    const approval = approvalService.requestTaskTakeover(task, {
      reason: comment,
      requestedBy: failedAgent.id,
      approverId: 'user'
    });
    if (!approval) {
      return;
    }
    this.services.notification?.sendNotification({
      session_id: sessionId,
      level: 'warning',
      title: '任务转派审批',
      message: `任务「${task.title || task.intent || task.id}」需要转派，原因：${comment}`,
      metadata: this.buildTaskNotificationMetadata(task)
    });
  }

  private extractWorkflowInstanceId(task: Task): string | null {
    if (!task || !Array.isArray(task.labels)) {
      return null;
    }
    const label = task.labels.find(item => typeof item === 'string' && item.startsWith('workflow_instance:'));
    return label ? label.replace('workflow_instance:', '') : null;
  }

  private buildTaskNotificationMetadata(task: Task): Record<string, any> {
    const metadata: Record<string, any> = { task_id: task.id };
    const instanceId = this.extractWorkflowInstanceId(task);
    if (instanceId) {
      metadata.workflow_instance_id = instanceId;
    }
    return metadata;
  }

}
