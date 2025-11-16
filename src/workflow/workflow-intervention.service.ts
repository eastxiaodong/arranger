import * as vscode from 'vscode';
import type { TypedEventEmitter } from '../events/emitter';
import type { WorkflowKernel } from './workflow-kernel';
import type { TaskService } from '../services/task.service';
import type { MessageService } from '../services/message.service';
import type { BlackboardEntry, Task } from '../types';
import type { WorkflowRuntimeEvent } from './workflow-types';
import { getScenarioDisplayName, normalizeScenarioId } from './scenario-registry';

export class WorkflowInterventionService implements vscode.Disposable {
  private messageListener: ((message: BlackboardEntry) => void) | null = null;
  private taskListener: ((task: Task) => void) | null = null;
  private workflowListener: ((event: WorkflowRuntimeEvent) => void) | null = null;

  constructor(
    private readonly events: TypedEventEmitter,
    private readonly kernel: WorkflowKernel,
    private readonly taskService: TaskService,
    private readonly messageService: MessageService,
    private readonly output: vscode.OutputChannel
  ) {}

  start(context: vscode.ExtensionContext) {
    if (this.messageListener || this.taskListener) {
      return;
    }
    this.messageListener = (message) => this.handleUserMessage(message);
    this.taskListener = (task) => this.handleTaskCompletion(task);
    this.workflowListener = (event) => this.handleWorkflowEvent(event);
    this.events.on('message_posted', this.messageListener);
    this.events.on('task_completed', this.taskListener);
    this.events.on('workflow_event', this.workflowListener);
    context.subscriptions.push(this);
    this.output.appendLine('[Workflow][intervention] Service initialized');
  }

  dispose() {
    if (this.messageListener) {
      this.events.off('message_posted', this.messageListener);
      this.messageListener = null;
    }
    if (this.taskListener) {
      this.events.off('task_completed', this.taskListener);
      this.taskListener = null;
    }
    if (this.workflowListener) {
      this.events.off('workflow_event', this.workflowListener);
      this.workflowListener = null;
    }
  }

  private handleUserMessage(message: BlackboardEntry) {
    if (!message || message.agent_id !== 'user' || !message.session_id) {
      return;
    }
    const content = (message.content || '').trim();
    if (!content) {
      return;
    }
    const instance = this.kernel.findInstanceBySession(message.session_id);
    if (!instance) {
      return;
    }
    const phaseId = this.pickPhase(instance);
    if (!phaseId) {
      return;
    }
    const note = this.kernel.recordUserIntervention(instance.id, phaseId, {
      messageId: message.id,
      sessionId: message.session_id,
      content,
      createdAt: message.created_at,
      createdBy: message.agent_id
    });
    this.output.appendLine(`[Workflow][intervention] Captured user note ${note.id} for phase ${phaseId}`);
    const followupTask = this.createFollowupTask(instance.workflowId, message.session_id, phaseId, note.id, content);
    if (followupTask) {
      this.kernel.linkUserInterventionTask(instance.id, phaseId, note.id, followupTask.id);
    }
    this.publishModeratorSummary(message.session_id, phaseId, content);
  }

  private handleTaskCompletion(task: Task) {
    if (!task || !Array.isArray(task.labels)) {
      return;
    }
    const noteIds = this.extractUserNoteIds(task.labels);
    if (noteIds.length === 0) {
      return;
    }
    noteIds.forEach(noteId => {
      if (this.kernel.resolveUserInterventionByNoteId(noteId)) {
        this.output.appendLine(`[Workflow][intervention] Note ${noteId} resolved via task ${task.id}`);
      }
    });
  }

