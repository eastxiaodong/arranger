import * as fs from 'fs';
import * as path from 'path';
import type { TaskMetrics } from '../../core/types';
import { TypedEventEmitter } from '../../core/events/emitter';
import * as vscode from 'vscode';

interface SnapshotEntry extends TaskMetrics {
  timestamp: number;
}

interface PerformanceRecorderOptions {
  maxEntries?: number;
}

export class PerformanceRecorder {
  private readonly entries: SnapshotEntry[] = [];
  private readonly storagePath: string;
  private readonly maxEntries: number;
  private readonly listener: (metrics: TaskMetrics) => void;

  constructor(
    private readonly events: TypedEventEmitter,
    private readonly logger: vscode.OutputChannel,
    private readonly workspaceRoot: string,
    options?: PerformanceRecorderOptions
  ) {
    this.maxEntries = options?.maxEntries ?? 200;
    const dir = path.join(this.workspaceRoot, '.arranger');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.storagePath = path.join(dir, 'perf-metrics.json');
    this.loadFromDisk();
    this.listener = (metrics: TaskMetrics) => this.handleMetrics(metrics);
    this.events.on('task_metrics_update', this.listener);
  }

  dispose() {
    this.events.off('task_metrics_update', this.listener);
  }

  private loadFromDisk() {
    if (!fs.existsSync(this.storagePath)) {
      return;
    }
    try {
      const content = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        (parsed as unknown[])
          .filter((entry: any) => entry && typeof entry.timestamp === 'number')
          .forEach((entry: any) => this.entries.push(entry as SnapshotEntry));
      } else if (Array.isArray((parsed as any)?.entries)) {
        (parsed as any).entries
          .filter((entry: any) => entry && typeof entry.timestamp === 'number')
          .forEach((entry: any) => this.entries.push(entry as SnapshotEntry));
      }
    } catch (error: any) {
      this.logger.appendLine(`[PerformanceRecorder] Failed to load history: ${error?.message ?? error}`);
    }
  }

  private handleMetrics(metrics: TaskMetrics) {
    const entry: SnapshotEntry = {
      ...metrics,
      timestamp: Date.now()
    };
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.persist();
  }

  private persist() {
    try {
      const payload = {
        updated_at: Date.now(),
        entries: this.entries
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error: any) {
      this.logger.appendLine(`[PerformanceRecorder] Failed to persist metrics: ${error?.message ?? error}`);
    }
  }

  public getSnapshot() {
    return {
      generated_at: Date.now(),
      entry_count: this.entries.length,
      entries: this.entries
    };
  }

  public isEmpty() {
    return this.entries.length === 0;
  }
}
