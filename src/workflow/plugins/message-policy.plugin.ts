import type { WorkflowPlugin, WorkflowPluginContext } from '../workflow-plugin';
import type {
  Agent,
  AgentRole,
  AutomationPolicy,
  BlackboardEntry,
  MessageType,
  Priority
} from '../../types';
import { extractMentionsFromContent } from '../../utils/mentions';
import {
  classifyScenarioFromText,
  getScenarioDisplayName,
  mergeScenarioValues,
  type ScenarioMatch
} from '../scenario-registry';

interface MessagePolicyDefinition {
  name: string;
  conditions: Record<string, any>;
  actions: Record<string, any>;
  priority: number;
  enabled?: boolean;
}

const BUILT_IN_MESSAGE_POLICIES: MessagePolicyDefinition[] = [
  {
    name: 'message-discussion-note · 讨论记录',
    priority: 610,
    conditions: {
      message_types: ['discussion']
    },
    actions: {
      notify: {
        level: 'info',
        title: '讨论已记录',
        message_template: '讨论：${snippet}'
      }
    },
    enabled: true
  },
  {
    name: 'message-question-routing · 问题处理',
    priority: 700,
    conditions: {
      message_types: ['question']
    },
    actions: {
      create_task: {
        title_prefix: '问题处理',
        intent: 'answer_question',
        scope: 'workspace',
        priority: 'high',
        assign_role: 'coordinator',
        labels: ['message-question']
      }
    },
    enabled: true
  },
  {
    name: 'message-requirement-router · 需求认领',
    priority: 880,
    conditions: {
      message_types: ['requirement']
    },
    actions: {
      notify: {
        level: 'info',
        title: '需求已接收',
        message_template: '需求将由需求协调器自动认领：${snippet}'
      },
      mark_requirement: true
    },
    enabled: true
  },
  {
    name: 'message-suggestion-routing · 建议评估',
    priority: 650,
    conditions: {
      message_types: ['suggestion']
    },
    actions: {
      create_task: {
        title_prefix: '建议评估',
        intent: 'evaluate_suggestion',
        scope: 'workspace',
        priority: 'medium',
        assign_role: 'analyzer',
        labels: ['message-suggestion']
      }
    },
    enabled: true
  },
  {
    name: 'message-warning-notification · 告警响应',
    priority: 640,
    conditions: {
      message_types: ['warning'],
      require_user: true
    },
    actions: {
      notify: {
        level: 'warning',
        title: '收到告警',
        message_template: '告警：${snippet}'
      },
      create_task: {
        title_prefix: '告警处理',
        intent: 'handle_warning',
        priority: 'high',
        assign_role: 'security',
        labels: ['message-warning']
      }
    },
    enabled: true
  },
  {
    name: 'message-decision-log · 决策记录',
    priority: 630,
    conditions: {
      message_types: ['decision']
    },
    actions: {
      notify: {
        level: 'info',
        title: '决策已记录',
        message_template: '决策更新：${snippet}'
      }
    },
    enabled: true
  },
  {
    name: 'message-mention-interrupt · 指令打断',
    priority: 900,
    conditions: {
      require_mentions: true,
      require_user: true
    },
    actions: {
      interrupt_mentions: true,
      create_task: {
        title_prefix: '指令',
        intent: 'respond_to_command',
        priority: 'high',
        assign_to_mentions: true,
        labels: ['message-mention']
      }
    },
    enabled: true
  },
  {
    name: 'message-bug-routing · 缺陷修复',
    priority: 840,
    conditions: {
      require_user: true,
      require_tags: ['scenario:bug_fix']
    },
    actions: {
      notify: {
        level: 'warning',
        title: '检测到缺陷反馈',
        message_template: '缺陷：${snippet}'
      },
      create_task: {
        title_prefix: '缺陷修复',
        intent: 'fix_bug',
        priority: 'high',
        assign_role: 'developer',
        labels: ['scenario:bug_fix']
      }
    },
    enabled: true
  },
  {
    name: 'message-test-request · 测试执行',
    priority: 780,
    conditions: {
      require_user: true,
      require_tags: ['scenario:test_request']
    },
    actions: {
      notify: {
        level: 'info',
        title: '测试请求已登记',
        message_template: '测试范围：${snippet}'
      },
      create_task: {
        title_prefix: '测试执行',
        intent: 'run_tests',
        priority: 'medium',
        assign_role: 'tester',
        labels: ['scenario:test_request']
      }
    },
    enabled: true
  },
  {
    name: 'message-optimization-plan · 优化建议',
    priority: 730,
    conditions: {
      require_user: true,
      require_tags: ['scenario:optimization']
    },
    actions: {
      notify: {
        level: 'info',
        title: '性能/优化需求',
        message_template: '优化目标：${snippet}'
      },
      create_task: {
        title_prefix: '优化方案',
        intent: 'plan_optimization',
        priority: 'medium',
        assign_role: 'analyzer',
        labels: ['scenario:optimization']
      }
    },
    enabled: true
  },
  {
    name: 'message-refactor-routing · 重构评估',
    priority: 820,
    conditions: {
      require_user: true,
      require_tags: ['scenario:refactor']
    },
    actions: {
      notify: {
        level: 'info',
        title: '重构提案已记录',
        message_template: '提案概要：${snippet}'
      },
      create_task: {
        title_prefix: '重构评估',
        intent: 'evaluate_refactor',
        priority: 'high',
        assign_role: 'coordinator',
        labels: ['scenario:refactor']
      }
    },
    enabled: true
  }
];


