import type { OutputChannel } from 'vscode';
import type { TypedEventEmitter } from '../../core/events/emitter';
import type { AceContextService } from './ace-context.service';
import type { ToolExecutionService } from '../../domain/execution/tool-execution.service';
import type { StateStore } from '../../domain/state';
import type { NotificationService } from '../../domain/communication/notification.service';
import type { MessageService } from '../../domain/communication/message.service';
import type { TaskStateRecord } from '../../core/types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface AutomationOptions {
  ace: AceContextService;
  tools: ToolExecutionService;
  state: StateStore;
  events: TypedEventEmitter;
  output: OutputChannel;
  notifications?: NotificationService;
  messages?: MessageService;
}

export class AutomationService {
  constructor(private readonly options: AutomationOptions) {
    this.options.events.on('state:task_created', this.handleTaskCreated);
    // 周期性检查 ACE 过期/失败
    setInterval(() => this.checkAceFreshness(), ONE_DAY_MS / 12); // 每 2 小时
  }

  dispose() {
    this.options.events.off('state:task_created', this.handleTaskCreated);
  }

  /**
   * 自动触发 ACE 刷新（例如新任务到来、索引过期或失败）
   */
  async triggerAceRefresh(sessionId: string | null, reason: string, delayMs = 0): Promise<void> {
    const trigger = () => {
      this.options.output.appendLine(`[Automation] 触发 ACE 索引刷新，原因：${reason}`);
      this.options.messages?.sendMessage({
        id: `auto_ace_${Date.now()}`,
        session_id: sessionId || '',
        agent_id: 'manager_llm',
        content: `自动刷新上下文索引（原因：${reason}）`,
        priority: 'medium',
        tags: ['automation', 'ace'],
        reply_to: null,
        references: null,
        reference_type: null,
        reference_id: null,
        mentions: null,
        expires_at: null,
        category: 'system_event',
        visibility: 'blackboard',
        payload: {
          reason,
          type: 'ace_refresh'
        }
      });
      void this.options.ace.refreshIndex().catch(err => {
        this.options.output.appendLine(`[Automation] ACE 索引刷新失败：${err?.message ?? err}`);
        this.options.notifications?.sendNotification({
          session_id: sessionId || '',
          level: 'error',
          title: 'ACE 刷新失败',
          message: err?.message ?? '未知错误',
          metadata: { reason }
        });
      });
    };

    if (delayMs > 0) {
      setTimeout(trigger, delayMs);
    } else {
      trigger();
    }
  }

  /**
   * 针对普通命令的自动化排队（支持延迟）
   */
  scheduleCommand(command: {
    session_id?: string | null;
    task_id?: string | null;
    tool_name: string;
    command: string;
    delay_ms?: number;
    runner?: 'automation' | 'mcp' | 'manual' | 'system' | 'ace';
    source?: string | null;
    created_by?: string | null;
    confirmed?: boolean;
  }) {
    return this.options.tools.scheduleExternalCommand(command);
  }

  private handleTaskCreated = (taskState: TaskStateRecord) => {
    const aceState = this.options.state.getAceState();
    const lastIndexAt = aceState?.lastIndex?.completedAt || 0;
    const stale = !lastIndexAt || Date.now() - lastIndexAt > ONE_DAY_MS || (aceState?.failureStreak || 0) > 0;
    if (!stale) {
      return;
    }
    void this.triggerAceRefresh(taskState.sessionId, '新任务创建且索引过期/失败', 2000);
  };

  private checkAceFreshness() {
    const aceState = this.options.state.getAceState();
    if (!aceState) {
      return;
    }
    const lastIndexAt = aceState.lastIndex?.completedAt || 0;
    const stale = !lastIndexAt || Date.now() - lastIndexAt > ONE_DAY_MS;
    const hasFailures = (aceState.failureStreak || 0) > 0;
    if (stale || hasFailures) {
      const reason = stale ? '索引超过 24 小时未刷新' : `连续失败 ${aceState.failureStreak} 次`;
      this.options.notifications?.sendNotification({
        session_id: '',
        level: 'warning',
        title: 'ACE 状态提醒',
        message: reason,
        metadata: {
          projectRoot: aceState.projectRoot,
          failureStreak: aceState.failureStreak
        }
      });
      this.options.messages?.sendMessage({
        id: `ace_state_warn_${Date.now()}`,
        session_id: aceState.workspaceRoot || 'default',
        agent_id: 'system',
        content: `ACE 状态异常：${reason}，已尝试自动刷新`,
        priority: 'medium',
        tags: ['ace', 'automation'],
        reply_to: null,
        references: null,
        reference_type: null,
        reference_id: null,
        mentions: null,
        expires_at: null,
        category: 'system_event',
        visibility: 'blackboard',
        payload: {
          failureStreak: aceState.failureStreak,
          projectRoot: aceState.projectRoot
        }
      });
      void this.triggerAceRefresh(null, reason, 1000);
    }
  }
}