  private handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (!event || event.type !== 'workflow_completed') {
      return;
    }
    const instance = this.kernel.getInstance(event.instanceId);
    if (!instance || !instance.sessionId) {
      return;
    }
    const summary = this.buildWorkflowCompletionSummary(instance);
    if (!summary) {
      return;
    }
    try {
      this.messageService.sendMessage({
        id: `msg_workflow_complete_${instance.id}_${Date.now()}`,
        session_id: instance.sessionId,
        agent_id: 'workflow_orchestrator',
        message_type: 'system',
        content: summary,
        priority: 'medium',
        tags: [`workflow_instance:${instance.id}`],
        reply_to: null,
        references: null,
        reference_type: null,
        reference_id: null,
        mentions: null,
        expires_at: null,
        category: 'agent_summary',
        visibility: 'blackboard',
        payload: {
          workflow_instance_id: instance.id,
          scenario: instance.metadata?.scenario ?? null
        }
      });
    } catch (error) {
      this.output.appendLine(`[Workflow][intervention] Failed to publish completion summary: ${error instanceof Error ? error.message : error}`);
    }
  }

  private pickPhase(instance: { activePhases?: string[]; workflowId: string }): string | null {
    if (instance.activePhases && instance.activePhases.length > 0) {
      return instance.activePhases[0];
    }
    const definition = this.kernel.getDefinition(instance.workflowId);
    if (!definition || definition.phases.length === 0) {
      return null;
    }
    return definition.phases[definition.phases.length - 1].id;
  }

  private buildWorkflowCompletionSummary(instance: any): string | null {
    if (!instance || !instance.sessionId) {
      return null;
    }
    const scenarioValues = this.normalizeScenarioList(instance.metadata?.scenario);
    const scenarioLabel = scenarioValues.length
      ? scenarioValues.map(value => getScenarioDisplayName(value)).join(' / ')
      : '默认流程';
    const tasks = this.taskService.getAllTasks({ session_id: instance.sessionId })
      .filter(task => task.labels?.some(label => label === `workflow_instance:${instance.id}`));
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(task => task.status === 'completed').length;
    const runningTasks = tasks.filter(task => task.status === 'running' || task.status === 'assigned').length;
    const pendingTasks = totalTasks - completedTasks - runningTasks;
    const proofCount = Object.values(instance.phaseState || {}).reduce((acc: { total: number }, state: any) => {
      const proofs = Array.isArray(state?.proofs) ? state.proofs.length : 0;
      acc.total += proofs;
      return acc;
    }, { total: 0 });
    const lines = [
      `流程实例 ${instance.id} 已完成 · 场景：${scenarioLabel}`,
      `任务完成度：${completedTasks}/${totalTasks} · 进行中 ${runningTasks} · 待处理 ${Math.max(pendingTasks, 0)}`
    ];
    if (proofCount.total > 0) {
      lines.push(`Proof 产出：${proofCount.total} 条`);
    }
    if (instance.timeline?.length) {
      const startedAt = instance.timeline[0]?.at ? new Date(instance.timeline[0].at).toLocaleString() : null;
      const finishedAt = instance.updatedAt ? new Date(instance.updatedAt).toLocaleString() : null;
      if (startedAt && finishedAt) {
        lines.push(`起止：${startedAt} → ${finishedAt}`);
      }
    }
    lines.push('系统已整理交付结果，后续可继续在当前会话追加需求。');
    return lines.join('\n');
  }

  private normalizeScenarioList(raw?: string | string[] | null): string[] {
    if (!raw) {
      return [];
    }
    const values = Array.isArray(raw) ? raw : [raw];
    return values.map(value => normalizeScenarioId(String(value))).filter(Boolean);
  }

  private createFollowupTask(
    workflowId: string,
    sessionId: string,
    phaseId: string,
    noteId: string,
    content: string
  ): Task | null {
    try {
      const definition = this.kernel.getDefinition(workflowId);
      const phaseTitle = definition?.phases.find(phase => phase.id === phaseId)?.title ?? phaseId;
      const description = content.length > 500 ? `${content.slice(0, 497)}...` : content;
      const task = this.taskService.createTask({
        id: `user_followup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        session_id: sessionId,
        title: `处理用户补充 · ${phaseTitle}`,
        intent: 'address_user_intervention',
        description,
        scope: `phase:${phaseId}`,
        priority: 'high',
        labels: [`workflow_phase:${phaseId}`, 'user_followup', `user_note:${noteId}`],
        due_at: null,
        status: 'pending',
        assigned_to: null,
        parent_task_id: null,
        dependencies: [],
        run_after: null,
        retry_count: 0,
        max_retries: null,
        timeout_seconds: null,
        last_started_at: null
      });
      return task;
    } catch (error) {
      this.output.appendLine(`[Workflow][intervention] Failed to create follow-up task: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  private publishModeratorSummary(sessionId: string, phaseId: string, content: string) {
    const summary = `Moderator：用户在阶段 ${phaseId} 插入新需求，已创建跟进任务。\n>>> ${content}`;
    try {
      this.messageService.sendMessage({
        id: `msg_intervention_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        session_id: sessionId,
        agent_id: 'moderator_bot',
        message_type: 'system',
        content: summary,
        priority: 'high',
        tags: ['user_intervention'],
        reply_to: null,
        references: null,
        reference_type: null,
        reference_id: null,
        mentions: null,
        expires_at: null,
        category: 'agent_summary',
        visibility: 'blackboard',
        payload: {
          phase_id: phaseId
        }
      });
    } catch (error) {
      this.output.appendLine(`[Workflow][intervention] Failed to publish moderator summary: ${error instanceof Error ? error.message : error}`);
    }
  }

  private extractUserNoteIds(labels: string[]): string[] {
    return labels
      .filter(label => typeof label === 'string' && label.startsWith('user_note:'))
      .map(label => label.replace('user_note:', ''))
      .filter(Boolean);
  }
}
