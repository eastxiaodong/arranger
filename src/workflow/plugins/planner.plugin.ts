import type { WorkflowPlugin, WorkflowPluginContext } from '../workflow-plugin';
import type { WorkflowRuntimeEvent } from '../workflow-types';
import type { Task } from '../../types';

export class PlannerWorkflowPlugin implements WorkflowPlugin {
  readonly id = 'planner-plugin';
  private context: WorkflowPluginContext | null = null;
  private taskListener: ((tasks: Task[]) => void) | null = null;
  private signedOffInstances = new Set<string>();

  description = 'Watches plan phase to spawn architecture breakdown tasks.';

  start(context: WorkflowPluginContext) {
    this.context = context;
    this.taskListener = (tasks) => this.handleTasks(tasks);
    context.events.on('tasks_update', this.taskListener);
  }

  async handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (event.type !== 'phase_enter' || event.phaseId !== 'plan') {
      return;
    }
    this.context?.output.appendLine('[Workflow][plugin] Plan phase entered');
  }

  dispose() {
    const ctx = this.context;
    if (this.taskListener && ctx) {
      ctx.events.off('tasks_update', this.taskListener);
    }
    this.taskListener = null;
    this.context = null;
    this.signedOffInstances.clear();
  }

  private handleTasks(tasks: Task[]) {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    tasks.forEach(task => {
      if (!task.labels?.includes('workflow_phase:plan')) {
        return;
      }
      if (task.status !== 'completed') {
        return;
      }
      const instance = ctx.kernel.findInstanceBySession(task.session_id || null);
      if (!instance || this.signedOffInstances.has(instance.id)) {
        return;
      }
      this.signedOffInstances.add(instance.id);
      ctx.kernel.recordDecision(instance.id, 'plan', 'architecture_signoff');
      ctx.kernel.updateTrackedTask(instance.id, 'plan', {
        id: 'design_tasks_generated',
        status: 'completed',
        lastUpdated: Date.now()
      });
      ctx.kernel.updateTrackedTask(instance.id, 'plan', {
        id: 'implementation_tasks_generated',
        status: 'completed',
        lastUpdated: Date.now()
      });
      ctx.output.appendLine(`[Workflow][plugin:planner] Sign-off + task generation recorded for ${instance.id}`);
    });
  }
}
