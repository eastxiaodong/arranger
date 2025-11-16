import type * as vscode from 'vscode';
import type { TypedEventEmitter } from '../events/emitter';
import type { Services } from '../services';
import type { WorkflowKernel } from './workflow-kernel';
import type { WorkflowRuntimeEvent } from './workflow-types';

export interface WorkflowPluginContext {
  kernel: WorkflowKernel;
  services: Services;
  events: TypedEventEmitter;
  output: vscode.OutputChannel;
  defaultWorkflowId: string;
}

export interface WorkflowPlugin {
  id: string;
  description?: string;
  start(context: WorkflowPluginContext): void | Promise<void>;
  handleWorkflowEvent?(event: WorkflowRuntimeEvent): void | Promise<void>;
  dispose(): void;
}
