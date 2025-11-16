import * as vscode from 'vscode';
import type {
  ExtensionConfig,
  Task,
  ThinkingStep,
  ToolCall,
  ThinkingStepType,
  AgentRole,
  Topic,
  VoteChoice,
  Vote,
  Approval,
  ApprovalDecision,
  MessageType
} from '../types';

interface RequirementPlanTask {
  title?: string;
  description?: string;
  intent?: string;
  scope?: string;
  priority?: string;
  assigned_role?: string;
  dependencies?: number[];
  labels?: string[];
  parent?: string;
}

interface RequirementPlanResponse {
  tasks: RequirementPlanTask[];
}
import { createTools, Tool } from '../tools';
import { BaseLLMClient, createLLMClient, LLMProvider, LLMMessage, LLMResponse, LLMTool } from '../llm';
import type { Services } from '../services';
import type { TypedEventEmitter } from '../events/emitter';
import type { TaskContextSnapshot } from '../services/task-context.service';

const GOVERNANCE_POLL_INTERVAL = 30000;
const TASK_LOCK_PREFIX = 'lock:task:';
const TASK_LOCK_TTL_MS = 15 * 60 * 1000;
const AGENT_EXCLUDE_LABEL_PREFIX = 'agent_exclude:';
const ROLE_SYNONYMS: Partial<Record<string, AgentRole>> = {
  product: 'coordinator',
  architect: 'developer',
  qa: 'tester',
  scribe: 'documenter'
};
const ROLE_PERSONA_MAP: Record<string, 'lead' | 'reviewer' | 'executor'> = {
  coordinator: 'lead',
  product: 'lead',
  architect: 'lead',
  admin: 'lead',
  reviewer: 'reviewer',
  tester: 'reviewer',
  security: 'reviewer',
  developer: 'executor',
  documenter: 'executor',
  analyzer: 'executor',
  scribe: 'executor'
};

/**
 * Agent Engine - 负责执行任务和与 LLM 交互
 * v3.0 版本：使用 Services 替代 ApiClient
 */
export class AgentEngine {
  private config: ExtensionConfig;
  private context: vscode.ExtensionContext;
  private services: Services;
  private events: TypedEventEmitter;
  private llmClient: BaseLLMClient | null = null;
  private isRunning: boolean = false;
  private currentSessionId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private thinkingSteps: ThinkingStep[] = [];
  private tools: Tool[];
  private outputChannel: vscode.OutputChannel;
  private activeTaskId: string | null = null;
  private voteCheckTimer: NodeJS.Timeout | null = null;
  private approvalCheckTimer: NodeJS.Timeout | null = null;
  private processingVoteTopics = new Set<string>();
  private processingApprovals = new Set<number>();
  private promptTokenBudget = 3200;
  private voteUpdateListener = (_topics: Topic[]) => {
    if (!this.isRunning) {
      return;
    }
    void this.checkPendingVotes();
  };
  private approvalUpdateListener = (_approvals: Approval[]) => {
    if (!this.isRunning) {
      return;
    }
    void this.checkPendingApprovals();
  };
  private taskUpdateListener = (tasks: Task[]) => {
    if (!this.isRunning) {
      return;
    }
    void this.handleTaskUpdate(tasks);
  };
  private agentRoleSet: Set<string>;

  constructor(
    config: ExtensionConfig,
    context: vscode.ExtensionContext,
    services: Services,
    events: TypedEventEmitter,
    outputChannel: vscode.OutputChannel
  ) {
    this.config = config;
    this.context = context;
    this.services = services;
    this.events = events;
    this.outputChannel = outputChannel;
    this.tools = createTools(this.context, {
      services: this.services,
      getSessionId: () => this.currentSessionId,
      getAgentInfo: () => ({
        id: this.config.agent.id,
        displayName: this.config.agent.displayName || this.config.agent.id
      }),
      getActiveTaskId: () => this.activeTaskId
    });
    this.agentRoleSet = new Set((this.config.agent.roles || []).map(role => role.toLowerCase()));

    // 初始化 LLM 客户端
    try {
      this.llmClient = createLLMClient({
        provider: config.llm.provider as LLMProvider,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        baseURL: config.llm.baseURL
      });
      this.outputChannel.appendLine(`LLM client initialized: ${config.llm.provider} - ${config.llm.model}`);
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to initialize LLM client: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to initialize LLM: ${error.message}`);
    }
  }

  async start(sessionId: string) {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.currentSessionId = sessionId;
    this.isRunning = true;

    // 注册 Agent
    try {
      const existingAgents = this.services.agent.getAllAgents();
      const existing = existingAgents.find(a => a.id === this.config.agent.id);

      if (!existing) {
        throw new Error(`Agent ${this.config.agent.id} 未在数据库中找到，请在 Agent 管理中重新配置。`);
      }

      this.services.agent.updateAgentStatus(this.config.agent.id, {
        status: 'online',
        status_detail: 'Reconnected',
        active_task_id: null
      });
      this.outputChannel.appendLine(`Agent reconnected: ${this.config.agent.id}`);
    } catch (error: any) {
      this.outputChannel.appendLine(`Agent registration failed: ${error.message}`);
      throw error;
    }

    // 启动心跳
    this.startHeartbeat();

    // 监听任务更新事件
    this.events.on('tasks_update', this.taskUpdateListener);

    this.startGovernanceWatchers();
    this.outputChannel.appendLine('Agent started');
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    this.stopGovernanceWatchers();
    this.events.off('tasks_update', this.taskUpdateListener);
    // 停止心跳
    this.stopHeartbeat();

    try {
      this.services.lock.releaseByHolder(this.config.agent.id);
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to release locks for ${this.config.agent.id}: ${error.message}`);
    }

