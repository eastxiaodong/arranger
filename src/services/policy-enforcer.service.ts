import type { AutomationPolicy, Task } from '../types';
import { PolicyService } from './policy.service';
import { ApprovalService } from './approval.service';
import { VoteService } from './vote.service';
import { NotificationService } from './notification.service';

interface BuiltInPolicyDefinition {
  name: string;
  type: AutomationPolicy['type'];
  scope: string;
  conditions: Record<string, any>;
  actions: Record<string, any>;
  priority: number;
  enabled?: boolean;
}

const BUILT_IN_POLICIES: BuiltInPolicyDefinition[] = [
  {
    name: '全量重构需审批',
    type: 'require_review',
    scope: 'system',
    conditions: {
      match_labels: ['full-refactor', 'refactor'],
      intent_keywords: ['重构', 'refactor']
    },
    actions: {
      approver_id: 'user',
      comment: '策略：全量重构必须完成人工审批',
      created_by: 'system'
    },
    priority: 900,
    enabled: true
  },
  {
    name: '核心模块需投票',
    type: 'require_vote',
    scope: 'system',
    conditions: {
      match_scope: ['core', 'critical'],
      intent_keywords: ['核心', 'critical']
    },
    actions: {
      vote_type: 'simple_majority',
      timeout_minutes: 15,
      required_roles: ['admin', 'reviewer'],
      description: '策略：核心模块改动需经投票确认',
      created_by: 'system'
    },
    priority: 800,
    enabled: true
  }
];

export class PolicyEnforcer {
  constructor(
    private readonly policyService: PolicyService,
    private readonly approvalService: ApprovalService,
    private readonly voteService: VoteService,
    private readonly notificationService?: NotificationService
  ) {}

  ensureBuiltInPolicies(): void {
    const existing = this.policyService.getAllPolicies({});
    BUILT_IN_POLICIES.forEach(def => {
      const matched = existing.find(policy => policy.name === def.name && policy.scope === def.scope);
      if (!matched) {
        this.policyService.createPolicy({
          name: def.name,
          type: def.type,
          scope: def.scope,
          conditions: def.conditions,
          actions: def.actions,
          priority: def.priority,
          enabled: def.enabled ?? true
        });
      }
    });
  }

  handleTaskCreated(task: Task): void {
    if (!task) {
      return;
    }
    const policies = this.policyService.getAllPolicies({ enabled: true });
    policies.forEach(policy => {
      if (this.matchesPolicy(policy, task)) {
        this.executePolicy(policy, task);
      }
    });
  }

  private matchesPolicy(policy: AutomationPolicy, task: Task): boolean {
    const conditions = policy.conditions || {};
    const labels = new Set((task.labels || []).map(label => label.toLowerCase()));

    if (Array.isArray(conditions.match_labels) && conditions.match_labels.length > 0) {
      const hasMatch = conditions.match_labels.some((label: string) => labels.has(label.toLowerCase()));
      if (!hasMatch) {
        return false;
      }
    }

    if (Array.isArray(conditions.match_scope) && conditions.match_scope.length > 0) {
      const scopeMatch = conditions.match_scope.some((scope: string) =>
        task.scope?.toLowerCase() === scope.toLowerCase()
      );
      if (!scopeMatch) {
        return false;
      }
    }

    if (Array.isArray(conditions.intent_keywords) && conditions.intent_keywords.length > 0) {
      const intent = (task.intent || task.title || '').toLowerCase();
      const keywordMatch = conditions.intent_keywords.some((keyword: string) =>
        intent.includes(keyword.toLowerCase())
      );
      if (!keywordMatch) {
        return false;
      }
    }

    return true;
  }

  private executePolicy(policy: AutomationPolicy, task: Task): void {
    if (policy.type === 'require_review') {
      this.ensureApprovalForPolicy(policy, task);
    } else if (policy.type === 'require_vote') {
      this.ensureVoteForPolicy(policy, task);
    }
  }

  private ensureApprovalForPolicy(policy: AutomationPolicy, task: Task): void {
    const marker = this.getPolicyMarker(policy);
    const approvals = this.approvalService.getApprovalsForTask(task.id);
    const alreadyExists = approvals.some(approval => approval.comment?.includes(marker));
    if (alreadyExists) {
      return;
    }

    this.approvalService.createApproval({
      session_id: task.session_id,
      task_id: task.id,
      created_by: policy.actions?.created_by || 'system',
      approver_id: policy.actions?.approver_id || 'user',
      decision: 'pending',
      comment: `${marker} ${policy.actions?.comment || '策略要求人工审批'}`
    });
    this.notifyPolicyTriggered(policy, task, '已自动发起审批');
  }

  private ensureVoteForPolicy(policy: AutomationPolicy, task: Task): void {
    const marker = this.getPolicyMarker(policy);
    const topics = this.voteService.getAllTopics({ task_id: task.id });
    const hasVote = topics.some(topic => (topic.description || '').includes(marker));
    if (hasVote) {
      return;
    }

    const now = Date.now();
    const timeoutMinutes = Number(policy.actions?.timeout_minutes ?? 15);
    this.voteService.createTopic({
      id: `policy_vote_${policy.id}_${task.id}_${now}`,
      session_id: task.session_id,
      task_id: task.id,
      title: policy.actions?.title || `任务 ${task.intent || task.id} 需要投票`,
      description: `${marker} ${policy.actions?.description || '策略要求进行投票确认'}`,
      vote_type: policy.actions?.vote_type || 'simple_majority',
      required_roles: policy.actions?.required_roles || null,
      created_by: policy.actions?.created_by || 'system',
      timeout_at: now + timeoutMinutes * 60 * 1000,
      status: 'pending',
      result: null
    });
    this.notifyPolicyTriggered(policy, task, '已自动发起投票');
  }

  private notifyPolicyTriggered(policy: AutomationPolicy, task: Task, detail: string) {
    if (!this.notificationService) {
      return;
    }
    this.notificationService.sendNotification({
      session_id: task.session_id,
      level: 'warning',
      title: `策略「${policy.name}」已触发`,
      message: `${detail}（任务 ${task.intent || task.id}）`
    });
  }

  private getPolicyMarker(policy: AutomationPolicy): string {
    return `[Policy:${policy.id}]`;
  }
}
