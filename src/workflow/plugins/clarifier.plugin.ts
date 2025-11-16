import type { WorkflowPlugin, WorkflowPluginContext } from '../workflow-plugin';
import type { WorkflowRuntimeEvent } from '../workflow-types';
import type { Task } from '../../types';

export class ClarifierWorkflowPlugin implements WorkflowPlugin {
  readonly id = 'clarifier-plugin';
  private context: WorkflowPluginContext | null = null;
  private taskListener: ((tasks: Task[]) => void) | null = null;
  private clarifiedInstances = new Set<string>();
  private handledTasks = new Set<string>();

  description = 'Handles clarify-phase automation such as recording requirement artifacts.';

  start(context: WorkflowPluginContext) {
    this.context = context;
    this.taskListener = (tasks) => this.handleTasks(tasks);
    context.events.on('tasks_update', this.taskListener);
  }

  async handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (event.type !== 'phase_enter' || event.phaseId !== 'clarify') {
      return;
    }
    this.context?.output.appendLine('[Workflow][plugin] Clarifier phase activated');
  }

  dispose() {
    const ctx = this.context;
    if (this.taskListener && ctx) {
      ctx.events.off('tasks_update', this.taskListener);
    }
    this.taskListener = null;
    this.context = null;
    this.clarifiedInstances.clear();
    this.handledTasks.clear();
  }

  private handleTasks(tasks: Task[]) {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    tasks.forEach(task => {
      if (!task.labels?.includes('workflow_phase:clarify')) {
        return;
      }
      if (task.status !== 'completed' || this.handledTasks.has(task.id)) {
        return;
      }
      this.handledTasks.add(task.id);
      const instance = ctx.kernel.findInstanceBySession(task.session_id || null);
      if (!instance || this.clarifiedInstances.has(instance.id)) {
        return;
      }
      this.clarifiedInstances.add(instance.id);
      ctx.kernel.recordDecision(instance.id, 'clarify', 'clarified_scope');
      ctx.kernel.recordArtifact(instance.id, 'clarify', {
        id: 'acceptance_criteria',
        type: 'document',
        description: task.result_summary || 'Clarification captured',
        createdAt: Date.now(),
        createdBy: task.assigned_to || undefined,
        payload: {
          taskId: task.id
        }
      });
      ctx.output.appendLine(`[Workflow][plugin:clarifier] Clarification decision recorded for instance ${instance.id}`);
    });
  }
}