    // 更新 Agent 状态为离线
    try {
      this.services.agent.updateAgentStatus(this.config.agent.id, {
        status: 'offline',
        status_detail: 'Stopped',
        active_task_id: null
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to update agent status: ${error.message}`);
    }

    this.outputChannel.appendLine('Agent stopped');
  }

  private startHeartbeat() {
    const sendHeartbeat = () => {
      try {
        this.services.agent.updateHeartbeat(this.config.agent.id);
      } catch (error: any) {
        this.outputChannel.appendLine(`Heartbeat failed: ${error.message}`);
      }
    };
    sendHeartbeat();
    this.heartbeatTimer = setInterval(sendHeartbeat, 30000); // 每 30 秒发送一次心跳
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startGovernanceWatchers() {
    this.stopGovernanceWatchers();
    this.events.on('votes_update', this.voteUpdateListener);
    this.events.on('approvals_update', this.approvalUpdateListener);
    void this.checkPendingVotes();
    void this.checkPendingApprovals();
    this.voteCheckTimer = setInterval(() => {
      void this.checkPendingVotes();
    }, GOVERNANCE_POLL_INTERVAL);
    this.approvalCheckTimer = setInterval(() => {
      void this.checkPendingApprovals();
    }, GOVERNANCE_POLL_INTERVAL);
  }

  private stopGovernanceWatchers() {
    if (this.voteCheckTimer) {
      clearInterval(this.voteCheckTimer);
      this.voteCheckTimer = null;
    }
    if (this.approvalCheckTimer) {
      clearInterval(this.approvalCheckTimer);
      this.approvalCheckTimer = null;
    }
    this.events.off('votes_update', this.voteUpdateListener);
    this.events.off('approvals_update', this.approvalUpdateListener);
    this.processingVoteTopics.clear();
    this.processingApprovals.clear();
  }

  private async checkPendingVotes() {
    if (!this.isRunning || !this.llmClient) {
      return;
    }
    const sessionIds = this.getRelevantSessionIds();
    if (sessionIds.length === 0) {
      return;
    }
    try {
      for (const sessionId of sessionIds) {
        const topics = this.services.vote.getAllTopics({
          session_id: sessionId,
          status: 'pending'
        });
        for (const topic of topics) {
          await this.evaluateVoteTopic(topic);
          if (!this.isRunning) {
            break;
          }
        }
        if (!this.isRunning) {
          break;
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[AgentEngine] checkPendingVotes error: ${error.message}`);
    }
  }

  private getRelevantSessionIds(): string[] {
    const tasks = this.services.task.getAllTasks({ assigned_to: this.config.agent.id });
    const sessionIds = new Set<string>();
    tasks.forEach(task => {
      if (task.session_id) {
        sessionIds.add(task.session_id);
      }
    });
    if (sessionIds.size === 0 && this.currentSessionId) {
      sessionIds.add(this.currentSessionId);
    }
    return Array.from(sessionIds);
  }

  private agentMatchesRequiredRoles(required: string[] | null | undefined): boolean {
    if (!required || required.length === 0) {
      return true;
    }
    return required.some(role => this.agentRoleSet.has(role.toLowerCase()));
  }

  private async evaluateVoteTopic(topic: Topic) {
    if (!this.isRunning || topic.status !== 'pending') {
      return;
    }
    if (!this.agentMatchesRequiredRoles(topic.required_roles)) {
      return;
    }
    const voteList = topic.votes ?? this.services.vote.getVotesForTopic(topic.id);
    if (voteList.some(vote => vote.agent_id === this.config.agent.id)) {
      return;
    }
    if (this.processingVoteTopics.has(topic.id)) {
      return;
    }
    this.processingVoteTopics.add(topic.id);
    try {
      const choice = await this.decideVote(topic, voteList);
      this.services.vote.castVote(topic.id, this.config.agent.id, choice, `auto:${choice}`);
      this.outputChannel.appendLine(`[AgentEngine] Auto-voted ${choice} on topic ${topic.id}`);
    } catch (error: any) {
      this.outputChannel.appendLine(`[AgentEngine] Failed to vote on topic ${topic.id}: ${error.message}`);
    } finally {
      this.processingVoteTopics.delete(topic.id);
    }
  }

  private async decideVote(topic: Topic, votes: Vote[]): Promise<VoteChoice> {
    if (!this.llmClient) {
      return 'abstain';
    }
    const voteSummary = votes.length > 0
      ? votes.map(v => `- ${v.agent_id}: ${v.choice}`).join('\n')
      : '当前没有其他人投票';
    const roles = this.config.agent.roles?.join(', ') || 'unassigned';
    const prompt = `你是 ${this.config.agent.displayName}（角色: ${roles}），需要参与一次投票。

主题: ${topic.title}
描述: ${topic.description || '无'}
当前投票摘要:
${voteSummary}

请基于角色职责、现有票数与风险做出判断，并只用以下之一作为回答：
- approve （赞成）
- reject （反对）
- abstain （弃权）`;

    const response = await this.llmClient.chat(
      [{ role: 'user', content: prompt }],
      undefined,
      {
        maxTokens: 256,
        systemPrompt: 'You are a pragmatic software lead. Respond using only one word from {approve, reject, abstain}.'
      }
    );
    return this.parseVoteChoice(response?.content);
  }

  private parseVoteChoice(raw?: string | null): VoteChoice {
    const normalized = (raw || '').trim().toLowerCase();
    if (normalized.includes('reject') || normalized.includes('deny') || normalized.includes('否决') || normalized.includes('拒绝')) {
      return 'reject';
    }
    if (normalized.includes('abstain') || normalized.includes('弃权')) {
      return 'abstain';
    }
    if (normalized.includes('approve') || normalized.includes('通过') || normalized.includes('赞成')) {
      return 'approve';
    }
    return 'approve';
  }

