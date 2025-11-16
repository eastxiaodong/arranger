import type { WorkflowPlugin, WorkflowPluginContext } from '../workflow-plugin';
import type { WorkflowRuntimeEvent, AutoTaskTemplate } from '../workflow-types';
import type { Task, AgentRole } from '../../types';
import { normalizeScenarioId } from '../scenario-registry';
import { generateTasksFromTemplate, type GeneratedTaskSpec } from '../task-generator';

const HUMAN_ESCALATION_LABEL = 'workflow:human_required';
const HUMAN_ROLE_LABEL = 'workflow_role:human_portal';

const VALID_AGENT_ROLES: AgentRole[] = [
  'admin',
  'developer',
  'reviewer',
  'tester',
  'security',
  'documenter',
  'coordinator',
  'analyzer'
];

const VALID_AGENT_ROLE_SET = new Set<AgentRole>(VALID_AGENT_ROLES);

const ROLE_SYNONYMS: Partial<Record<string, AgentRole>> = {
  product: 'coordinator',
  architect: 'developer',
  scribe: 'documenter',
  qa: 'tester',
  pm: 'coordinator',
  analyst: 'analyzer'
};

export class AutoTaskWorkflowPlugin implements WorkflowPlugin {
  readonly id = 'auto-task-plugin';
  private context: WorkflowPluginContext | null = null;
  private taskListener: ((tasks: Task[]) => void) | null = null;

  description = 'Generates tasks defined in phase entry auto_tasks.';

  start(context: WorkflowPluginContext) {
    this.context = context;
    this.taskListener = (tasks) => this.handleTaskUpdates(tasks);
    context.events.on('tasks_update', this.taskListener);
    this.requeueLegacyAssignments();
  }

