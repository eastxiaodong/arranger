import { createHash } from 'crypto';
import type { WorkflowPlugin, WorkflowPluginContext } from '../workflow-plugin';
import type { WorkflowInstance, WorkflowRuntimeEvent } from '../workflow-types';
import type { AgentRole, Priority, Task } from '../../types';

interface PhaseProofTaskTemplate {
  id: string;
  title: string;
  intent: string;
  description?: string;
  assigneeRole?: AgentRole;
  priority?: Priority;
  proofLabel: string;
  proofType: 'work' | 'agreement';
  decision?: string;
  artifactId?: string;
}

const PHASE_PROOF_TEMPLATES: Record<string, PhaseProofTaskTemplate[]> = {
  verify: [
    {
      id: 'qa-evidence',
      title: '提交验证证据',
      intent: 'submit_verify_evidence',
      description: '上传测试日志、截图或自动化报告，形成 Proof-of-Work',
      assigneeRole: 'tester',
      priority: 'high',
      proofLabel: 'proof:work',
      proofType: 'work'
    },
    {
      id: 'qa-signoff',
      title: 'QA 签字',
      intent: 'qa_signoff',
      description: 'QA/Reviewer 对验证结论签字，形成 Proof-of-Agreement',
      assigneeRole: 'reviewer',
      priority: 'high',
      proofLabel: 'proof:agreement',
      proofType: 'agreement',
      decision: 'qa_signoff'
    }
  ],
  delivery: [
    {
      id: 'release-package',
      title: '整理交付物',
      intent: 'prepare_release_package',
      description: '整理 release note、二进制产物与部署脚本',
      assigneeRole: 'documenter',
      priority: 'medium',
      proofLabel: 'proof:work',
      proofType: 'work',
      artifactId: 'release_package'
    },
    {
      id: 'release-approval',
      title: '发布批准',
      intent: 'release_approval',
      description: '多角色联合批准交付物，形成最终发布 Proof',
      assigneeRole: 'admin',
      priority: 'high',
      proofLabel: 'proof:agreement',
      proofType: 'agreement',
      decision: 'release_approved'
    }
  ]
};

export class ProofWorkflowPlugin implements WorkflowPlugin {
  readonly id = 'proof-plugin';
  description = 'Captures proof-of-work/agreement tasks and keeps defect loop in sync.';

  private context: WorkflowPluginContext | null = null;
  private taskListener: ((tasks: Task[]) => void) | null = null;

  start(context: WorkflowPluginContext) {
    this.context = context;
    this.taskListener = (tasks) => this.handleTasks(tasks);
    context.events.on('tasks_update', this.taskListener);
  }