  private async checkPendingApprovals() {
    if (!this.isRunning || !this.llmClient) {
      return;
    }
    try {
      const approvals = this.services.approval.getAllApprovals({
        decision: 'pending',
        approver_id: this.config.agent.id
      });
      for (const approval of approvals) {
        await this.evaluateApproval(approval);
        if (!this.isRunning) {
          break;
        }
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[AgentEngine] checkPendingApprovals error: ${error.message}`);
    }
  }

  private async evaluateApproval(approval: Approval) {
    if (!this.isRunning || approval.decision !== 'pending') {
      return;
    }
    if (approval.approver_id !== this.config.agent.id) {
      return;
    }
    if (this.processingApprovals.has(approval.id)) {
      return;
    }
    this.processingApprovals.add(approval.id);
    try {
      const task = this.services.task.getTask(approval.task_id);
      const decision = await this.decideApproval(approval, task);
      if (decision === 'approved') {
        this.services.approval.approve(approval.id, this.config.agent.id, 'Auto-approved by agent');
        this.outputChannel.appendLine(`[AgentEngine] Auto-approved approval ${approval.id}`);
        this.notifyApprovalResult(task?.session_id, approval, 'approved', task);
      } else {
        this.services.approval.reject(approval.id, this.config.agent.id, 'Auto-rejected by agent');
        this.outputChannel.appendLine(`[AgentEngine] Auto-rejected approval ${approval.id}`);
        this.notifyApprovalResult(task?.session_id, approval, 'rejected', task);
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[AgentEngine] Failed to process approval ${approval.id}: ${error.message}`);
    } finally {
      this.processingApprovals.delete(approval.id);
    }
  }

  private async decideApproval(approval: Approval, task: Task | null): Promise<ApprovalDecision> {
    if (!this.llmClient) {
      return 'rejected';
    }
    const taskSummary = task
      ? `任务标题: ${task.title}
任务意图: ${task.intent}
任务描述: ${task.description || '无'}
当前状态: ${task.status}`
      : '未找到关联任务，默认从风险角度进行判断';
    const fileChangesSummary = task?.id ? this.buildFileChangeSummary(task.id) : '暂无文件变更信息';

    const roles = this.config.agent.roles?.join(', ') || 'unassigned';
    const prompt = `你是 ${this.config.agent.displayName}（角色: ${roles}），需要对以下审批做出决定：

审批原因: ${approval.comment || '未提供原因'}
${taskSummary}

请结合整体风险、任务背景和工程治理要求，只回答以下之一：
- approve （批准）
- reject （拒绝）

文件变更摘要:
${fileChangesSummary}`;

    const response = await this.llmClient.chat(
      [{ role: 'user', content: prompt }],
      undefined,
      {
        maxTokens: 256,
        systemPrompt: 'You enforce engineering governance. Respond using only approve or reject.'
      }
    );
    const normalized = (response?.content || '').trim().toLowerCase();
    if (normalized.includes('reject') || normalized.includes('拒绝') || normalized.includes('否决')) {
      return 'rejected';
    }
    return 'approved';
  }

  private buildFileChangeSummary(taskId: string): string {
    try {
      const changes = this.services.fileChange.getTaskFileChanges(taskId) || [];
      if (changes.length === 0) {
        return '暂无记录';
      }
      const recent = [...changes].sort((a, b) => b.created_at - a.created_at).slice(0, 5);
      return recent.map(change => {
        const delta = change.line_changes
          ? `+${change.line_changes.added}/-${change.line_changes.removed}`
          : '';
        return `• ${change.file_path} (${change.change_type}${delta ? ', ' + delta : ''})`;
      }).join('\n');
    } catch (error) {
      this.outputChannel.appendLine(`[AgentEngine] Failed to summarize file changes: ${error instanceof Error ? error.message : error}`);
      return '获取文件变更失败';
    }
  }

