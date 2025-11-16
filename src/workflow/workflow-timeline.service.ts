import * as vscode from 'vscode';
import type { TypedEventEmitter } from '../events/emitter';
import type { MessageService } from '../services/message.service';
import type { WorkflowKernel } from './workflow-kernel';
import type { WorkflowRuntimeEvent, WorkflowDefinition } from './workflow-types';

const SYSTEM_AGENT_ID = 'workflow_orchestrator';

export class WorkflowTimelineService implements vscode.Disposable {
  private listener: ((event: WorkflowRuntimeEvent) => void) | null = null;

  constructor(
    private readonly events: TypedEventEmitter,
    private readonly kernel: WorkflowKernel,
    private readonly messages: MessageService,
    private readonly output: vscode.OutputChannel
  ) {}

  start(context: vscode.ExtensionContext) {
    if (this.listener) {
      return;
    }
    this.listener = (event) => {
      try {
        this.handleWorkflowEvent(event);
      } catch (error: any) {
        this.output.appendLine(`[Workflow][timeline] Failed to record event: ${error?.message ?? error}`);
      }
    };
    this.events.on('workflow_event', this.listener);
    context.subscriptions.push(this);
    this.output.appendLine('[Workflow][timeline] Timeline service started');
  }

  dispose() {
    if (this.listener) {
      this.events.off('workflow_event', this.listener);
      this.listener = null;
    }
  }

  private handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    const instance = this.kernel.getInstance(event.instanceId);
    if (!instance || !instance.sessionId) {
      return;
    }
    const content = this.composeMessage(event, instance.workflowId);
    if (!content) {
      return;
    }
    const entryId = `wf_timeline_${event.timestamp}_${Math.random().toString(36).slice(2, 8)}`;
    this.messages.sendMessage({
      id: entryId,
      session_id: instance.sessionId,
      agent_id: SYSTEM_AGENT_ID,
      message_type: 'system',
      content,
      priority: 'medium',
      tags: ['workflow', 'timeline'],
      reply_to: null,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      category: 'system_event',
      visibility: 'event_log',
      payload: {
        event_type: event.type,
        workflow_instance_id: event.instanceId,
        phase_id: event.phaseId ?? null
      }
    });
  }

  private composeMessage(event: WorkflowRuntimeEvent, workflowId: string): string | null {
    const definition = this.kernel.getDefinition(workflowId);
    const phaseTitle = event.phaseId ? this.resolvePhaseTitle(definition, event.phaseId) : null;
    switch (event.type) {
      case 'phase_enter':
        return phaseTitle
          ? `阶段「${phaseTitle}」已开始，系统正在分配对应任务。`
          : '新的流程阶段已开始，系统正在分配对应任务。';
      case 'phase_complete':
        return phaseTitle
          ? `阶段「${phaseTitle}」已完成，准备进入下一个阶段。`
          : '当前阶段已完成，准备进入下一个阶段。';
      case 'phase_blocked': {
        const reason = this.extractBlockerReason(event);
        return phaseTitle
          ? `阶段「${phaseTitle}」已阻塞：${reason}`
          : `流程检测到阻塞：${reason}`;
      }
      case 'workflow_completed': {
        const workflowName = definition?.name || workflowId;
        return `流程「${workflowName}」已全部完成，当前需求进入交付总结阶段。`;
      }
      default:
        return null;
    }
  }

  private resolvePhaseTitle(definition: WorkflowDefinition | undefined, phaseId: string): string {
    if (!definition) {
      return phaseId;
    }
    const phase = definition.phases.find(item => item.id === phaseId);
    return phase?.title ?? phaseId;
  }

  private extractBlockerReason(event: WorkflowRuntimeEvent): string {
    const payload = event.payload as { reason?: string } | undefined;
    if (payload?.reason) {
      return payload.reason;
    }
    return '请查看治理面板或任务详情';
  }
}