  async handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (event.type !== 'phase_enter' || !event.phaseId) {
      return;
    }
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    const definition = ctx.kernel.getDefinition(event.workflowId);
    if (!definition) {
      ctx.output.appendLine(`[Workflow][plugin:auto-task] Unknown definition ${event.workflowId}`);
      return;
    }
    const phase = definition.phases.find(p => p.id === event.phaseId);
    if (!phase || !phase.entry?.auto_tasks?.length) {
      return;
    }
    const instance = ctx.kernel.getInstance(event.instanceId);
    if (!instance) {
      ctx.output.appendLine(`[Workflow][plugin:auto-task] Unknown instance ${event.instanceId}`);
      return;
    }
    const sessionId = instance.sessionId;
    if (!sessionId) {
      ctx.output.appendLine('[Workflow][plugin:auto-task] Missing session context for auto task');
      return;
    }
    const scenarioLabels = this.extractScenarioLabels(instance.metadata);
    const scenarioValues = this.extractScenarioValues(instance.metadata);
    phase.entry.auto_tasks.forEach(template => {
      this.spawnAutoTask(ctx, event.workflowId, instance.id, phase.id, sessionId, template, scenarioLabels, scenarioValues);
    });
  }

  dispose() {
    const ctx = this.context;
    if (this.taskListener && ctx) {
      ctx.events.off('tasks_update', this.taskListener);
    }
    this.taskListener = null;
    this.context = null;
  }

  private spawnAutoTask(
    ctx: WorkflowPluginContext,
    workflowId: string,
    instanceId: string,
    phaseId: string,
    sessionId: string,
    template: AutoTaskTemplate,
    scenarioLabels: string[],
    scenarioValues: string[]
  ) {
    const instanceMetadata = ctx.kernel.getInstance(instanceId)?.metadata ?? null;
    const specs = this.expandTaskSpecs(template, {
      workflowId,
      instanceId,
      phaseId,
      sessionId,
      scenario: scenarioValues,
      instanceMetadata
    });
    if (!specs.length) {
      this.spawnFallbackTask(ctx, workflowId, instanceId, phaseId, sessionId, template, scenarioLabels, scenarioValues);
      return;
    }
    specs.forEach((spec, index) => {
      this.spawnTaskFromSpec(ctx, workflowId, instanceId, phaseId, sessionId, template, spec, scenarioLabels, scenarioValues, index);
    });
  }

  private expandTaskSpecs(
    template: AutoTaskTemplate,
    context: { workflowId: string; instanceId: string; phaseId: string; sessionId: string; scenario: string[]; instanceMetadata?: Record<string, any> | null }
  ): GeneratedTaskSpec[] {
    if (template.generator) {
      return generateTasksFromTemplate({
        workflowId: context.workflowId,
        instanceId: context.instanceId,
        phaseId: context.phaseId,
        sessionId: context.sessionId,
        scenario: context.scenario,
        instanceMetadata: context.instanceMetadata,
        template
      });
    }
    return [{
      title: template.template || `Workflow Task (${context.phaseId})`,
      intent: template.intent,
      assignee_role: this.normalizeRole(template.assignee_role) ?? null,
      description: template.metadata?.description,
      priority: template.priority,
      labels: template.labels ?? undefined,
      metadata: template.metadata ?? null
    }];
  }

  private spawnFallbackTask(
    ctx: WorkflowPluginContext,
    workflowId: string,
    instanceId: string,
    phaseId: string,
    sessionId: string,
    template: AutoTaskTemplate,
    scenarioLabels: string[],
    scenarioValues: string[]
  ) {
    const spec: GeneratedTaskSpec = {
      title: template.template || `Workflow Task (${phaseId})`,
      intent: template.intent || `workflow_${phaseId}`,
      assignee_role: this.normalizeRole(template.assignee_role) ?? null,
      priority: template.priority,
      metadata: template.metadata ?? null,
      labels: template.labels ?? undefined
    };
    this.spawnTaskFromSpec(ctx, workflowId, instanceId, phaseId, sessionId, template, spec, scenarioLabels, scenarioValues, 0);
  }

  private spawnTaskFromSpec(
    ctx: WorkflowPluginContext,
    workflowId: string,
    instanceId: string,
    phaseId: string,
    sessionId: string,
    template: AutoTaskTemplate,
    spec: GeneratedTaskSpec,
    scenarioLabels: string[],
    scenarioValues: string[],
    index: number
  ) {
    const requestedRole = (spec.assignee_role ?? template.assignee_role) || null;
    const canonicalRole = this.normalizeRole(requestedRole);
    if (!canonicalRole && requestedRole) {
      ctx.output.appendLine(`[Workflow][plugin:auto-task] 角色 ${requestedRole} 未配置，尝试人工兜底`);
    }
    const hasAgentForRole = this.hasAgentCandidate(ctx, canonicalRole);
    const requiresHuman = canonicalRole ? !hasAgentForRole : false;
    const combinedLabels = new Set<string>([...(template.labels ?? []), ...(spec.labels ?? [])]);
    const labels = this.composeLabels(
      workflowId,
      instanceId,
      phaseId,
      Array.from(combinedLabels),
      canonicalRole ?? undefined,
      requiresHuman,
      scenarioLabels
    );
    const metadata = this.mergeMetadata(template.metadata, spec.metadata);
    if (metadata && !metadata.scenario) {
      metadata.scenario = scenarioValues;
    }
    const title = spec.title || template.template || `Workflow Task (${phaseId})`;
    const intent = spec.intent || template.intent || `workflow_${phaseId}`;
    const taskId = `task-${phaseId}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 5)}`;
    try {
      const task = ctx.services.task.createTask({
        id: taskId,
        session_id: sessionId,
        intent,
        title,
        description: spec.description || template.metadata?.description || undefined,
        scope: 'workflow',
        priority: spec.priority || template.priority || 'medium',
        labels,
        due_at: null,
        status: 'pending',
        assigned_to: null,
        parent_task_id: null,
        dependencies: [],
        metadata: metadata ?? null
      });
      ctx.kernel.updateTrackedTask(instanceId, phaseId, {
        id: task.id,
        intent: task.intent,
        status: task.status,
        assignee: task.assigned_to,
        labels: task.labels ?? undefined,
        lastUpdated: Date.now()
      });
      ctx.output.appendLine(`[Workflow][plugin:auto-task] Spawned ${task.id} (${title}) for phase ${phaseId}`);
      if (requiresHuman) {
        this.notifyHumanFallback(ctx, sessionId, phaseId, task, template);
      }
    } catch (error: any) {
      ctx.output.appendLine(`[Workflow][plugin:auto-task] Failed to spawn task for ${phaseId}: ${error?.message ?? error}`);
    }
  }

  private normalizeRole(role?: string | null): AgentRole | null {
    if (!role) {
      return null;
    }
    const lower = role.toLowerCase();
    const synonym = ROLE_SYNONYMS[lower];
    if (synonym && VALID_AGENT_ROLE_SET.has(synonym)) {
      return synonym;
    }
    if (VALID_AGENT_ROLE_SET.has(lower as AgentRole)) {
      return lower as AgentRole;
    }
    return null;
  }

  private composeLabels(
    workflowId: string,
    instanceId: string,
    phaseId: string,
    labels?: string[],
    role?: AgentRole,
    requiresHuman?: boolean,
    scenarioLabels?: string[]
  ): string[] {
    const base = new Set<string>(labels || []);
    base.add(`workflow:${workflowId}`);
    base.add(`workflow_phase:${phaseId}`);
    base.add(`workflow_instance:${instanceId}`);
    base.add('workflow:auto');
    scenarioLabels?.forEach(label => base.add(label));
    if (role) {
      base.add(`workflow_role:${role}`);
      base.add(`role:${role}`);
    }
    if (requiresHuman) {
      base.add(HUMAN_ESCALATION_LABEL);
      base.add(HUMAN_ROLE_LABEL);
    }
    return Array.from(base);
  }

  private extractScenarioLabels(metadata?: Record<string, any> | null): string[] {
    if (!metadata) {
      return [];
    }
    const raw = metadata.scenario;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list
      .map(value => normalizeScenarioId(String(value)))
      .filter(Boolean)
      .map(value => `scenario:${value}`);
  }

  private extractScenarioValues(metadata?: Record<string, any> | null): string[] {
    if (!metadata || metadata.scenario === undefined || metadata.scenario === null) {
      return [];
    }
    const raw = Array.isArray(metadata.scenario) ? metadata.scenario : [metadata.scenario];
    return raw.map(value => normalizeScenarioId(String(value))).filter(Boolean);
  }

  private mergeMetadata(
    base?: Record<string, any> | null,
    addition?: Record<string, any> | null
  ): Record<string, any> | null {
    if (!base && !addition) {
      return null;
    }
    const copy = base ? JSON.parse(JSON.stringify(base)) : {};
    if (addition) {
      const extra = JSON.parse(JSON.stringify(addition));
      Object.assign(copy, extra);
    }
    return Object.keys(copy).length ? copy : null;
  }

  private notifyHumanFallback(
    ctx: WorkflowPluginContext,
    sessionId: string,
    phaseId: string,
    task: Task,
    template: AutoTaskTemplate
  ) {
    const humanMessage = `阶段 ${phaseId} 需要人工接管：${template.template || template.intent || task.title}`;
    ctx.output.appendLine(`[Workflow][plugin:auto-task] ${humanMessage}`);
    const metadata: Record<string, any> = {
      task_id: task.id,
      workflow_phase_id: phaseId
    };
    const instanceId = this.extractWorkflowInstanceId(task);
    if (instanceId) {
      metadata.workflow_instance_id = instanceId;
    }
    ctx.services.notification?.sendNotification({
      session_id: sessionId,
      level: 'warning',
      title: '需要人工接管',
      message: humanMessage,
      metadata
    });
  }

  private extractWorkflowInstanceId(task: Task): string | null {
    if (!task || !Array.isArray(task.labels)) {
      return null;
    }
    const label = task.labels.find(item => typeof item === 'string' && item.startsWith('workflow_instance:'));
    return label ? label.replace('workflow_instance:', '') : null;
  }

  private handleTaskUpdates(tasks: Task[]) {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    tasks.forEach(task => {
      if (!task.labels?.some(label => label.startsWith('workflow:'))) {
        return;
      }
      const info = this.parseWorkflowInfo(task.labels);
      const instance = info.instanceId
        ? ctx.kernel.getInstance(info.instanceId)
        : ctx.kernel.findInstanceBySession(task.session_id || null);
      if (!instance || !info.phaseId) {
        return;
      }
      ctx.kernel.updateTrackedTask(instance.id, info.phaseId, {
        id: task.id,
        intent: task.intent,
        status: task.status,
        assignee: task.assigned_to,
        labels: task.labels ?? undefined,
        lastUpdated: Date.now()
      });
    });
  }

  private parseWorkflowInfo(labels?: string[]) {
    let workflowId: string | null = null;
    let phaseId: string | null = null;
    let instanceId: string | null = null;
    labels?.forEach(label => {
      if (label.startsWith('workflow:')) {
        workflowId = label.replace('workflow:', '');
      } else if (label.startsWith('workflow_phase:')) {
        phaseId = label.replace('workflow_phase:', '');
      } else if (label.startsWith('workflow_instance:')) {
        instanceId = label.replace('workflow_instance:', '');
      }
    });
    return { workflowId, phaseId, instanceId };
  }

  private hasAgentCandidate(ctx: WorkflowPluginContext, role: AgentRole | null): boolean {
    if (!role) {
      return false;
    }
    const candidates = ctx.services.agent.getAgentsByRole(role);
    return Array.isArray(candidates) && candidates.length > 0;
  }

  private requeueLegacyAssignments() {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    const stuckTasks = ctx.services.task.getAllTasks({})
      .filter(task =>
        task.status === 'assigned' &&
        task.assigned_to &&
        task.labels?.includes('workflow:auto')
      );
    if (stuckTasks.length === 0) {
      return;
    }
    stuckTasks.forEach(task => {
      ctx.services.task.releaseTaskClaim(task.id, task.assigned_to ?? undefined);
      ctx.output.appendLine(`[Workflow][plugin:auto-task] Re-queued legacy auto task ${task.id} for scheduler assignment`);
    });
  }
}
