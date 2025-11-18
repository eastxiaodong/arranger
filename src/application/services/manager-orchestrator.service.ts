import type { OutputChannel } from 'vscode';
import type { BlackboardEntry } from '../../core/types';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { ManagerLLMService } from './manager-llm.service';
import type { MessageService } from '../../domain/communication/message.service';
import type { AssistService } from '../../domain/assist/assist.service';
import type { NotificationService } from '../../domain/communication/notification.service';
import type { TaskService } from '../../domain/task/task.service';
import type { ToolExecutionService } from '../../domain/execution/tool-execution.service';
import type { StateStore } from '../../domain/state';
import { createLLMClient, type LLMProvider } from '../../infrastructure/llm';
import type { BaseLLMClient, LLMMessage } from '../../infrastructure/llm/base';
import type { AutomationService } from './automation.service';
import type { AgentService } from '../../domain/agent/agent.service';

interface ManagerOrchestratorOptions {
  managerLLM: ManagerLLMService;
  messageService: MessageService;
  assistService: AssistService;
  taskService: TaskService;
  toolService: ToolExecutionService;
  automationService?: AutomationService;
  notificationService?: NotificationService;
  state: StateStore;
  events: TypedEventEmitter;
  output: OutputChannel;
  agentService: AgentService;
}

interface ManagerIntent {
  sessionId: string;
  messageId: string;
  content: string;
  replyTo?: string | null;
  mentions: string[];
  reference?: {
    type: string | null;
    id: string | null;
  };
  priority: 'high' | 'normal' | 'low';
  timestamp: number;
  flags: {
    hasCodeBlock: boolean;
    hasCommandLike: boolean;
  };
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are the team manager inside Arranger.',
  'Read every user message, understand intent, update plans, assign agents, and summarize progress.',
  'Always respond in Chinese, keep outputs concise but actionable.',
  'When the user mentions specific agents or replies to earlier items, respect that context.'
].join(' ');

export class ManagerOrchestratorService {
  private readonly queue: BlackboardEntry[] = [];
  private processing = false;
   // 每个会话的节流时间戳，避免刷屏
  private readonly sessionThrottle = new Map<string, number>();
  private readonly minDispatchIntervalMs = 2000;
  private resolveAssignee(agentId?: string | null): string | null {
    if (!agentId) {
      return null;
    }
    const agent = this.options.agentService.getAgent(agentId);
    const hasLLM = !!agent?.llm_provider && !!agent.llm_model && !!agent.llm_api_key;
    if (!agent || agent.is_enabled === false || agent.status === 'offline' || !hasLLM) {
      this.options.output.appendLine(`[ManagerOrchestrator] 忽略无效指派，Agent 不存在/已停用/离线/无LLM配置：${agentId}`);
      return null;
    }
    return agent.id;
  }

  private readonly handleMessage = (entry: BlackboardEntry) => {
    if (!this.shouldDispatch(entry)) {
      return;
    }
    this.queue.push(entry);
    if (!this.processing) {
      void this.drainQueue();
    }
  };

  constructor(private readonly options: ManagerOrchestratorOptions) {
    this.options.events.on('message_posted', this.handleMessage);
  }

  dispose() {
    this.options.events.off('message_posted', this.handleMessage);
  }

  private shouldDispatch(entry: BlackboardEntry | null | undefined): entry is BlackboardEntry {
    return Boolean(
      entry &&
        entry.session_id &&
        entry.category === 'user' &&
        entry.visibility === 'blackboard'
    );
  }

