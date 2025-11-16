import * as vscode from 'vscode';
import type { Services } from '../services';
import type { TypedEventEmitter } from '../events/emitter';
import type { Agent, Task } from '../types';
import { AgentEngine } from '../agent/engine';
import { buildConfigFromAgent } from '../helpers/agent-config';

interface RuntimeEntry {
  engine: AgentEngine;
  idleTimer: NodeJS.Timeout | null;
}

const DEFAULT_IDLE_DISPOSE_MS = 5 * 60 * 1000;

export class AgentRuntimePool implements vscode.Disposable {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private disposed = false;
  private taskListener: ((tasks: Task[]) => void) | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: Services,
    private readonly events: TypedEventEmitter,
    private readonly output: vscode.OutputChannel,
    private readonly options?: {
      idleDisposeMs?: number;
    }
  ) {}

  start() {
    if (this.disposed) {
      return;
    }
    if (!this.taskListener) {
      this.taskListener = (tasks) => this.handleTasksUpdate(tasks);
      this.events.on('tasks_update', this.taskListener);
    }
    this.context.subscriptions.push(this);
    this.output.appendLine('[AgentRuntimePool] Initialized');
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.taskListener) {
      this.events.off('tasks_update', this.taskListener);
      this.taskListener = null;
    }
    for (const [agentId] of Array.from(this.runtimes.entries())) {
      void this.stopEngine(agentId);
    }
    this.runtimes.clear();
  }

  isEngineActive(agentId: string): boolean {
    return this.runtimes.has(agentId);
  }

  async ensureEngine(agentId: string): Promise<AgentEngine> {
    if (this.disposed) {
      throw new Error('AgentRuntimePool has been disposed');
    }
    const existing = this.runtimes.get(agentId);
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      return existing.engine;
    }
    const agent = this.services.agent.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    this.ensureAgentReady(agent);
    const config = buildConfigFromAgent(agent);
    const engine = new AgentEngine(config, this.context, this.services, this.events, this.output);
    try {
      await engine.start(`auto-session-${agent.id}`);
    } catch (error: any) {
      this.services.agent.markAgentOffline(agent.id, error?.message ?? '启动失败');
      throw error;
    }
    this.runtimes.set(agent.id, {
      engine,
      idleTimer: null
    });
    this.output.appendLine(`[AgentRuntimePool] Engine started for ${agent.display_name || agent.id}`);
    return engine;
  }

  releaseEngine(agentId: string) {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      return;
    }
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }
    runtime.idleTimer = setTimeout(() => {
      void this.stopEngine(agentId);
    }, this.getIdleTimeout());
  }

  private async stopEngine(agentId: string) {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      return;
    }
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }
    try {
      await runtime.engine.stop();
      this.output.appendLine(`[AgentRuntimePool] Engine stopped for ${agentId}`);
    } catch (error: any) {
      this.output.appendLine(`[AgentRuntimePool] Failed to stop engine for ${agentId}: ${error?.message ?? error}`);
    } finally {
      this.runtimes.delete(agentId);
    }
  }

  private ensureAgentReady(agent: Agent) {
    const hasLLM = agent.llm_provider && agent.llm_api_key;
    if (!hasLLM) {
      throw new Error(`Agent ${agent.display_name || agent.id} 缺少 LLM 配置，无法启动。`);
    }
    if (agent.is_enabled === false) {
      throw new Error(`Agent ${agent.display_name || agent.id} 已被禁用`);
    }
  }

  private handleTasksUpdate(tasks: Task[]) {
    if (this.disposed) {
      return;
    }
    const activeAgents = new Set(
      tasks
        .filter(task =>
          task.assigned_to &&
          (task.status === 'assigned' || task.status === 'running' || task.status === 'pending')
        )
        .map(task => task.assigned_to as string)
    );

    for (const [agentId, runtime] of this.runtimes.entries()) {
      if (activeAgents.has(agentId)) {
        if (runtime.idleTimer) {
          clearTimeout(runtime.idleTimer);
          runtime.idleTimer = null;
        }
      } else if (!runtime.idleTimer) {
        runtime.idleTimer = setTimeout(() => {
          void this.stopEngine(agentId);
        }, this.getIdleTimeout());
      }
    }
  }

  private getIdleTimeout() {
    return this.options?.idleDisposeMs ?? DEFAULT_IDLE_DISPOSE_MS;
  }
}
