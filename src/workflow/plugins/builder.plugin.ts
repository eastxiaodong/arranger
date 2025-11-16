import type { WorkflowPlugin, WorkflowPluginContext } from '../workflow-plugin';
import type { WorkflowRuntimeEvent } from '../workflow-types';
import type { Task } from '../../types';

export class BuilderWorkflowPlugin implements WorkflowPlugin {
  readonly id = 'builder-plugin';
  private context: WorkflowPluginContext | null = null;
  private taskListener: ((tasks: Task[]) => void) | null = null;
  private completedInstances = new Set<string>();

  description = 'Hooks into build phase to monitor implementation tasks and future Proof-of-Work enforcement.';

  start(context: WorkflowPluginContext) {
    this.context = context;
    this.taskListener = (tasks) => this.handleTasks(tasks);
    context.events.on('tasks_update', this.taskListener);
  }

  async handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (event.type !== 'phase_enter' || event.phaseId !== 'build') {
      return;
    }
    this.context?.output.appendLine('[Workflow][plugin] Build phase entered');
  }

  dispose() {
    const ctx = this.context;
    if (this.taskListener && ctx) {
      ctx.events.off('tasks_update', this.taskListener);
    }
    this.taskListener = null;
    this.context = null;
    this.completedInstances.clear();
  }

  private handleTasks(tasks: Task[]) {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    tasks.forEach(task => {
      if (!task.labels?.includes('workflow_phase:build')) {
        return;
      }
      if (task.status !== 'completed') {
        return;
      }
      const instance = ctx.kernel.findInstanceBySession(task.session_id || null);
      if (!instance || this.completedInstances.has(instance.id)) {
        return;
      }
      this.completedInstances.add(instance.id);
      ctx.kernel.updateTrackedTask(instance.id, 'build', {
        id: 'implementation_complete',
        status: 'completed',
        lastUpdated: Date.now()
      });
      ctx.output.appendLine(`[Workflow][plugin:builder] Implementation marked complete for ${instance.id}`);
    });
  }
}