  private async drainQueue() {
    this.processing = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) {
        continue;
      }
      try {
        await this.handleUserMessage(entry);
      } catch (error: any) {
        this.options.output.appendLine(
          `[ManagerOrchestrator] Failed to process message ${entry.id}: ${error?.message ?? error}`
        );
      }
    }
    this.processing = false;
  }

  private async handleUserMessage(entry: BlackboardEntry) {
    if (this.isThrottled(entry.session_id)) {
      this.options.output.appendLine(`[ManagerOrchestrator] 忽略过于频繁的消息 ${entry.id}`);
      return;
    }
    this.markDispatched(entry.session_id);

    const targetAgentId = Array.isArray(entry.mentions) && entry.mentions.length === 1
      ? entry.mentions[0]
      : null;
    if (targetAgentId && targetAgentId !== 'manager_llm' && targetAgentId !== 'workflow_orchestrator') {
      await this.handleDirectAgentReply(entry, targetAgentId);
      return;
    }

    const config = this.options.managerLLM.getConfig();
    if (!config?.api_key || !config.model) {
      this.options.output.appendLine('[ManagerOrchestrator] Manager LLM 未配置，忽略用户消息');
      return;
    }

    const intent = this.buildIntent(entry);
    const client = this.createClient(config);
    const systemPrompt = this.buildSystemPrompt(config.system_prompt);
    const userPrompt = this.buildUserPrompt(intent);

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const streamMessageId = `manager_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let managerReply = '';
    let decision: ManagerDecision | null = null;
    let lastError: string | null = null;
    this.pushManagerNotification('info', '经理开始处理', `消息 ${entry.id} 正在分析`, {
      message_id: entry.id,
      session_id: entry.session_id
    });
    const streamingMessage = this.options.messageService.sendMessage({
      id: streamMessageId,
      session_id: entry.session_id,
      agent_id: 'manager_llm',
      content: '经理正在处理…',
      priority: 'medium',
      tags: ['manager', 'summary'],
      reply_to: entry.id,
      references: entry.references,
      reference_type: entry.reference_type,
      reference_id: entry.reference_id,
      mentions: null,
      expires_at: null,
      category: 'system_event',
      visibility: 'blackboard',
      payload: {
        source_message_id: entry.id,
        status: 'streaming'
      }
    });

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const stream = client.stream(messages, undefined, {
          systemPrompt,
          maxTokens: config.max_output_tokens,
          temperature: config.temperature
        });
        for await (const chunk of stream) {
          if (chunk.type === 'content' && chunk.content) {
            managerReply += chunk.content;
            this.options.messageService.updateMessage(streamingMessage.id, {
              content: managerReply,
              payload: { ...(streamingMessage.payload || {}), status: 'streaming', attempt }
            });
          }
          if (chunk.type === 'error') {
            throw new Error(chunk.error || 'LLM 流式错误');
          }
          if (chunk.type === 'done' && chunk.response?.content) {
            // 确保捕捉最终响应（有些客户端将完整内容放在 done 中）
            if (!managerReply.includes(chunk.response.content)) {
              managerReply += chunk.response.content;
            }
          }
        }
        managerReply = managerReply.trim();
        decision = this.tryParseDecision(managerReply);
        if (!decision) {
          this.options.output.appendLine('[ManagerOrchestrator] 模型未返回有效决策，触发兜底任务创建');
          this.createFallbackTask(intent);
          this.pushManagerNotification('warning', '经理决策缺失', `模型未返回结构化结果，已创建兜底任务`, {
            message_id: entry.id,
            session_id: entry.session_id,
            attempt
          });
        }
        lastError = null;
        break;
      } catch (error: any) {
        const errMsg = error?.message ?? String(error);
        lastError = errMsg;
        this.options.output.appendLine(`[ManagerOrchestrator] LLM 调用失败（尝试 ${attempt}/${maxAttempts}）：${errMsg}`);
        this.pushManagerNotification('error', '经理调用失败', `尝试 ${attempt}/${maxAttempts}：${errMsg}`, {
          message_id: entry.id,
          session_id: entry.session_id,
          attempt
        });
        managerReply = `⚠️ 经理模型调用失败（尝试 ${attempt}/${maxAttempts}）：${errMsg}`;
        if (attempt < maxAttempts) {
          continue;
        }
      }
    }

    if (!managerReply) {
      managerReply = '（经理未返回任何内容）';
    }

    this.options.messageService.updateMessage(streamingMessage.id, {
      content: managerReply,
      payload: {
        ...(streamingMessage.payload || {}),
        status: decision ? 'completed' : 'fallback',
        last_error: lastError,
        source_message_id: entry.id
      }
    });

    if (decision) {
      void this.applyDecision(entry.session_id, decision, intent);
      this.pushManagerNotification('success', '经理决策完成', `已生成决策并写入任务/协助`, {
        message_id: entry.id,
        session_id: entry.session_id
      });
    }
  }

  /**
   * 当模型未输出结构化结果时，创建兜底任务，确保主线可用。
   */
  private createFallbackTask(intent: ManagerIntent) {
    const title = this.truncate(intent.content || '新任务', 48);
    const description = intent.content || '用户请求';
    const { difficultyLabel, priority } = this.estimateDifficulty(title, description, intent.flags.hasCommandLike);
    try {
      const created = this.options.taskService.createTask({
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        session_id: intent.sessionId,
        title,
        intent: description,
        description,
        scope: 'workspace',
        priority,
        labels: this.buildTaskLabels(intent.reference?.id, difficultyLabel),
        due_at: null,
        status: 'pending',
        assigned_to: null,
        parent_task_id: null,
        dependencies: null,
        result_summary: null,
        result_details: null,
        result_artifacts: null,
        run_after: null,
        retry_count: 0,
        max_retries: null,
        timeout_seconds: null,
        last_started_at: null,
        metadata: this.buildTaskMetadata(intent, difficultyLabel, 'manager_llm_fallback')
      });
      this.options.messageService.sendMessage({
        id: `mgr_task_${created.id}`,
        session_id: intent.sessionId,
        agent_id: 'manager_llm',
        content: `已创建任务「${title}」${created.assigned_to ? `，指派给 ${created.assigned_to}` : ''}。难度：${difficultyLabel?.replace('difficulty:', '') || '中'}`,
        priority,
        tags: ['manager', `task:${created.id}`],
        reply_to: intent.messageId,
        references: [created.id],
        reference_type: 'task',
        reference_id: created.id,
        mentions: created.assigned_to ? [created.assigned_to] : null,
        expires_at: null,
        category: 'system_event',
        visibility: 'blackboard',
        payload: {
          task_id: created.id,
          assigned_to: created.assigned_to,
          difficulty: difficultyLabel?.replace('difficulty:', '') || 'medium'
        }
      });
      if (this.options.notificationService) {
        this.options.notificationService.sendNotification({
          session_id: intent.sessionId,
          level: 'info',
          title: '经理创建任务',
          message: `任务「${title}」${created.assigned_to ? `指派给 ${created.assigned_to}` : '等待指派'}，优先级 ${priority}`,
          metadata: {
            task_id: created.id,
            assigned_to: created.assigned_to,
            difficulty: difficultyLabel?.replace('difficulty:', '') || 'medium'
          }
        });
      }
      this.options.output.appendLine('[ManagerOrchestrator] 已创建兜底任务：' + title);
    } catch (error: any) {
      this.options.output.appendLine(`[ManagerOrchestrator] 兜底任务创建失败：${error?.message ?? error}`);
    }
  }

  private truncate(text: string, maxLen: number): string {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return text || '';
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  }

  private estimateDifficulty(title?: string | null, description?: string | null, forceHigh?: boolean) {
    if (forceHigh) {
      return { difficultyLabel: 'difficulty:high', priority: 'high' as const };
    }
    const text = `${title || ''} ${description || ''}`.toLowerCase();
    const has = (keywords: string[]) => keywords.some(k => text.includes(k));
    if (has(['架构', '重构', '设计', '性能', '并发', '安全', '集成', '复杂', 'multiple', '优化'])) {
      return { difficultyLabel: 'difficulty:high', priority: 'high' as const };
    }
    if (has(['修复', 'bug', '小改', 'minor', '排查', '诊断'])) {
      return { difficultyLabel: 'difficulty:low', priority: 'low' as const };
    }
    return { difficultyLabel: 'difficulty:medium', priority: 'medium' as const };
  }

  private buildTaskLabels(referenceId?: string | null, difficultyLabel?: string | null) {
    const labels: string[] = [];
    if (referenceId) {
      labels.push(`reference:${referenceId}`);
    }
    if (difficultyLabel) {
      labels.push(difficultyLabel);
    }
    return labels.length ? labels : null;
  }

  private buildTaskMetadata(intent: ManagerIntent, difficultyLabel?: string | null, source: string = 'manager_llm') {
    const metadata: Record<string, any> = {
      source,
      from_message: intent.messageId
    };
    const typeMeta = this.classifyTaskType(intent.content);
    if (typeMeta) {
      metadata.type = typeMeta.replace('type:', '');
    }
    if (difficultyLabel) {
      metadata.difficulty = difficultyLabel.replace('difficulty:', '');
    }
    return metadata;
  }
  private classifyTaskType(content?: string | null): string | null {
    if (!content) return null;
    const text = content.toLowerCase();
    const has = (arr: string[]) => arr.some(k => text.includes(k));
    if (has(['bug', 'fix', '异常', '报错', '错误'])) return 'type:bug';
    if (has(['文档', 'doc', '说明', 'wiki', '指南'])) return 'type:doc';
    if (has(['需求', '功能', 'feature', 'story'])) return 'type:feature';
    if (has(['优化', '重构', 'refactor', '性能'])) return 'type:improve';
    return 'type:misc';
  }

  private mergeLabels(base: string[] | null, extra: string[]): string[] | null {
    const set = new Set<string>();
    (base || []).forEach(l => set.add(l));
    (extra || []).forEach(l => set.add(l));
    const labels = Array.from(set);
    return labels.length ? labels : null;
  }

  private pushManagerNotification(level: 'info' | 'warning' | 'error' | 'success', title: string, message: string, metadata?: Record<string, any>) {
    if (!this.options.notificationService) {
      return;
    }
    this.options.notificationService.sendNotification({
      session_id: metadata?.session_id || null,
      level,
      title,
      message,
      metadata: metadata || {}
    });
  }

  private isThrottled(sessionId: string): boolean {
    const now = Date.now();
    const last = this.sessionThrottle.get(sessionId) ?? 0;
    return now - last < this.minDispatchIntervalMs;
  }

  private markDispatched(sessionId: string): void {
    this.sessionThrottle.set(sessionId, Date.now());
  }

  private buildIntent(entry: BlackboardEntry): ManagerIntent {
    const content = entry.content || '';
    const hasCodeBlock = content.includes('```');
    const hasCommandLike = /\b(git\s+|rm\s+-|chmod\s+)/i.test(content);
    const mentions = Array.isArray(entry.mentions) ? entry.mentions.filter(Boolean) : [];
    const priority: ManagerIntent['priority'] = hasCommandLike ? 'high' : 'normal';
    return {
      sessionId: entry.session_id,
      messageId: entry.id,
      content,
      replyTo: entry.reply_to ?? null,
      mentions,
      reference: entry.reference_type || entry.reference_id ? {
        type: entry.reference_type ?? null,
        id: entry.reference_id ?? null
      } : undefined,
      priority,
      timestamp: entry.created_at ?? Date.now(),
      flags: {
        hasCodeBlock,
        hasCommandLike
      }
    };
  }

  private createClient(config: ReturnType<ManagerLLMService['getConfig']>): BaseLLMClient {
    const provider = (config.provider || 'claude') as LLMProvider;
    return createLLMClient({
      provider,
      apiKey: config.api_key,
      model: config.model,
      baseURL: config.base_url || undefined,
      maxTokens: config.max_output_tokens || undefined,
      temperature: config.temperature ?? 0.4
    });
  }

  private buildSystemPrompt(customPrompt?: string | null): string {
    const trimmed = customPrompt?.trim();
    if (!trimmed) {
      return DEFAULT_SYSTEM_PROMPT;
    }
    return `${trimmed}\n\n${DEFAULT_SYSTEM_PROMPT}`.trim();
  }

  private buildUserPrompt(intent: ManagerIntent): string {
    const parts: string[] = [];
    parts.push(`会话 ID：${intent.sessionId}`);
    parts.push(`消息 ID：${intent.messageId}`);
    parts.push(`优先级：${intent.priority}`);
    parts.push(`内容：\n${intent.content}`);

    if (intent.replyTo) {
      parts.push(`该消息回复了 ID 为 ${intent.replyTo} 的内容，请结合原消息上下文处理。`);
    }
    if (intent.mentions.length) {
      parts.push(`用户特别提及：${intent.mentions.join(', ')}`);
    }
    if (intent.reference?.id) {
      parts.push(`引用对象：${intent.reference.type || 'unknown'} -> ${intent.reference.id}`);
    }

    parts.push('请结合历史上下文（若可用）判断是否需要：');
    parts.push('1) 创建/更新任务（返回 tasks 列表，包含 action=create|update, title, description, priority, assignee）');
    parts.push('2) 请求/完成/取消协助（返回 assists 列表，action=request|complete|cancel, 说明任务或对象）');
    parts.push('3) 触发必要工具/ACE/MCP 操作（返回 tool_actions 列表，action=trigger, tool 名称, command）');
    parts.push('返回 JSON，字段：summary(string)、tasks(array)、assists(array)、tool_actions(array)。只返回 JSON，勿加解释。');

    return parts.join('\n');
  }

  private tryParseDecision(content: string | undefined): ManagerDecision | null {
    if (!content) return null;
    const jsonStart = content.indexOf('{');
    if (jsonStart === -1) return null;
    const jsonCandidate = content.slice(jsonStart).trim();
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed.summary === 'string') {
        return parsed as ManagerDecision;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async applyDecision(sessionId: string, decision: ManagerDecision, intent: ManagerIntent) {
    try {
      // 保障跨批次任务串行：新批次的首个任务依赖于当前会话最后一个未完成任务
      let prevCreatedTaskId: string | null = this.findSessionTailTask(sessionId);
      if (Array.isArray(decision.tasks)) {
        for (const task of decision.tasks) {
          const createdId = await this.applyTaskDecision(sessionId, task, intent, prevCreatedTaskId);
          if (createdId) {
            prevCreatedTaskId = createdId;
          }
        }
      }
      if (Array.isArray(decision.assists)) {
        for (const assist of decision.assists) {
          await this.applyAssistDecision(sessionId, assist, intent);
        }
      }
      if (Array.isArray(decision.tool_actions)) {
        for (const action of decision.tool_actions) {
          await this.applyToolDecision(sessionId, action, intent);
        }
      }
    } catch (error: any) {
      this.options.output.appendLine(`[ManagerOrchestrator] applyDecision error: ${error?.message ?? error}`);
      this.pushManagerNotification('error', '经理决策执行失败', error?.message ?? 'applyDecision error', {
        message_id: intent.messageId,
        session_id: sessionId
      });
    }
  }

  /**
   * 找到会话内最新的未完成任务（非 completed/failed），作为新批次的依赖起点
   */
  private findSessionTailTask(sessionId: string): string | null {
    try {
      const tasks = this.options.taskService.getAllTasks({ session_id: sessionId });
      const open = tasks
        .filter(t => t.status !== 'completed' && t.status !== 'failed')
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      return open.length ? open[open.length - 1].id : null;
    } catch (error: any) {
      this.options.output.appendLine(`[ManagerOrchestrator] findSessionTailTask error: ${error?.message ?? error}`);
      return null;
    }
  }

  private async applyTaskDecision(
    sessionId: string,
    task: NonNullable<ManagerDecision['tasks']>[number],
    intent: ManagerIntent,
    previousTaskId: string | null
  ): Promise<string | null> {
    if (task.action === 'create') {
      const resolvedAssignee = this.resolveAssignee(task.assignee);
      const { difficultyLabel, priority } = this.estimateDifficulty(task.title, task.description);
      const typeLabel = this.classifyTaskType(task.title || task.description || intent.content);
      const dependencies = previousTaskId ? [previousTaskId] : null;
      const created = this.options.taskService.createTask({
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        session_id: sessionId,
        title: task.title,
        intent: task.title,
        description: task.description ?? null,
        scope: 'workspace',
        priority: task.priority ?? priority,
        labels: this.mergeLabels(this.buildTaskLabels(intent.reference?.id, difficultyLabel), typeLabel ? [typeLabel] : []),
        due_at: null,
        status: dependencies ? 'blocked' : 'pending',
        assigned_to: resolvedAssignee,
        parent_task_id: null,
        dependencies,
        result_summary: null,
        result_details: null,
        result_artifacts: null,
        run_after: null,
        retry_count: 0,
        max_retries: null,
        timeout_seconds: null,
        last_started_at: null,
        metadata: this.buildTaskMetadata(intent, difficultyLabel)
      });
      this.options.messageService.sendMessage({
        id: `mgr_task_${created.id}`,
        session_id: sessionId,
        agent_id: 'manager_llm',
        content: `已创建任务「${task.title}」${created.assigned_to ? `，指派给 ${created.assigned_to}` : ''}。类型：${typeLabel?.replace('type:', '') || 'misc'} · 难度：${difficultyLabel?.replace('difficulty:', '') || '中'}`,
        priority: priority,
        tags: ['经理', `任务:${created.id}`],
        reply_to: intent.messageId,
        references: [created.id],
        reference_type: 'task',
        reference_id: created.id,
        mentions: created.assigned_to ? [created.assigned_to] : null,
        expires_at: null,
        category: 'system_event',
        visibility: 'blackboard',
        payload: {
          task_id: created.id,
          assigned_to: created.assigned_to,
          difficulty: difficultyLabel?.replace('difficulty:', '') || 'medium'
        }
      });
      if (this.options.notificationService) {
        this.options.notificationService.sendNotification({
          session_id: sessionId,
          level: 'info',
          title: '经理创建任务',
          message: `任务「${task.title}」${created.assigned_to ? `指派给 ${created.assigned_to}` : '等待指派'}，优先级 ${priority}`,
          metadata: {
            task_id: created.id,
            assigned_to: created.assigned_to,
            difficulty: difficultyLabel?.replace('difficulty:', '') || 'medium'
          }
        });
      }
      return created.id;
    }
    if (task.action === 'update') {
      // 仅支持更新优先级/指派，且必须有 task.id
      if (!task.id) {
        this.options.output.appendLine('[ManagerOrchestrator] update 任务缺少 id，已忽略');
        return null;
      }
      const updates: any = {};
      if (task.priority) updates.priority = task.priority;
      if (task.assignee !== undefined) updates.assigned_to = this.resolveAssignee(task.assignee);
      // 委托调度评分自动选人：若未显式指派，则尝试自动分配
      if (updates.assigned_to === undefined) {
        const targetTask = this.options.taskService.getTask(task.id);
        if (targetTask) {
          this.options.scheduler.tryAssignBestAgent(targetTask);
        }
      } else if (Object.keys(updates).length) {
        this.options.taskService.updateTask(task.id, updates);
      }
      // 仅在有更新或自动指派时发送提示
      if (task.priority || updates.assigned_to === null || updates.assigned_to) {
        const assignedLabel = updates.assigned_to ? `，指派给 ${updates.assigned_to}` : updates.assigned_to === null ? '，指派已清空' : '';
        this.options.messageService.sendMessage({
          id: `mgr_task_update_${task.id}_${Date.now()}`,
          session_id: sessionId,
          agent_id: 'manager_llm',
          content: `已更新任务 ${task.id}${assignedLabel}${task.priority ? `，优先级=${task.priority}` : ''}`,
          priority: task.priority ?? 'medium',
          tags: ['经理', `任务:${task.id}`],
          reply_to: intent.messageId,
          references: [task.id],
          reference_type: 'task',
          reference_id: task.id,
          mentions: task.assignee ? [task.assignee] : null,
          expires_at: null,
          category: 'system_event',
          visibility: 'blackboard',
          payload: {
            task_id: task.id,
            assigned_to: task.assignee ?? null,
            priority: task.priority ?? null
          }
        });
        this.options.notificationService?.sendNotification({
          session_id: sessionId,
          level: 'info',
          title: '经理更新任务',
          message: `任务 ${task.id}${assignedLabel}${task.priority ? ` 优先级 ${task.priority}` : ''}`,
          metadata: {
            task_id: task.id,
            assigned_to: task.assignee ?? null,
            priority: task.priority ?? null
          }
        });
      }
      return null;
    }
    return null;
  }

  private async handleDirectAgentReply(entry: BlackboardEntry, agentId: string) {
    const agent = this.options.agentService.getAgent(agentId);
    if (!agent || agent.is_enabled === false) {
      this.options.output.appendLine(`[ManagerOrchestrator] Agent ${agentId} 不可用，跳过直连回复`);
      return;
    }
    if (!agent.llm_provider || !agent.llm_model || !agent.llm_api_key) {
      this.options.output.appendLine(`[ManagerOrchestrator] Agent ${agentId} LLM 配置不完整，跳过直连回复`);
      return;
    }

    const client = createLLMClient({
      provider: agent.llm_provider as LLMProvider,
      apiKey: agent.llm_api_key,
      model: agent.llm_model,
      baseURL: agent.llm_base_url || undefined
    });

    const systemPrompt = agent.notes || 'You are an assistant. Respond concisely.';
    const userPrompt = entry.content || '';
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const streamingId = `agent_stream_${Date.now()}`;
    let reply = '';
    const streamMsg = this.options.messageService.sendMessage({
      id: streamingId,
      session_id: entry.session_id,
      agent_id: agentId,
      content: '正在回复…',
      priority: entry.priority || 'normal',
      tags: null,
      reply_to: entry.id,
      references: entry.references,
      reference_type: entry.reference_type,
      reference_id: entry.reference_id,
      mentions: [entry.agent_id || 'user'],
      expires_at: null,
      category: 'agent_summary',
      visibility: 'blackboard',
      payload: { source_message_id: entry.id, status: 'streaming' }
    });

    try {
      for await (const chunk of client.stream(messages, undefined, { systemPrompt, temperature: 0.5 })) {
        if (chunk.type === 'content' && chunk.content) {
          reply += chunk.content;
          this.options.messageService.updateMessage(streamMsg.id, {
            content: reply,
            payload: { ...(streamMsg.payload || {}), status: 'streaming' }
          });
        }
        if (chunk.type === 'error') {
          throw new Error(chunk.error || 'Agent LLM 流式错误');
        }
        if (chunk.type === 'done' && chunk.response?.content) {
          if (!reply.includes(chunk.response.content)) {
            reply += chunk.response.content;
          }
        }
      }
    } catch (error: any) {
      const errMsg = error?.message ?? 'Agent 回复失败';
      this.options.output.appendLine(`[ManagerOrchestrator] Agent ${agentId} 回复失败：${errMsg}`);
      this.options.messageService.updateMessage(streamMsg.id, {
        content: `⚠️ ${errMsg}`,
        payload: { ...(streamMsg.payload || {}), status: 'error', last_error: errMsg }
      });
      return;
    }

    reply = reply.trim();
    this.options.messageService.updateMessage(streamMsg.id, {
      content: reply || '（无回复）',
      payload: { ...(streamMsg.payload || {}), status: 'completed' }
    });
  }

  private async applyAssistDecision(sessionId: string, assist: NonNullable<ManagerDecision['assists']>[number], intent: ManagerIntent) {
    if (assist.action === 'request') {
      this.options.assistService.requestAssist({
        taskId: assist.taskId || intent.reference?.id || 'unknown_task',
        sessionId,
        requesterId: 'manager_llm',
        description: assist.description || '经理请求协助',
        targetAgentId: assist.targetAgentId ?? null,
        requiredCapabilities: assist.capabilities ?? []
      });
    } else if (assist.action === 'complete' && assist.taskId) {
      // 简化：按 taskId 找协助并标记完成
      const req = this.options.state.queryAssistRequests({ taskId: assist.taskId })[0];
      if (req) {
        this.options.assistService.completeAssist(req.id, { actorId: 'manager_llm', notes: assist.description });
      }
    } else if (assist.action === 'cancel' && assist.taskId) {
      const req = this.options.state.queryAssistRequests({ taskId: assist.taskId })[0];
      if (req) {
        this.options.assistService.cancelAssist(req.id, { actorId: 'manager_llm', reason: assist.description || '取消协助' });
      }
    }
  }

  private async applyToolDecision(sessionId: string, action: NonNullable<ManagerDecision['tool_actions']>[number], intent: ManagerIntent) {
    if (action.action !== 'trigger') {
      return;
    }
    const summary = action.command ? `执行命令：${action.command}` : `触发工具：${action.tool}`;
    const maybeMcp = action.tool.startsWith('mcp:');
    const maybeAce = action.tool.startsWith('ace:');

    if (maybeMcp) {
      const [, serverStr, toolName] = action.tool.split(':');
      const serverId = action.serverId ?? (serverStr ? Number(serverStr) : NaN);
      if (!Number.isFinite(serverId) || !toolName) {
        this.options.output.appendLine('[ManagerOrchestrator] MCP 工具参数缺失，已忽略');
        return;
      }
      await this.options.toolService.executeMcpTool({
        server_id: serverId,
        tool: toolName,
        args: action.args || {},
        session_id: sessionId,
        task_id: action.taskId ?? null,
        created_by: 'manager_llm'
      });
    } else if (maybeAce && action.command === 'refresh_index') {
      if (this.options.automationService) {
        await this.options.automationService.triggerAceRefresh(sessionId, '经理决策触发');
      } else {
        await this.options.toolService.executeExternalCommand({
          session_id: sessionId,
          task_id: action.taskId ?? null,
          tool_name: 'ace:index',
          command: 'ace:index',
          runner: 'ace',
          source: 'manager_llm',
          created_by: 'manager_llm'
        });
      }
    } else if (action.command) {
      if (this.options.automationService) {
        this.options.automationService.scheduleCommand({
          session_id: sessionId,
          task_id: action.taskId ?? null,
          tool_name: action.tool,
          command: action.command,
          delay_ms: action.delay_ms ?? 0,
          runner: 'automation',
          source: 'manager_llm',
          created_by: 'manager_llm'
        });
      } else {
        await this.options.toolService.executeExternalCommand({
          session_id: sessionId,
          task_id: action.taskId ?? null,
          tool_name: action.tool,
          command: action.command,
          runner: 'system',
          source: 'manager_llm',
          created_by: 'manager_llm'
        });
      }
    } else {
      this.options.toolService.recordExternalRunStart({
        id: `mgrtool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        session_id: sessionId,
        task_id: action.taskId ?? null,
        workflow_instance_id: null,
        tool_name: action.tool,
        runner: 'system',
        source: 'manager_llm',
        command: action.tool,
        input: {
          message_id: intent.messageId,
          reference: intent.reference
        },
        created_by: 'manager_llm'
      });
    }
    this.options.messageService.sendMessage({
      id: `mgr_tool_msg_${Date.now()}`,
      session_id: sessionId,
      agent_id: 'manager_llm',
      content: `已触发工具：${summary}`,
      priority: 'medium',
      tags: ['manager', 'tool'],
      reply_to: intent.messageId,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      category: 'system_event',
      visibility: 'blackboard',
      payload: {
        type: 'tool_triggered',
        tool: action.tool,
        command: action.command ?? null,
        task_id: action.taskId ?? null
      }
    });
  }
}
interface ManagerDecision {
  summary: string;
  tasks?: Array<{
    action: 'create' | 'update';
    id?: string;
    title: string;
    description?: string;
    priority?: 'high' | 'medium' | 'low';
    assignee?: string | null;
  }>;
  assists?: Array<{
    action: 'request' | 'complete' | 'cancel';
    taskId?: string;
    description?: string;
    targetAgentId?: string | null;
    capabilities?: string[];
  }>;
  tool_actions?: Array<{
    action: 'trigger';
    tool: string;
    command?: string;
    taskId?: string | null;
    serverId?: number | null;
    args?: Record<string, any> | null;
    delay_ms?: number;
  }>;
}