export class MessagePolicyWorkflowPlugin implements WorkflowPlugin {
  readonly id = 'message-policy-plugin';
  description = 'Evaluates blackboard messages through policy engine and spawns tasks/notifications.';

  private context: WorkflowPluginContext | null = null;
  private messageListener: ((messages: BlackboardEntry[]) => void) | null = null;
  private handledMessageIds = new Set<string>();

  start(context: WorkflowPluginContext) {
    this.context = context;
    this.ensureBuiltInPolicies();
    this.bootstrapHandledMessages();
    this.messageListener = (messages) => this.handleMessages(messages);
    context.events.on('messages_update', this.messageListener);
  }

  dispose() {
    if (this.context && this.messageListener) {
      this.context.events.off('messages_update', this.messageListener);
    }
    this.context = null;
    this.messageListener = null;
    this.handledMessageIds.clear();
  }

  private bootstrapHandledMessages() {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    const existing = ctx.services.message.getAllMessages({});
    existing.forEach(message => this.handledMessageIds.add(message.id));
  }

  private ensureBuiltInPolicies() {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    const policyService = ctx.services.policy;
    const existing = policyService.getAllPolicies({ enabled: undefined });
    BUILT_IN_MESSAGE_POLICIES.forEach(def => {
      const matched = existing.find(policy => policy.name === def.name && policy.type === 'message_router');
      if (!matched) {
        policyService.createPolicy({
          name: def.name,
          type: 'message_router',
          scope: 'global',
          conditions: def.conditions,
          actions: def.actions,
          priority: def.priority,
          enabled: def.enabled ?? true
        });
        return;
      }

      const nextConditions = { ...(matched.conditions || {}) };
      let needsUpdate = false;
      if (def.conditions?.require_user !== undefined && nextConditions.require_user !== def.conditions.require_user) {
        nextConditions.require_user = def.conditions.require_user;
        needsUpdate = true;
      }
      if (needsUpdate) {
        policyService.updatePolicy(matched.id, {
          conditions: nextConditions
        });
      }
    });
  }

