import * as vscode from 'vscode';
import type { TaskMetrics } from '../types';
import { TaskService } from '../services/task.service';
import { TypedEventEmitter } from '../events/emitter';

interface TaskMonitorOptions {
  intervalMs?: number;
}

export class TaskMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;

  constructor(
    private readonly taskService: TaskService,
    private readonly events: TypedEventEmitter,
    private readonly logger: vscode.OutputChannel,
    options?: TaskMonitorOptions
  ) {
    this.intervalMs = options?.intervalMs ?? 30000;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.logger.appendLine('[TaskMonitor] Starting task monitor');
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.appendLine('[TaskMonitor] Task monitor stopped');
    }
  }

  private tick() {
    try {
      const metrics: TaskMetrics = this.taskService.runMaintenanceSweep();
      if (metrics.sweep_duration_ms && metrics.sweep_duration_ms > 250) {
        this.logger.appendLine(`[TaskMonitor] Sweep took ${metrics.sweep_duration_ms}ms (>250ms)`);
      }
      this.events.emit('task_metrics_update', metrics);
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logger.appendLine(`[TaskMonitor] Tick failed: ${message}`);
    }
  }
}
