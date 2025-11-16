// Approval 服务

import { DatabaseManager } from '../database';
import { TypedEventEmitter } from '../events/emitter';
import type { Approval, ApprovalDecision, Task } from '../types';
import type { TaskService } from './task.service';
import type { GovernanceHistoryService } from './governance-history.service';

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter,
    private taskService?: TaskService,
    private historyService?: GovernanceHistoryService
  ) {}

  // 获取所有审批
  getAllApprovals(filters?: { session_id?: string; task_id?: string; decision?: string; approver_id?: string }): Approval[] {
    return this.db.getApprovals(filters);
  }

  // 获取单个审批
  getApproval(id: number): Approval | null {
    return this.db.getApproval(id);
  }

  // 创建审批请求
  createApproval(approval: Omit<Approval, 'id' | 'created_at'>): Approval {
    const created = this.db.createApproval(approval);
    this.blockTaskForApproval(created.task_id);
    this.logApprovalHistory(
      created.id,
      'approval_created',
      `发起审批：${approval.comment || '无说明'}`,
      {
        task_id: created.task_id,
        created_by: created.created_by,
        approver_id: created.approver_id
      },
      approval.created_by,
      created.session_id
    );
    this.events.emit('approvals_update', this.db.getApprovals({}));
    return created;
  }

  checkTimeouts(options?: { timeoutMs?: number; autoDecision?: ApprovalDecision }): void {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const autoDecision = options?.autoDecision ?? 'approved';
    const now = Date.now();
    const pending = this.db.getApprovals({ decision: 'pending' });
    const timedOut = pending.filter(item => now - item.created_at >= timeoutMs);
    if (!timedOut.length) {
      return;
    }
    timedOut.forEach(approval => {
      try {
        if (autoDecision === 'approved') {
          this.approve(approval.id, 'system_auto', '自动审批：超时默认通过');
        } else {
          this.reject(approval.id, 'system_auto', '自动审批：超时默认拒绝');
        }
      } catch (error) {
        console.warn('[ApprovalService] Failed to auto-resolve approval', approval.id, error);
      }
    });
  }

  // 批准
  approve(id: number, approverId: string, comment?: string): void {
    const existing = this.db.getApproval(id);
    this.db.updateApproval(id, {
      decision: 'approved',
      approver_id: approverId,
      comment: comment || null
    });
    if (existing) {
      this.resumeTaskFromApproval(existing.task_id);
    }
    this.logApprovalHistory(
      id,
      'approval_approved',
      `审批通过：${comment || '无备注'}`,
      {
        task_id: existing?.task_id,
        comment: comment || null
      },
      approverId,
      existing?.session_id ?? null
    );
    this.events.emit('approvals_update', this.db.getApprovals({}));
  }

  // 拒绝
  reject(id: number, approverId: string, comment?: string): void {
    const existing = this.db.getApproval(id);
    this.db.updateApproval(id, {
      decision: 'rejected',
      approver_id: approverId,
      comment: comment || null
    });
    if (existing) {
      this.failTaskFromApproval(existing.task_id, comment);
    }
    this.logApprovalHistory(
      id,
      'approval_rejected',
      `审批拒绝：${comment || '无备注'}`,
      {
        task_id: existing?.task_id,
        comment: comment || null
      },
      approverId,
      existing?.session_id ?? null
    );
    this.events.emit('approvals_update', this.db.getApprovals({}));
  }

  // 获取任务的所有审批
  getApprovalsForTask(taskId: string): Approval[] {
    return this.db.getApprovals({ task_id: taskId });
  }

  requestTaskTakeover(task: Task, options: {
    reason: string;
    requestedBy: string;
    approverId?: string;
  }): Approval | null {
    if (!task?.id || !task.session_id) {
      return null;
    }
    const pending = this.db.getApprovals({
      task_id: task.id,
      decision: 'pending'
    });
    if (pending.length > 0) {
      return pending[0];
    }
    const approval = {
      session_id: task.session_id,
      task_id: task.id,
      created_by: options.requestedBy,
      approver_id: options.approverId || 'user',
      decision: 'pending' as ApprovalDecision,
      comment: options.reason
    };
    return this.createApproval(approval);
  }

  private blockTaskForApproval(taskId: string) {
    if (!this.taskService || !taskId) {
      return;
    }
    try {
      this.taskService.updateTaskStatus(taskId, 'blocked');
    } catch (error) {
      console.warn('[ApprovalService] Failed to block task', error);
    }
  }

  private resumeTaskFromApproval(taskId: string) {
    if (!this.taskService || !taskId) {
      return;
    }
    this.taskService.releaseTaskClaim(taskId);
  }

  private failTaskFromApproval(taskId: string, reason?: string | null) {
    if (!this.taskService || !taskId) {
      return;
    }
    this.taskService.failTask(taskId, reason || '审批被拒绝');
  }

  private logApprovalHistory(
    approvalId: number,
    action: string,
    summary: string | null,
    payload?: Record<string, any> | null,
    actorId?: string | null,
    sessionId?: string | null
  ) {
    if (!this.historyService) {
      return;
    }
    let resolvedSessionId = sessionId ?? null;
    if (!resolvedSessionId) {
      const record = this.db.getApproval(approvalId);
      resolvedSessionId = record?.session_id ?? 'default';
    }
    this.historyService.recordEntry({
      session_id: resolvedSessionId,
      type: 'approval',
      entity_id: String(approvalId),
      action,
      actor_id: actorId ?? null,
      summary,
      payload: payload ?? null
    });
  }
}