  private handleMessages(messages: BlackboardEntry[]) {
    const ctx = this.context;
    if (!ctx || !messages || messages.length === 0) {
      return;
    }
    const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);
    sorted.forEach(message => {
      if (this.handledMessageIds.has(message.id)) {
        return;
      }
      this.handledMessageIds.add(message.id);
      this.processMessage(ctx, message);
    });
  }

  private processMessage(ctx: WorkflowPluginContext, message: BlackboardEntry) {
    try {
      const enriched = this.ensureScenarioMetadata(ctx, message);
      const normalized = this.normalizeMessage(enriched);
      const policies = ctx.services.policy.getAllPolicies({ enabled: true })
        .filter(policy => policy.type === 'message_router')
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      policies.forEach(policy => {
        if (this.matchesMessagePolicy(policy, normalized)) {
          this.executePolicy(ctx, policy, normalized);
        }
      });
    } catch (error: any) {
      ctx.output.appendLine(`[Workflow][plugin:message-policy] Failed to process message ${message.id}: ${error?.message ?? error}`);
    }
  }

  private matchesMessagePolicy(policy: AutomationPolicy, message: BlackboardEntry): boolean {
    const conditions = policy.conditions || {};
    const isUserMessage = this.isHumanMessage(message);
    if (conditions.require_user && !isUserMessage) {
      return false;
    }
    const type = message.message_type;
    if (Array.isArray(conditions.message_types) && conditions.message_types.length > 0) {
      if (!conditions.message_types.includes(type)) {
        return false;
      }
    }
    if (Array.isArray(conditions.exclude_types) && conditions.exclude_types.length > 0) {
      if (conditions.exclude_types.includes(type)) {
        return false;
      }
    }
    if (conditions.require_mentions) {
      const mentions = this.getMentions(message);
      if (!mentions.length) {
        return false;
      }
    }
    if (Array.isArray(conditions.keywords) && conditions.keywords.length > 0) {
      const lowerContent = (message.content || '').toLowerCase();
      const keywordMatch = conditions.keywords.some((keyword: string) =>
        lowerContent.includes(String(keyword).toLowerCase())
      );
      if (!keywordMatch) {
        return false;
      }
    }
    if (Array.isArray(conditions.require_tags) && conditions.require_tags.length > 0) {
      const tags = message.tags || [];
      const matched = conditions.require_tags.every((tag: string) => tags.includes(tag));
      if (!matched) {
        return false;
      }
    }
    if (Array.isArray(conditions.exclude_tags) && conditions.exclude_tags.length > 0) {
      const tags = message.tags || [];
      if (conditions.exclude_tags.some((tag: string) => tags.includes(tag))) {
        return false;
      }
    }
    if (conditions.priority) {
      if (message.priority !== conditions.priority) {
        return false;
      }
    }
    return true;
  }

  private executePolicy(ctx: WorkflowPluginContext, policy: AutomationPolicy, message: BlackboardEntry) {
    const actions = policy.actions || {};
    if (actions.interrupt_mentions) {
      this.handleMentions(ctx, message);
    }
    if (actions.create_task) {
      this.createTasksFromPolicy(ctx, policy, message, actions.create_task);
    }
    if (actions.notify) {
      this.sendNotificationFromPolicy(ctx, message, actions.notify);
    }
    if (actions.mark_requirement) {
      this.markRequirementMessage(ctx, message);
    }
  }

  private handleMentions(ctx: WorkflowPluginContext, message: BlackboardEntry) {
    if (!this.isHumanMessage(message)) {
      ctx.output.appendLine('[Workflow][plugin:message-policy] Skip mention interrupt for non-user message.');
      return;
    }
    if (message.message_type === 'requirement') {
      ctx.output.appendLine('[Workflow][plugin:message-policy] Requirement mentions handled by workflow bootstrap, skipping auto-interrupt.');
      return;
    }
    const mentions = this.getMentions(message);
    mentions.forEach(mentionId => {
      const agent = ctx.services.agent.getAgent(mentionId);
      if (!agent) {
        ctx.services.notification?.sendNotification({
          session_id: message.session_id,
          level: 'warning',
          title: '未找到对应 Agent',
          message: `@${mentionId} 不存在或已被删除`
        });
        return;
      }
      if (agent.is_enabled === false) {
        ctx.output.appendLine(`[Workflow][plugin:message-policy] Skip mention ${mentionId} because agent is disabled`);
        ctx.services.notification?.sendNotification({
          session_id: message.session_id,
          level: 'warning',
          title: 'Agent 已停用',
          message: `${agent.display_name || agent.id} 当前未启用，无法响应 @ 指令`
        });
        return;
      }
      this.interruptAgentForMessage(ctx, agent, message);
    });
  }

  private interruptAgentForMessage(ctx: WorkflowPluginContext, agent: Agent, message: BlackboardEntry) {
    try {
      const tasks = ctx.services.task.getAllTasks({ assigned_to: agent.id });
      const activeTask = tasks.find(task =>
        ['running', 'assigned', 'pending'].includes(task.status)
      );
      if (activeTask) {
        try {
          ctx.services.task.pauseTask(activeTask.id);
        } catch (error: any) {
          ctx.output.appendLine(`[Workflow][plugin:message-policy] Pause task ${activeTask.id} failed: ${error?.message ?? error}`);
        }
      }

      const mentionLabel = `mention:${message.id}:${agent.id}`;
      const created = ctx.services.task.createTaskOnceByLabel(mentionLabel, {
        id: `task-mention-${message.id}-${agent.id}`,
        session_id: message.session_id,
        title: `处理 @${agent.display_name || agent.id} 的指令`,
        intent: 'respond_to_mention',
        description: `来自 ${message.agent_id} 的指令：\n${message.content}`,
        scope: 'workspace',
        priority: 'high',
        labels: ['mention', mentionLabel],
        due_at: null,
        status: 'assigned',
        assigned_to: agent.id,
        parent_task_id: null,
        dependencies: []
      });
      if (created) {
        ctx.services.notification?.sendNotification({
          session_id: message.session_id,
          level: 'info',
          title: `@${agent.display_name || agent.id}`,
          message: `已创建指令任务以响应 ${this.shortContent(message.content)}`
        });
      }
    } catch (error: any) {
      ctx.output.appendLine(`[Workflow][plugin:message-policy] Interrupt agent ${agent.id} failed: ${error?.message ?? error}`);
    }
  }

  private createTasksFromPolicy(
    ctx: WorkflowPluginContext,
    policy: AutomationPolicy,
    message: BlackboardEntry,
    config: Record<string, any>
  ) {
    const mentions = this.getMentions(message);
    const assignToMentions: boolean = !!config.assign_to_mentions;
    if (assignToMentions && mentions.length > 0) {
      mentions.forEach(mentionId => {
        this.createSingleTaskFromPolicy(ctx, policy, message, config, mentionId);
      });
      return;
    }
    this.createSingleTaskFromPolicy(ctx, policy, message, config, undefined);
  }

  private createSingleTaskFromPolicy(
    ctx: WorkflowPluginContext,
    policy: AutomationPolicy,
    message: BlackboardEntry,
    config: Record<string, any>,
    mentionAgentId?: string
  ) {
    try {
      const titlePrefix = config.title_prefix || '消息处理';
      const snippet = this.shortContent(message.content);
      const title = config.title_template
        ? this.applyTemplate(config.title_template, message, snippet, mentionAgentId)
        : `${titlePrefix}: ${snippet}`;
      const intent = config.intent || `handle_${message.message_type}`;
      const labels = new Set<string>(Array.isArray(config.labels) ? config.labels : []);
      labels.add(`message:${message.id}`);
      if (mentionAgentId) {
        labels.add(`mention:${mentionAgentId}`);
      }
      const mentionAssignee = this.resolveEnabledAgentId(ctx, mentionAgentId);
      const explicitAssignee = this.resolveEnabledAgentId(ctx, config.assign_agent_id);
      const assignedTo =
        mentionAssignee ||
        explicitAssignee ||
        (config.assign_role ? this.pickAgentByRole(ctx, config.assign_role) : null);

      const uniqueLabel = `message_policy:${policy.id}:${message.id}${mentionAgentId ? ':' + mentionAgentId : ''}`;
      const created = ctx.services.task.createTaskOnceByLabel(uniqueLabel, {
        id: `task-msg-${policy.id}-${message.id}-${mentionAgentId ?? 'auto'}`,
        session_id: message.session_id,
        title,
        intent,
        description: message.content,
        scope: config.scope || 'workspace',
        priority: config.priority || (message.priority as Priority) || 'medium',
        labels: Array.from(labels),
        due_at: null,
        status: assignedTo ? 'assigned' : 'pending',
        assigned_to: assignedTo,
        parent_task_id: null,
        dependencies: []
      });

      if (created) {
        ctx.services.notification?.sendNotification({
          session_id: message.session_id,
          level: 'info',
          title: '消息已转为任务',
          message: `${title}（策略：${policy.name}）`
        });
      }
    } catch (error: any) {
      ctx.output.appendLine(`[Workflow][plugin:message-policy] Create task from policy ${policy.name} failed: ${error?.message ?? error}`);
    }
  }

  private sendNotificationFromPolicy(
    ctx: WorkflowPluginContext,
    message: BlackboardEntry,
    config: Record<string, any>
  ) {
    if (!ctx.services.notification) {
      return;
    }
    const snippet = this.shortContent(message.content);
    ctx.services.notification.sendNotification({
      session_id: message.session_id,
      level: config.level || 'info',
      title: this.applyTemplate(config.title || '消息通知', message, snippet),
      message: this.applyTemplate(config.message_template || snippet, message, snippet)
    });
  }

  private markRequirementMessage(ctx: WorkflowPluginContext, message: BlackboardEntry) {
    ctx.output.appendLine(`[Workflow][plugin:message-policy] Requirement message ${message.id} routed to workflow orchestrator.`);
  }

  private getMentions(message: BlackboardEntry): string[] {
    if (message.mentions && message.mentions.length > 0) {
      return message.mentions;
    }
    return extractMentionsFromContent(message.content);
  }

  private ensureScenarioMetadata(ctx: WorkflowPluginContext, message: BlackboardEntry): BlackboardEntry {
    if (!this.isHumanMessage(message)) {
      return message;
    }
    const classification = classifyScenarioFromText(message.content || '');
    if (!classification) {
      return message;
    }
    const mergedTags = this.mergeTags(message.tags, classification.tags);
    const payload = {
      ...(message.payload || {}),
      scenario: classification.scenarioId,
      scenario_confidence: classification.confidence,
      scenario_source: 'message-policy'
    };
    if (message.session_id) {
      this.updateSessionScenarioMetadata(ctx, message.session_id, classification);
    }
    const updates: Partial<Pick<BlackboardEntry, 'message_type' | 'tags' | 'payload'>> = {};
    if (classification.messageType && classification.messageType !== message.message_type) {
      updates.message_type = classification.messageType;
    }
    if (!this.sameTags(message.tags, mergedTags)) {
      updates.tags = mergedTags;
    }
    if (!this.samePayload(message.payload, payload)) {
      updates.payload = payload;
    }
    if (Object.keys(updates).length > 0) {
      const updated = ctx.services.message.updateMessage(message.id, updates);
      if (updated) {
        return updated;
      }
      return {
        ...message,
        ...updates
      };
    }
    return {
      ...message,
      tags: mergedTags,
      payload
    };
  }

  private updateSessionScenarioMetadata(ctx: WorkflowPluginContext, sessionId: string, classification: ScenarioMatch) {
    const service = ctx.services.session;
    const existing = service.getSession(sessionId);
    const nextScenarios = mergeScenarioValues(existing?.metadata?.scenario, classification.scenarioId);
    service.mergeMetadata(sessionId, {
      scenario: nextScenarios,
      scenario_source: 'message-policy',
      scenario_confidence: classification.confidence,
      scenario_display: getScenarioDisplayName(classification.scenarioId),
      scenario_updated_at: Date.now()
    });
  }

  private mergeTags(existing: string[] | null, additions: string[]): string[] | null {
    const next = new Set<string>((existing || []).filter(Boolean));
    additions.filter(Boolean).forEach(tag => next.add(tag));
    return next.size > 0 ? Array.from(next) : null;
  }

  private sameTags(a: string[] | null, b: string[] | null): boolean {
    if (!a && !b) {
      return true;
    }
    if (!a || !b) {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((value, index) => value === sortedB[index]);
  }

  private samePayload(
    a: Record<string, any> | null | undefined,
    b: Record<string, any> | null | undefined
  ): boolean {
    const normalizedA = a ? JSON.stringify(a) : '';
    const normalizedB = b ? JSON.stringify(b) : '';
    return normalizedA === normalizedB;
  }

  private resolveEnabledAgentId(ctx: WorkflowPluginContext, agentId?: string | null): string | null {
    if (!agentId) {
      return null;
    }
    const agent = ctx.services.agent.getAgent(agentId);
    if (!agent || agent.is_enabled === false) {
      return null;
    }
    return agent.id;
  }

  private pickAgentByRole(ctx: WorkflowPluginContext, role: AgentRole): string | null {
    const candidates = ctx.services.agent.getAgentsByRole(role);
    if (!candidates || candidates.length === 0) {
      return null;
    }
    const tasks = ctx.services.task.getAllTasks({});
    const loadMap = new Map<string, number>();
    tasks.forEach(task => {
      if (task.assigned_to && ['pending', 'assigned', 'running', 'blocked'].includes(task.status)) {
        loadMap.set(task.assigned_to, (loadMap.get(task.assigned_to) || 0) + 1);
      }
    });
    const sorted = [...candidates].sort((a, b) => {
      const loadDiff = (loadMap.get(a.id) || 0) - (loadMap.get(b.id) || 0);
      if (loadDiff !== 0) {
        return loadDiff;
      }
      return (a.status_updated_at || 0) - (b.status_updated_at || 0);
    });
    return sorted[0]?.id ?? null;
  }

  private applyTemplate(template: string, message: BlackboardEntry, snippet: string, mentionAgentId?: string | null) {
    return String(template)
      .replace(/\$\{snippet\}/g, snippet)
      .replace(/\$\{type\}/g, message.message_type)
      .replace(/\$\{agent\}/g, mentionAgentId ?? '')
      .replace(/\$\{session\}/g, message.session_id);
  }

  private shortContent(content: string, length = 60): string {
    if (!content) {
      return '';
    }
    const trimmed = content.trim();
    return trimmed.length > length ? `${trimmed.slice(0, length)}...` : trimmed;
  }

  private isHumanMessage(message: BlackboardEntry) {
    const agentId = (message.agent_id || '').toLowerCase();
    return agentId === '' || agentId === 'user' || agentId.startsWith('human');
  }

  private normalizeMessage(message: BlackboardEntry): BlackboardEntry {
    const resolvedType = this.getEffectiveMessageType(message);
    if (resolvedType === message.message_type) {
      return message;
    }
    const normalized: BlackboardEntry = {
      ...message,
      message_type: resolvedType
    };
    this.context?.output.appendLine(
      `[Workflow][plugin:message-policy] Auto classified message ${message.id} as ${resolvedType} (original: ${message.message_type}).`
    );
    return normalized;
  }

  private getEffectiveMessageType(message: BlackboardEntry): MessageType {
    const known = message.message_type as string;
    if (known === 'fact') {
      return 'discussion';
    }
    if (known && known !== 'discussion') {
      return known as MessageType;
    }
    return this.guessMessageTypeFromContent(message.content);
  }

  private guessMessageTypeFromContent(content: string): MessageType {
    const text = (content || '').toLowerCase();
    if (/需求|requirement|feature|story|实现/i.test(text)) {
      return 'requirement';
    }
    if (/bug|缺陷|错误|error|exception|修复|fix|crash/i.test(text)) {
      return 'warning';
    }
    if (/建议|建议书|idea|优化|improve/i.test(text)) {
      return 'suggestion';
    }
    if (/[?？]\s*$/.test(text) || /^why|^how|^what|^是否/i.test(text)) {
      return 'question';
    }
    if (/决策|决定|批准|审批|approve|reject|同意|不同意/i.test(text)) {
      return 'decision';
    }
    return 'discussion';
  }
}