  async handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (event.type !== 'phase_enter' || !event.phaseId) {
      return;
    }
    this.ensureProofTasks(event);
  }

  dispose() {
    const ctx = this.context;
    if (ctx && this.taskListener) {
      ctx.events.off('tasks_update', this.taskListener);
    }
    this.taskListener = null;
    this.context = null;
  }

  private handleTasks(tasks: Task[]) {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    tasks.forEach(task => {
      if (!task.labels?.some(label => label.startsWith('workflow:'))) {
        return;
      }
      const info = this.parseWorkflowInfo(task.labels);
      if (!info.workflowId || !info.phaseId) {
        return;
      }
      const instance = ctx.kernel.findInstanceBySession(task.session_id || null);
      if (!instance) {
        return;
      }

      if (this.isProofTask(task) && task.status === 'completed') {
        this.recordProof(ctx, instance, info.phaseId, task);
      }

      if (this.isDefectTask(task)) {
        this.syncDefect(ctx, instance.id, info.phaseId, task);
      }

      this.syncDecisionsAndArtifacts(ctx, instance.id, info.phaseId, task);
    });
  }

  private ensureProofTasks(event: WorkflowRuntimeEvent) {
    const ctx = this.context;
    if (!ctx || !event.phaseId) {
      return;
    }
    const templates = PHASE_PROOF_TEMPLATES[event.phaseId];
    if (!templates || templates.length === 0) {
      return;
    }
    const instance = ctx.kernel.getInstance(event.instanceId);
    if (!instance || !instance.sessionId) {
      return;
    }

    templates.forEach(template => {
      const sessionId = instance.sessionId ?? 'global';
      const uniqueLabel = this.composeProofLabel(event.instanceId, event.phaseId!, template.id);
      const assignee = template.assigneeRole ? this.pickAgentByRole(ctx, template.assigneeRole) : null;
      const status: Task['status'] = assignee ? 'assigned' : 'pending';
      const labels = new Set<string>([
        `workflow:${event.workflowId}`,
        `workflow_phase:${event.phaseId}`,
        'workflow:proof',
        template.proofLabel,
        uniqueLabel
      ]);
      if (template.decision) {
        labels.add(`decision:${template.decision}`);
      }
      if (template.artifactId) {
        labels.add(`artifact:${template.artifactId}`);
      }
      ctx.services.task.createTaskOnceByLabel(uniqueLabel, {
        id: `proof-${event.phaseId}-${template.id}-${Date.now()}`,
        session_id: sessionId,
        title: template.title,
        intent: template.intent,
        description: template.description ?? null,
        scope: 'workflow',
        priority: template.priority || 'medium',
        labels: Array.from(labels),
        due_at: null,
        status,
        assigned_to: assignee,
        parent_task_id: null,
        dependencies: []
      });
    });
  }

  private recordProof(ctx: WorkflowPluginContext, instance: WorkflowInstance, phaseId: string, task: Task) {
    const label = this.getProofLabel(task);
    if (!label) {
      return;
    }
    const proofType = label.includes('agreement') ? 'agreement' : 'work';
    ctx.kernel.recordProof(instance.id, phaseId, {
      id: `proof:${task.id}`,
      type: proofType,
      description: task.result_summary || task.title,
      uri: this.resolveEvidenceUri(task),
      hash: this.computeEvidenceHash(task),
      createdAt: Date.now(),
      createdBy: task.assigned_to || undefined,
      acknowledgers: this.extractAcknowledgers(task)
    });
    ctx.services.proof.recordProof({
      id: `proof:${task.id}`,
      sessionId: instance.sessionId,
      workflowId: instance.workflowId,
      workflowInstanceId: instance.id,
      phaseId,
      proofType,
      taskId: task.id,
      description: task.result_summary || task.title,
      evidenceUri: this.resolveEvidenceUri(task),
      hash: this.computeEvidenceHash(task),
      acknowledgers: this.extractAcknowledgers(task),
      createdBy: task.assigned_to || null,
      metadata: {
        labels: task.labels ?? [],
        source: 'workflow_task'
      }
    });
    ctx.output.appendLine(`[Workflow][plugin:proof] Recorded ${proofType} proof from task ${task.id}`);
  }

  private syncDefect(ctx: WorkflowPluginContext, instanceId: string, phaseId: string, task: Task) {
    const status = task.status === 'completed' ? 'closed' : 'open';
    ctx.kernel.updateDefect(instanceId, phaseId, task.id, status, this.mapPriorityToSeverity(task.priority));
    if (status === 'closed') {
      ctx.output.appendLine(`[Workflow][plugin:proof] Defect ${task.id} closed for phase ${phaseId}`);
    }
  }

  private syncDecisionsAndArtifacts(ctx: WorkflowPluginContext, instanceId: string, phaseId: string, task: Task) {
    if (task.status === 'completed' && task.labels) {
      task.labels
        .filter(label => label.startsWith('decision:'))
        .forEach(label => {
          ctx.kernel.recordDecision(instanceId, phaseId, label.replace('decision:', ''));
        });

      task.labels
        .filter(label => label.startsWith('artifact:'))
        .forEach(label => {
          ctx.kernel.recordArtifact(instanceId, phaseId, {
            id: label.replace('artifact:', ''),
            type: 'artifact',
            description: task.result_summary || task.title,
            uri: this.resolveEvidenceUri(task),
            createdAt: Date.now(),
            createdBy: task.assigned_to || undefined,
            payload: {
              taskId: task.id
            }
          });
        });
    }
  }

  private parseWorkflowInfo(labels?: string[]) {
    let workflowId: string | null = null;
    let phaseId: string | null = null;
    labels?.forEach(label => {
      if (label.startsWith('workflow:') && label !== 'workflow:proof') {
        workflowId = label.replace('workflow:', '');
      } else if (label.startsWith('workflow_phase:')) {
        phaseId = label.replace('workflow_phase:', '');
      }
    });
    return { workflowId, phaseId };
  }

  private getProofLabel(task: Task): string | null {
    const label = task.labels?.find(entry => entry.startsWith('proof:') && entry !== 'proof:auto');
    return label ?? null;
  }

  private isProofTask(task: Task): boolean {
    return Boolean(this.getProofLabel(task));
  }

  private isDefectTask(task: Task): boolean {
    return Boolean(task.labels?.some(label => label === 'defect' || label.startsWith('defect:')));
  }

  private composeProofLabel(instanceId: string, phaseId: string, templateId: string) {
    return `workflow_proof:${instanceId}:${phaseId}:${templateId}`;
  }

  private pickAgentByRole(ctx: WorkflowPluginContext, role: AgentRole): string | null {
    const candidates = ctx.services.agent.getAgentsByRole(role);
    if (!candidates || candidates.length === 0) {
      return null;
    }
    return ctx.services.agent.getLeastLoadedAgent(candidates)?.id ?? candidates[0].id;
  }

  private resolveEvidenceUri(task: Task): string | undefined {
    if (task.result_details && this.looksLikeUri(task.result_details)) {
      return task.result_details;
    }
    const [artifact] = Array.isArray(task.result_artifacts) ? task.result_artifacts : [];
    if (artifact?.uri) {
      return artifact.uri;
    }
    if (typeof artifact?.path === 'string') {
      return artifact.path;
    }
    return undefined;
  }

  private computeEvidenceHash(task: Task): string | undefined {
    const payload = task.result_details
      || (Array.isArray(task.result_artifacts) && task.result_artifacts.length > 0
        ? JSON.stringify(task.result_artifacts[0])
        : '');
    if (!payload) {
      return undefined;
    }
    return createHash('sha256').update(String(payload)).digest('hex');
  }

  private extractAcknowledgers(task: Task): string[] {
    return task.labels
      ?.filter(label => label.startsWith('ack:'))
      .map(label => label.replace('ack:', '')) ?? [];
  }

  private looksLikeUri(value: string) {
    return /^https?:\/\//.test(value) || value.startsWith('/') || value.startsWith('file:');
  }

  private mapPriorityToSeverity(priority?: Priority): string | undefined {
    if (!priority) {
      return undefined;
    }
    if (priority === 'high') {
      return 'critical';
    }
    if (priority === 'medium') {
      return 'major';
    }
    return 'minor';
  }
}
