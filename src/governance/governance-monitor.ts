import * as vscode from 'vscode';
import type { Approval, Task, Topic } from '../types';
import type { VoteService } from '../services/vote.service';
import type { ApprovalService } from '../services/approval.service';
import type { NotificationService } from '../services/notification.service';
import type { TaskService } from '../services/task.service';

interface GovernanceMonitorOptions {
  checkIntervalMs?: number;
  voteWarningThresholdMs?: number;
  voteReminderCooldownMs?: number;
  approvalReminderMs?: number;
  approvalReminderCooldownMs?: number;
}

interface GovernanceMonitorDependencies {
  vote: VoteService;
  approval: ApprovalService;
  notification: NotificationService;
  task: TaskService;
}

export class GovernanceMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly options: Required<GovernanceMonitorOptions>;
  private readonly voteWarningCache = new Map<string, number>();
  private readonly approvalReminderCache = new Map<number, number>();

  constructor(
    private readonly deps: GovernanceMonitorDependencies,
    private readonly logger: vscode.OutputChannel,
    options?: GovernanceMonitorOptions
  ) {
    this.options = {
      checkIntervalMs: options?.checkIntervalMs ?? 30000,
      voteWarningThresholdMs: options?.voteWarningThresholdMs ?? 60000,
      voteReminderCooldownMs: options?.voteReminderCooldownMs ?? 60000,
      approvalReminderMs: options?.approvalReminderMs ?? 180000,
      approvalReminderCooldownMs: options?.approvalReminderCooldownMs ?? 300000
    };
  }

  start() {
    if (this.timer) {
      return;
    }
    this.logger.appendLine('[GovernanceMonitor] Starting governance monitor');
    this.timer = setInterval(() => this.tick(), this.options.checkIntervalMs);
    // 立即跑一次，避免等待首个间隔
    this.tick();
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.appendLine('[GovernanceMonitor] Governance monitor stopped');
    }
  }

  private tick() {
    try {
      this.checkVotes();
      this.checkApprovals();
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logger.appendLine(`[GovernanceMonitor] Tick failed: ${message}`);
    }
  }

  private checkVotes() {
    const now = Date.now();
    const pendingVotes = this.deps.vote.getAllTopics({ status: 'pending' }) || [];
    const activeVoteIds = new Set<string>();
    pendingVotes.forEach(topic => {
      activeVoteIds.add(topic.id);
      const timeLeft = topic.timeout_at - now;
      if (timeLeft <= this.options.voteWarningThresholdMs) {
        const lastWarn = this.voteWarningCache.get(topic.id) || 0;
        if (now - lastWarn >= this.options.voteReminderCooldownMs) {
          this.notifyVoteTimeout(topic, Math.max(timeLeft, 0));
          this.voteWarningCache.set(topic.id, now);
        }
      } else if (this.voteWarningCache.has(topic.id)) {
        // 恢复正常则清理记录，便于后续再次提醒
        this.voteWarningCache.delete(topic.id);
      }
    });

    // 移除已经完成的投票
    Array.from(this.voteWarningCache.keys()).forEach(id => {
      if (!activeVoteIds.has(id)) {
        this.voteWarningCache.delete(id);
      }
    });
  }

  private notifyVoteTimeout(topic: Topic, timeLeftMs: number) {
    const seconds = Math.max(Math.round(timeLeftMs / 1000), 0);
    const taskFragment = topic.task_id ? `（任务 ${topic.task_id}）` : '';
    const message = `投票「${topic.title || topic.id}」${taskFragment} 将在 ${seconds} 秒后超时，相关任务仍处于阻塞状态。`;
    this.logger.appendLine(`[GovernanceMonitor] Vote timeout warning for ${topic.id}`);
    this.deps.notification.sendNotification({
      session_id: topic.session_id,
      level: 'warning',
      title: '投票即将超时',
      message,
      metadata: {
        topic_id: topic.id,
        ...this.buildTaskMetadata(topic.task_id)
      }
    });
  }

  private checkApprovals() {
    const now = Date.now();
    const pendingApprovals = this.deps.approval.getAllApprovals({ decision: 'pending' }) || [];
    const activeApprovals = new Set<number>();
    pendingApprovals.forEach(approval => {
      activeApprovals.add(approval.id);
      const age = now - approval.created_at;
      if (age >= this.options.approvalReminderMs) {
        const lastWarn = this.approvalReminderCache.get(approval.id) || 0;
        if (now - lastWarn >= this.options.approvalReminderCooldownMs) {
          this.notifyApprovalPending(approval, age);
          this.approvalReminderCache.set(approval.id, now);
        }
      } else if (this.approvalReminderCache.has(approval.id)) {
        this.approvalReminderCache.delete(approval.id);
      }
    });

    Array.from(this.approvalReminderCache.keys()).forEach(id => {
      if (!activeApprovals.has(id)) {
        this.approvalReminderCache.delete(id);
      }
    });
  }

  private notifyApprovalPending(approval: Approval, ageMs: number) {
    const task = this.deps.task.getTask(approval.task_id);
    const sessionId = task?.session_id ?? 'default';
    const minutes = Math.max(Math.floor(ageMs / 60000), 0);
    const message = `审批 #${approval.id}（任务 ${approval.task_id}）已等待 ${minutes} 分钟，请审批人 ${approval.approver_id} 尽快处理。`;
    this.logger.appendLine(`[GovernanceMonitor] Approval reminder for ${approval.id}`);
    this.deps.notification.sendNotification({
      session_id: sessionId,
      level: 'info',
      title: '审批待处理提醒',
      message,
      metadata: {
        approval_id: approval.id,
        ...this.buildTaskMetadata(approval.task_id)
      }
    });
  }

  private buildTaskMetadata(taskId: string | null): Record<string, any> {
    const metadata: Record<string, any> = {};
    if (taskId) {
      metadata.task_id = taskId;
    }
    const task = taskId ? this.deps.task.getTask(taskId) : null;
    if (task?.session_id) {
      metadata.session_id = task.session_id;
    }
    const instanceId = this.extractWorkflowInstanceId(task);
    if (instanceId) {
      metadata.workflow_instance_id = instanceId;
    }
    return metadata;
  }

  private extractWorkflowInstanceId(task?: Task | null): string | null {
    if (!task || !Array.isArray(task.labels)) {
      return null;
    }
    const label = task.labels.find(item => typeof item === 'string' && item.startsWith('workflow_instance:'));
    return label ? label.replace('workflow_instance:', '') : null;
  }
}
