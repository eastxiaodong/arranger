import type { Task } from '../../core/types';
import { MessageService } from '../communication/message.service';

export interface TaskContextSnapshot {
  summary: string;
  highlights: string[];
  signature: string;
  generated_at: number;
}

export class TaskContextService {
  private cache = new Map<string, TaskContextSnapshot>();

  constructor(
    private readonly messageService: MessageService
  ) {}

  getContext(task: Task): TaskContextSnapshot {
    const signature = this.buildSignature(task);
    const cached = this.cache.get(task.id);
    if (cached && cached.signature === signature) {
      return cached;
    }

    const snapshot = this.buildSnapshot(task, signature);
    this.cache.set(task.id, snapshot);
    return snapshot;
  }

  invalidate(taskId?: string) {
    if (taskId) {
      this.cache.delete(taskId);
    } else {
      this.cache.clear();
    }
  }

  private buildSignature(task: Task): string {
    return `${task.updated_at || 0}:${task.status}:${task.result_summary || ''}`;
  }

  private buildSnapshot(task: Task, signature: string): TaskContextSnapshot {
    const parts: string[] = [];
    if (task.description) {
      parts.push(`需求描述：${task.description}`);
    }
    if (task.result_summary) {
      parts.push(`历史结论：${task.result_summary}`);
    }

    const relatedMessages = this.messageService
      .getAllMessages({ session_id: task.session_id })
      .filter(msg => this.messageReferencesTask(msg, task.id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5)
      .map(msg => `- ${new Date(msg.created_at).toLocaleString()} @${msg.agent_id}: ${msg.content}`);

    if (relatedMessages.length) {
      parts.push('最近更新：\n' + relatedMessages.join('\n'));
    }

    const summary = parts.join('\n\n');
    return {
      summary,
      highlights: relatedMessages,
      signature,
      generated_at: Date.now()
    };
  }

  private messageReferencesTask(message: any, taskId: string): boolean {
    if (!message) {
      return false;
    }
    if (message.reference_id === taskId) {
      return true;
    }
    const references = Array.isArray(message.references)
      ? message.references
      : [];
    return references.some((token: string) => {
      if (!token || typeof token !== 'string') {
        return false;
      }
      return token === taskId || token === `task:${taskId}`;
    });
  }
}
