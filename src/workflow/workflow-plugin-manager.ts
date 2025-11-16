import type * as vscode from 'vscode';
import type { TypedEventEmitter } from '../events/emitter';
import type { Services } from '../services';
import type { WorkflowKernel } from './workflow-kernel';
import type { WorkflowRuntimeEvent } from './workflow-types';
import type { WorkflowPlugin, WorkflowPluginContext } from './workflow-plugin';

export class WorkflowPluginManager implements vscode.Disposable {
  private readonly plugins: WorkflowPlugin[] = [];
  private disposed = false;
  private workflowEventListener: ((event: WorkflowRuntimeEvent) => void) | null = null;

  constructor(
    private readonly kernel: WorkflowKernel,
    private readonly services: Services,
    private readonly events: TypedEventEmitter,
    private readonly output: vscode.OutputChannel,
    private readonly defaultWorkflowId: string
  ) {}

  register(plugin: WorkflowPlugin) {
    this.plugins.push(plugin);
  }

  async start(context: vscode.ExtensionContext) {
    const pluginContext: WorkflowPluginContext = {
      kernel: this.kernel,
      services: this.services,
      events: this.events,
      output: this.output,
      defaultWorkflowId: this.defaultWorkflowId
    };
    for (const plugin of this.plugins) {
      try {
        await plugin.start(pluginContext);
        this.output.appendLine(`[Workflow][plugin] ${plugin.id} started`);
      } catch (error: any) {
        this.output.appendLine(`[Workflow][plugin] ${plugin.id} failed to start: ${error?.message ?? error}`);
      }
    }
    this.workflowEventListener = (event) => this.handleWorkflowEvent(event);
    this.events.on('workflow_event', this.workflowEventListener);
    context.subscriptions.push(this);
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.workflowEventListener) {
      this.events.off('workflow_event', this.workflowEventListener);
      this.workflowEventListener = null;
    }
    for (const plugin of this.plugins) {
      try {
        plugin.dispose();
      } catch (error: any) {
        this.output.appendLine(`[Workflow][plugin] ${plugin.id} dispose failed: ${error?.message ?? error}`);
      }
    }
    this.plugins.length = 0;
  }

  private async handleWorkflowEvent(event: WorkflowRuntimeEvent) {
    for (const plugin of this.plugins) {
      if (typeof plugin.handleWorkflowEvent !== 'function') {
        continue;
      }
      try {
        await plugin.handleWorkflowEvent(event);
      } catch (error: any) {
        this.output.appendLine(`[Workflow][plugin] ${plugin.id} failed handling event ${event.type}: ${error?.message ?? error}`);
      }
    }
  }
}