  private notifyApprovalResult(
    sessionId: string | undefined,
    approval: Approval,
    decision: ApprovalDecision,
    task?: Task | null
  ) {
    try {
      if (!this.services.notification) {
        return;
      }
      const title = decision === 'approved' ? '审批已自动通过' : '审批已自动拒绝';
      const message = `审批 #${approval.id} (${approval.task_id || '无任务'}) 已由 ${this.config.agent.displayName || this.config.agent.id} 自动${decision === 'approved' ? '批准' : '拒绝'}`;
      const metadata: Record<string, any> = {
        approval_id: approval.id
      };
      if (approval.task_id) {
        metadata.task_id = approval.task_id;
      }
      if (sessionId) {
        metadata.session_id = sessionId;
      }
      const instanceId = this.extractWorkflowInstanceId(task || null);
      if (instanceId) {
        metadata.workflow_instance_id = instanceId;
      }
      this.services.notification.sendNotification({
        session_id: sessionId || this.currentSessionId || 'default',
        level: decision === 'approved' ? 'info' : 'warning',
        title,
        message,
        metadata
      });
    } catch (error) {
      this.outputChannel.appendLine(`[AgentEngine] Failed to send approval notification: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async handleTaskUpdate(tasks: Task[]) {
    if (!this.isRunning) {
      return;
    }

    // 检查是否有分配给我的新任务
    const myTasks = tasks
      .filter(t => t.assigned_to === this.config.agent.id && t.status === 'assigned')
      .filter(t => this.services.task.canExecuteTask(t.id));

    for (const task of myTasks) {
      const lockResource = `${TASK_LOCK_PREFIX}${task.id}`;
      const lockAcquired = this.services.lock.acquire(
        lockResource,
        this.config.agent.id,
        task.session_id,
        TASK_LOCK_TTL_MS
      );

      if (!lockAcquired) {
        this.outputChannel.appendLine(`[AgentEngine] Task ${task.id} is locked by another worker, skipping`);
        continue;
      }

      try {
        await this.executeTask(task);
      } finally {
        this.services.lock.release(lockResource);
      }
    }
  }

  private async executeTask(task: Task) {
    const previousSessionId = this.currentSessionId;
    const activeSessionId = task.session_id || previousSessionId || null;
    this.currentSessionId = activeSessionId;
    this.activeTaskId = task.id;
    const friendlyTitle = task.title || task.intent || task.id;
    try {
      // 更新状态为运行中
      this.services.task.updateTaskStatus(task.id, 'running');
      this.services.agent.updateAgentStatus(this.config.agent.id, {
        status: 'busy',
        status_detail: `执行任务：${friendlyTitle}`,
        active_task_id: task.id
      });

      if (activeSessionId) {
        this.recordSystemEvent(activeSessionId, `开始任务：${friendlyTitle}`, {
          task_id: task.id,
          intent: task.intent
        });
      }

      // 执行任务
      this.thinkingSteps = [];
      await this.recordThinkingStep(task.id, activeSessionId, {
        id: `start-${Date.now()}`,
        type: 'observation',
        content: `任务「${friendlyTitle}」由 ${this.config.agent.displayName || this.config.agent.id} 开始执行。`,
        timestamp: Date.now()
      });

      const finalSummary = this.isRequirementAnalysisTask(task)
        ? await this.executeRequirementAnalysisTask(task)
        : (await this.runLLM(task)) || `任务「${friendlyTitle}」已完成。`;
      const completedAt = Date.now();

      await this.recordThinkingStep(task.id, activeSessionId, {
        id: `result-${completedAt}`,
        type: 'result',
        content: finalSummary,
        timestamp: completedAt
      });

      // 保存任务结果
      this.services.task.completeTask(task.id, {
        summary: finalSummary,
        details: JSON.stringify(this.thinkingSteps, null, 2),
        artifacts: []
      });

      this.services.agent.updateAgentStatus(this.config.agent.id, {
        status: 'online',
        status_detail: null,
        active_task_id: null
      });

      // 发送完成消息
      if (activeSessionId) {
        this.recordSystemEvent(activeSessionId, `任务完成：${friendlyTitle}`, {
          task_id: task.id,
          intent: task.intent
        });
      }
      if (activeSessionId && this.shouldBroadcastTaskUpdate(task)) {
        this.broadcastTaskSummary(task, activeSessionId, finalSummary);
      }

      this.outputChannel.appendLine(`Task completed: ${task.id}`);

    } catch (error: any) {
      const reason = error?.message || String(error);
      this.outputChannel.appendLine(`Task execution failed: ${reason}`);

      await this.recordThinkingStep(task.id, activeSessionId, {
        id: `error-${Date.now()}`,
        type: 'result',
        content: `任务失败：${reason}`,
        timestamp: Date.now()
      });

      const takeoverRequested = this.requestTaskTakeover(task, activeSessionId, reason);
      if (!takeoverRequested) {
        this.services.task.failTask(task.id, reason);
        this.broadcastTaskFailure(task, activeSessionId, reason);
      }
      this.services.agent.markAgentOffline(this.config.agent.id, reason);
    } finally {
      this.activeTaskId = null;
      this.currentSessionId = previousSessionId || null;
    }
  }

  private isRequirementAnalysisTask(task: Task): boolean {
    const labels = task.labels || [];
    return task.intent === 'analyze_requirement' || labels.includes('requirement');
  }

  private async executeRequirementAnalysisTask(task: Task): Promise<string> {
    if (!this.llmClient) {
      throw new Error('LLM client not initialized');
    }

    const rawContent = await this.invokeRequirementPlanner(task);
    if (!rawContent) {
      throw new Error('Requirement analysis planner returned empty response after fallback');
    }

    const plan = await this.parseRequirementPlan(task, rawContent);
    if (!plan.tasks || plan.tasks.length === 0) {
      return '需求已分析，未发现可分解任务。';
    }

    const timestamp = Date.now();
    const generatedTaskIds = plan.tasks.map((_: RequirementPlanTask, index: number) => `task-${task.id}-${timestamp}-${index}`);
    const onlineAgents = this.services.agent.getOnlineLLMAgents();

    const requirementLabel = (task.labels || []).find(label => label.startsWith('requirement:')) || null;

    const tasksToCreate = plan.tasks.map((item: RequirementPlanTask, index: number) => {
      const dependencyIds = Array.isArray(item.dependencies)
        ? item.dependencies
            .map((depIndex: number) => generatedTaskIds[depIndex])
            .filter(Boolean)
        : [];

      const normalizedRole = this.normalizeAssignedRole(item.assigned_role);
      const assignedAgent = this.selectAgentForRole(normalizedRole ?? undefined) ??
        this.services.agent.getLeastLoadedAgent(onlineAgents);

      const parentDirective = (item.parent || '').toLowerCase();
      const isRootLevel = parentDirective === 'root' || parentDirective === 'main' || parentDirective === 'top';
      const parentTaskId = isRootLevel ? null : task.id;
      const hasDependencies = dependencyIds.length > 0;
      const assignedAgentId = assignedAgent?.id || null;
      let status: Task['status'] = 'pending';
      if (hasDependencies) {
        status = 'blocked';
      } else if (assignedAgentId) {
        status = 'assigned';
      }
      const labels = [
        ...(requirementLabel ? [requirementLabel] : []),
        isRootLevel ? 'requirement_root' : 'subtask',
        ...(item.labels || [])
      ];
      labels.push(`plan_source:${task.id}`);
      if (normalizedRole) {
        labels.push(`workflow_role:${normalizedRole}`);
        labels.push(`role:${normalizedRole}`);
      }

      return {
        id: generatedTaskIds[index],
        session_id: task.session_id,
        title: item.title || `子任务 ${index + 1}`,
        intent: item.intent || 'deliverable',
        description: item.description || null,
        scope: item.scope || task.scope || 'workspace',
        priority: (item.priority?.toLowerCase() as Task['priority']) || 'medium',
        labels,
        due_at: null,
        status,
        assigned_to: assignedAgentId,
        parent_task_id: parentTaskId,
        dependencies: dependencyIds
      };
    });

    this.services.task.createTasks(tasksToCreate);

    if (task.session_id) {
      this.services.message.sendMessage({
        id: `msg-${Date.now()}`,
        session_id: task.session_id,
        agent_id: this.config.agent.id,
        message_type: 'decision',
        content: `已将需求分解为 ${tasksToCreate.length} 个子任务。`,
        priority: 'medium',
        tags: ['requirement', 'decomposition'],
        reply_to: null,
        references: tasksToCreate.map(taskItem => taskItem.id),
        reference_type: 'task',
        reference_id: task.id,
        mentions: null,
        expires_at: null,
        category: 'agent_summary',
        visibility: 'blackboard',
        payload: {
          source_task_id: task.id,
          created_tasks: tasksToCreate.map(item => item.id)
        }
      });
    }

    this.services.notification.sendNotification({
      session_id: task.session_id,
      level: 'info',
      title: '需求分解完成',
      message: `已创建 ${tasksToCreate.length} 个子任务等待执行。`,
      metadata: this.buildTaskNotificationMetadata(task)
    });

    return `需求已分解为 ${tasksToCreate.length} 个子任务。`;
  }

  private buildRequirementAnalysisPrompt(task: Task): string {
    return `你是一个需求分析专家，请阅读以下需求并输出 JSON 结构。

需求内容：
${task.description || task.intent}

输出格式：
{
  "tasks": [
    {
      "title": "任务标题",
      "description": "任务描述",
      "intent": "任务意图 (如 implement_feature, write_test, code_review)",
      "scope": "任务涉及的范围",
      "priority": "high|medium|low",
      "assigned_role": "developer|reviewer|tester|security|documenter|coordinator|analyzer",
      "dependencies": [索引列表，依赖前面任务的下标],
      "labels": ["可选标签"],
      "parent": "root|child"
    }
  ]
}
仅输出 JSON，不要添加其他说明。`;
  }

  private buildRequirementAnalysisFallbackPrompt(task: Task): string {
    const base = this.buildRequirementAnalysisPrompt(task);
    return `${base}

请务必输出如下 JSON:
{
  "tasks": [
    {
      "title": "用中文描述的子任务",
      "description": "该子任务需要完成的事项",
      "intent": "implement_requirement",
      "scope": "frontend",
      "priority": "high",
      "assigned_role": "developer",
      "dependencies": [],
      "parent": "root"
    }
  ]
}

如果无法拆解，请返回 {"tasks": []}。切勿输出 JSON 以外的内容。`;
  }

  private async invokeRequirementPlanner(task: Task): Promise<string | null> {
    const variants = [
      { prompt: this.buildRequirementAnalysisPrompt(task), tag: 'primary' },
      { prompt: this.buildRequirementAnalysisFallbackPrompt(task), tag: 'fallback' }
    ];
    let lastError: Error | null = null;
    for (const variant of variants) {
      try {
        const response = await this.llmClient!.chat([{ role: 'user', content: variant.prompt }], undefined, {
          maxTokens: 2048,
          systemPrompt: 'You are an expert project planner. Return strictly valid JSON.'
        });
        const rawContent = response.content?.trim();
        if (rawContent) {
          return rawContent;
        }
        lastError = new Error('Requirement analysis LLM returned empty response');
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.outputChannel.appendLine(`[AgentEngine] Requirement planner ${variant.tag} failed: ${lastError.message}`);
      }
    }
    const message = lastError?.message || 'Requirement planner failed after fallback';
    this.services.notification.sendNotification({
      session_id: task.session_id,
      level: 'error',
      title: '需求分解失败',
      message: `Agent ${this.config.agent.displayName || this.config.agent.id} 无法生成执行计划：${message}`,
      metadata: this.buildTaskNotificationMetadata(task)
    });
    return null;
  }

  private shouldBroadcastTaskUpdate(task: Task): boolean {
    const labels = task.labels || [];
    if (labels.includes('requirement') || labels.includes('plan')) {
      return true;
    }
    if (!task.parent_task_id) {
      return true;
    }
    return false;
  }

  private async parseRequirementPlan(task: Task, rawContent: string): Promise<RequirementPlanResponse> {
    try {
      return this.safeParsePlan(rawContent);
    } catch (error: any) {
      const parseMessage = error?.message || 'unknown parse error';
      this.outputChannel.appendLine(`[AgentEngine] Requirement plan parse failed: ${parseMessage}`);
      const repaired = await this.requestPlanRepair(task, rawContent, parseMessage);
      if (repaired) {
        try {
          return this.safeParsePlan(repaired);
        } catch (repairError: any) {
          this.outputChannel.appendLine(`[AgentEngine] Requirement plan repair still invalid: ${repairError?.message ?? repairError}`);
          throw repairError;
        }
      }
      throw error;
    }
  }

  private safeParsePlan(content: string): RequirementPlanResponse {
    const normalized = this.normalizePlanJson(content);
    return JSON.parse(normalized);
  }

  private normalizePlanJson(content: string): string {
    if (!content) {
      return '';
    }
    let trimmed = content.trim();
    if (trimmed.startsWith('```')) {
      trimmed = trimmed.replace(/^```(?:json)?/i, '');
      trimmed = trimmed.replace(/```$/i, '');
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      trimmed = trimmed.slice(start, end + 1);
    }
    trimmed = trimmed.replace(/,\s*([}\]])/g, '$1');
    trimmed = trimmed.replace(/\u2018|\u2019/g, '\'');
    return trimmed.trim();
  }

  private async requestPlanRepair(task: Task, originalContent: string, parseError: string): Promise<string | null> {
    if (!this.llmClient) {
      return null;
    }
    try {
      const prompt = this.buildRequirementPlanRepairPrompt(task, originalContent, parseError);
      const response = await this.llmClient.chat(
        [{ role: 'user', content: prompt }],
        undefined,
        {
          maxTokens: 2048,
          systemPrompt: 'You convert partially-valid JSON text into clean, strictly valid JSON. Respond with JSON only.'
        }
      );
      const repaired = response.content?.trim();
      return repaired || null;
    } catch (error: any) {
      this.outputChannel.appendLine(`[AgentEngine] Plan repair request failed: ${error?.message ?? error}`);
      return null;
    }
  }

  private buildRequirementPlanRepairPrompt(task: Task, brokenContent: string, parseError: string): string {
    const snippet = brokenContent.length > 4000
      ? brokenContent.slice(0, 4000)
      : brokenContent;
    return `上一次为需求「${task.title || task.intent}」生成的 JSON 无法解析，错误信息：${parseError}。请根据下面的原始输出修复并返回严格合法的 JSON，格式仍为 {"tasks":[...]}，不要添加解释。\n\n原始输出：\n${snippet}`;
  }

  private selectAgentForRole(role?: AgentRole) {
    if (!role) {
      return null;
    }
    const candidates = this.services.agent.getAgentsByRole(role);
    if (!candidates || candidates.length === 0) {
      return null;
    }
    return this.services.agent.getLeastLoadedAgent(candidates) || candidates[0];
  }

  private normalizeAssignedRole(role?: string | null): AgentRole | null {
    if (!role) {
      return null;
    }
    const lower = role.toLowerCase();
    const synonym = ROLE_SYNONYMS[lower];
    if (synonym) {
      return synonym;
    }
    if (Object.keys(ROLE_PERSONA_MAP).includes(lower)) {
      return lower as AgentRole;
    }
    return null;
  }

  private async chatWithStreamForTask(
    task: Task,
    messages: LLMMessage[],
    tools: LLMTool[],
    options: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): Promise<LLMResponse> {
    if (!this.llmClient) {
      throw new Error('LLM client not initialized');
    }
    const sessionId = task.session_id || this.currentSessionId || null;
    let finalResponse: LLMResponse | null = null;
    let contentBuffer = '';

    try {
      for await (const chunk of this.llmClient.stream(messages, tools, options)) {
        if (chunk.type === 'content' && chunk.content) {
          contentBuffer += chunk.content;
          this.events.emit('llm_stream_update', {
            session_id: sessionId,
            task_id: task.id,
            agent_id: this.config.agent.id,
            status: 'stream',
            content: contentBuffer,
            delta: chunk.content,
            source: 'thinking',
            timestamp: Date.now()
          });
        } else if (chunk.type === 'done' && chunk.response) {
          finalResponse = chunk.response;
          if (!finalResponse.content) {
            finalResponse.content = contentBuffer;
          }
          this.events.emit('llm_stream_update', {
            session_id: sessionId,
            task_id: task.id,
            agent_id: this.config.agent.id,
            status: 'done',
            content: finalResponse.content,
            source: 'thinking',
            timestamp: Date.now()
          });
        } else if (chunk.type === 'error') {
          this.events.emit('llm_stream_update', {
            session_id: sessionId,
            task_id: task.id,
            agent_id: this.config.agent.id,
            status: 'error',
            error: chunk.error || 'LLM streaming error',
            source: 'thinking',
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      this.events.emit('llm_stream_update', {
        session_id: sessionId,
        task_id: task.id,
        agent_id: this.config.agent.id,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        source: 'thinking',
        timestamp: Date.now()
      });
      throw error;
    }

    if (!finalResponse) {
      finalResponse = {
        content: contentBuffer,
        stop_reason: 'end_turn'
      };
    }
    return finalResponse;
  }

  private async runLLM(task: Task): Promise<string> {
    if (!this.llmClient) {
      throw new Error('LLM client not initialized');
    }
    const sessionId = task.session_id || this.currentSessionId;
    const contextSnapshot = this.services.taskContext.getContext(task);

    const toolSchemas = this.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema
    }));

    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: this.buildTaskPrompt(task, contextSnapshot)
      }
    ];

    let finalSummary = '';
    let iterationCount = 0;
    const maxIterations = 20;

    while (iterationCount < maxIterations) {
      iterationCount++;

      this.trimPromptMessages(messages);

      const response = await this.chatWithStreamForTask(
        task,
        messages,
        toolSchemas,
        {
          maxTokens: 4096,
          systemPrompt: this.buildSystemPrompt(task)
        }
      );

      if (response.content && response.content.trim().length > 0) {
        const thought = response.content.trim();
        const step: ThinkingStep = {
          id: `thought-${Date.now()}-${iterationCount}`,
          type: 'thought',
          content: thought,
          timestamp: Date.now()
        };
        await this.recordThinkingStep(task.id, sessionId, step);
        messages.push({ role: 'assistant', content: thought });
        finalSummary = thought;
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          const tool = this.tools.find(t => t.name === call.name);
          const toolCall: ToolCall = {
            id: call.id,
            name: call.name,
            arguments: call.input,
            timestamp: Date.now()
          };

          if (!tool) {
            toolCall.error = `Tool ${call.name} is not available.`;
            await this.recordThinkingStep(task.id, sessionId, {
              id: `tool-${toolCall.id}`,
              type: 'tool_call',
              content: toolCall.error,
              timestamp: toolCall.timestamp,
              toolCall
            });
            messages.push({
              role: 'user',
              content: `Tool ${call.name} failed because it is not available.`
            });
            continue;
          }

          try {
            const output = await tool.handler(call.input);
            toolCall.result = output;

            await this.recordThinkingStep(task.id, sessionId, {
              id: `tool-${toolCall.id}`,
              type: 'tool_call',
              content: `Tool ${call.name} executed successfully.`,
              timestamp: toolCall.timestamp,
              toolCall
            });

            const observation = this.stringifyToolOutput(output);
            await this.recordThinkingStep(task.id, sessionId, {
              id: `obs-${toolCall.id}`,
              type: 'observation',
              content: observation,
              timestamp: Date.now()
            });

            messages.push({
              role: 'user',
              content: `Tool ${call.name} result:\n${observation}`
            });
          } catch (error: any) {
            toolCall.error = error?.message || String(error);

            await this.recordThinkingStep(task.id, sessionId, {
              id: `tool-${toolCall.id}`,
              type: 'tool_call',
              content: `Tool ${call.name} failed: ${toolCall.error}`,
              timestamp: toolCall.timestamp,
              toolCall
            });

            messages.push({
              role: 'user',
              content: `Tool ${call.name} failed with error: ${toolCall.error}`
            });
          }
        }

        continue;
      }

      if (!response.content || response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
        break;
      }
    }

    return finalSummary;
  }

  private async recordThinkingStep(taskId: string, sessionId: string | null, step: ThinkingStep) {
    this.thinkingSteps.push(step);

    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) {
      return;
    }

    try {
      // 记录思考日志到数据库
      this.services.thinking.createThinkingLog({
        session_id: targetSessionId,
        agent_id: this.config.agent.id,
        task_id: taskId,
        step_type: step.type,
        content: step.content,
        tool_name: step.toolCall?.name || null,
        tool_input: step.toolCall?.arguments || null,
        tool_output: step.toolCall?.result || (step.toolCall?.error ? { error: step.toolCall.error } : null)
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`Failed to record thinking step: ${error.message}`);
    }
  }

  private buildSystemPrompt(task: Task): string {
    const displayName = this.config.agent.displayName || this.config.agent.id;
    const role = this.getPrimaryRole();
    return [
      `You are Agent ${displayName}, acting in the role of ${role}.`,
      'You collaborate with other agents to complete software tasks.',
      'Think step by step, use available tools when helpful, and summarize your findings clearly.',
      `Current task priority: ${task.priority}.`,
      'When you finish, provide a concise summary of the work performed.'
    ].join('\n');
  }

  private buildTaskPrompt(task: Task, context: TaskContextSnapshot): string {
    const lines = [
      `Task Title: ${task.title || task.intent}`,
      `Intent: ${task.intent}`,
      `Scope: ${task.scope}`
    ];

    if (task.description) {
      lines.push(`Description: ${task.description}`);
    }

    if (task.labels && task.labels.length > 0) {
      lines.push(`Labels: ${task.labels.join(', ')}`);
    }

    if (task.due_at) {
      lines.push(`Due At: ${new Date(task.due_at).toISOString()}`);
    }

    if (context.summary) {
      lines.push(`Context Summary:\n${context.summary}`);
    }

    lines.push('Please analyze the task, plan the steps, use tools if necessary, and deliver the result.');

    return lines.join('\n');
  }

  private stringifyToolOutput(output: any): string {
    if (output === undefined) {
      return 'undefined';
    }

    if (output === null) {
      return 'null';
    }

    if (typeof output === 'string') {
      return output.length > 2000 ? `${output.slice(0, 2000)}…` : output;
    }

    try {
      const text = JSON.stringify(output, null, 2);
      return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    } catch (error) {
      return String(output);
    }
  }

  private trimPromptMessages(messages: LLMMessage[]) {
    const limit = this.promptTokenBudget;
    const countTokens = () => messages.reduce((sum, msg) => sum + this.estimateTokens(msg.content), 0);
    while (messages.length > 1 && countTokens() > limit) {
      messages.splice(1, 1);
    }
  }

  private estimateTokens(content?: string | null): number {
    if (!content) {
      return 0;
    }
    return Math.ceil(content.length / 4);
  }

  private broadcastTaskFailure(task: Task, sessionId: string | null, reason: string) {
    if (!sessionId || !this.shouldBroadcastTaskUpdate(task)) {
      return;
    }
    const workflowRole = this.getTaskWorkflowRole(task);
    const workflowPersona = this.getWorkflowPersonaFromRole(workflowRole, task.intent);
    this.services.message.sendMessage({
      id: `msg-${Date.now()}`,
      session_id: sessionId,
      agent_id: this.config.agent.id,
      message_type: 'warning',
      content: `任务失败：${reason}`,
      priority: 'high',
      tags: ['task_failure'],
      reply_to: null,
      references: [task.id],
      reference_type: 'task',
      reference_id: task.id,
      mentions: null,
      expires_at: null,
      category: 'agent_summary',
      visibility: 'blackboard',
      payload: {
        task_id: task.id,
        intent: task.intent,
        status: 'failed',
        workflow_role: workflowRole,
        workflow_role_persona: workflowPersona
      }
    });
  }

  private broadcastTaskSummary(task: Task, sessionId: string, summary: string) {
    const messageType = this.mapTaskIntentToMessageType(task.intent);
    const content = this.buildTaskSummaryContent(task, summary);
    const workflowRole = this.getTaskWorkflowRole(task);
    const workflowPersona = this.getWorkflowPersonaFromRole(workflowRole, task.intent);
    this.services.message.sendMessage({
      id: `msg-${Date.now()}`,
      session_id: sessionId,
      agent_id: this.config.agent.id,
      message_type: messageType,
      content,
      priority: 'medium',
      tags: [task.intent || 'task'],
      reply_to: null,
      references: [task.id],
      reference_type: 'task',
      reference_id: task.id,
      mentions: null,
      expires_at: null,
      category: 'agent_summary',
      visibility: 'blackboard',
      payload: {
        task_id: task.id,
        intent: task.intent,
        scope: task.scope,
        workflow_role: workflowRole,
        workflow_role_persona: workflowPersona
      }
    });
  }

  private buildTaskSummaryContent(task: Task, summary: string): string {
    const friendlyTitle = task.title || task.intent || task.id;
    const userFacingSummary = this.formatSummaryForBlackboard(summary);
    return `任务「${friendlyTitle}」已完成：\n${userFacingSummary}`;
  }

  private recordSystemEvent(sessionId: string, content: string, payload?: Record<string, any>) {
    this.services.message.sendMessage({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      agent_id: this.config.agent.id,
      message_type: 'system',
      content,
      priority: 'medium',
      tags: null,
      reply_to: null,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      category: 'system_event',
      visibility: 'event_log',
      payload: payload || null
    });
  }

  private mapTaskIntentToMessageType(intent?: string | null): MessageType {
    const normalized = (intent || '').toLowerCase();
    const mapping: Record<string, MessageType> = {
      clarify_requirement: 'requirement',
      analyze_requirement: 'requirement',
      requirement_analysis: 'requirement',
      create_architecture_plan: 'decision',
      architecture_plan: 'decision',
      plan_solution: 'decision',
      implement_requirement: 'discussion',
      implement_ui: 'discussion',
      implement_backend: 'discussion',
      deliver_requirement: 'decision',
      qa_signoff: 'decision',
      submit_verify_evidence: 'decision',
      release_approval: 'decision',
      handle_warning: 'warning',
      answer_question: 'question',
      evaluate_suggestion: 'suggestion'
    };
    return mapping[normalized] || 'discussion';
  }

  private formatSummaryForBlackboard(summary?: string | null): string {
    if (!summary) {
      return '- 任务已完成，等待下一步指示。';
    }
    let cleaned = summary;
    cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
    cleaned = cleaned.replace(/<\/?think>/gi, ' ');
    cleaned = cleaned.replace(/<[^>]+>/g, ' ');
    const segments = cleaned
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => !!line)
      .filter(line => !/^Tool:/i.test(line))
      .filter(line => !/^Observation:/i.test(line))
      .filter(line => !/^Step\s*\d+/i.test(line))
      .map(line => line.replace(/^[-*]\s*/, ''))
      .map(line => line.replace(/^\d+\.\s*/, ''))
      .map(line => line.length > 160 ? `${line.slice(0, 157)}…` : line);
    if (!segments.length) {
      return '- 任务已完成，等待下一步指示。';
    }
    return segments.slice(0, 4).map(line => `- ${line}`).join('\n');
  }

  private inferPersonaFromIntent(intent?: string | null): 'lead' | 'reviewer' | 'executor' | null {
    if (!intent) {
      return null;
    }
    const normalized = intent.toLowerCase();
    if (normalized.includes('clarify') || normalized.includes('plan') || normalized.includes('approve')) {
      return 'lead';
    }
    if (normalized.includes('review') || normalized.includes('qa') || normalized.includes('signoff')) {
      return 'reviewer';
    }
    if (
      normalized.includes('implement') ||
      normalized.includes('write') ||
      normalized.includes('execute') ||
      normalized.includes('fix') ||
      normalized.includes('run') ||
      normalized.includes('bug') ||
      normalized.includes('defect')
    ) {
      return 'executor';
    }
    return null;
  }

  private getTaskWorkflowRole(task: Task): string | null {
    if (!task || !Array.isArray(task.labels)) {
      return null;
    }
    for (const label of task.labels) {
      if (label.startsWith('workflow_role:')) {
        return label.replace('workflow_role:', '');
      }
    }
    return null;
  }

  private getWorkflowPersonaFromRole(role?: string | null, intent?: string | null): string | null {
    if (role) {
      const normalized = role.toLowerCase();
      if (ROLE_PERSONA_MAP[normalized]) {
        return ROLE_PERSONA_MAP[normalized];
      }
    }
    return this.inferPersonaFromIntent(intent);
  }

  private requestTaskTakeover(task: Task, sessionId: string | null, reason: string): boolean {
    const approvalService = this.services.approval;
    if (!approvalService) {
      return false;
    }
    const approval = approvalService.requestTaskTakeover(task, {
      reason: `任务执行失败，原因：${reason}`,
      requestedBy: this.config.agent.id,
      approverId: 'user'
    });
    if (!approval) {
      return false;
    }
    this.services.task.addTaskLabels(task.id, [`${AGENT_EXCLUDE_LABEL_PREFIX}${this.config.agent.id}`]);
    const friendlyTitle = task.title || task.intent || task.id;
    if (sessionId) {
      const workflowRole = this.getTaskWorkflowRole(task);
      const workflowPersona = this.getWorkflowPersonaFromRole(workflowRole, task.intent);
      this.services.message.sendMessage({
        id: `msg-${Date.now()}`,
        session_id: sessionId,
        agent_id: this.config.agent.id,
        message_type: 'warning',
        content: `任务「${friendlyTitle}」因 ${reason} 需要转派，已发起审批（#${approval.id}）`,
        priority: 'high',
        tags: ['task_takeover'],
        reply_to: null,
        references: [task.id],
        reference_type: 'task',
        reference_id: task.id,
        mentions: null,
        expires_at: null,
        category: 'agent_summary',
        visibility: 'blackboard',
        payload: {
          task_id: task.id,
          approval_id: approval.id,
          intent: task.intent,
          workflow_role: workflowRole,
          workflow_role_persona: workflowPersona
        }
      });
    }
    this.services.notification?.sendNotification({
      session_id: sessionId || 'global',
      level: 'warning',
      title: '任务转派审批',
      message: `任务「${friendlyTitle}」执行失败：${reason}。请审批是否改由其他 Agent 继续。`,
      metadata: {
        approval_id: approval.id,
        ...this.buildTaskNotificationMetadata(task)
      }
    });
    return true;
  }

  private extractWorkflowInstanceId(task?: Task | null): string | null {
    if (!task || !Array.isArray(task.labels)) {
      return null;
    }
    const label = task.labels.find(item => typeof item === 'string' && item.startsWith('workflow_instance:'));
    return label ? label.replace('workflow_instance:', '') : null;
  }

  private buildTaskNotificationMetadata(task?: Task | null): Record<string, any> {
    const metadata: Record<string, any> = {};
    if (task) {
      metadata.task_id = task.id;
      if (task.session_id) {
        metadata.session_id = task.session_id;
      }
    }
    const instanceId = this.extractWorkflowInstanceId(task);
    if (instanceId) {
      metadata.workflow_instance_id = instanceId;
    }
    return metadata;
  }

  private getPrimaryRole(): AgentRole {
    const roles = this.config.agent.roles;
    if (roles && roles.length > 0) {
      return roles[0];
    }
    return 'developer';
  }
}
