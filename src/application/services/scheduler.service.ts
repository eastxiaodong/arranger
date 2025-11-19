import type { OutputChannel } from 'vscode';
import type { AgentService } from '../../domain/agent/agent.service';
import type { TaskService } from '../../domain/task/task.service';
import type { StateStore } from '../../domain/state';
import type { TypedEventEmitter } from '../../core/events/emitter';
import type { Agent, TaskStateRecord, AgentHealthRecord } from '../../core/types';

interface SchedulingContext {
  taskId: string;
  taskState: TaskStateRecord;
  availableAgents: Agent[];
  agentHealthMap: Map<string, AgentHealthRecord>;
}

interface ScoringWeights {
  sceneMatch: number;
  reasoningFit: number;
  loadBalance: number;
  successRate: number;
  costOptimization: number;
}

interface AgentScore {
  agentId: string;
  agent: Agent;
  score: number;
  breakdown: {
    sceneMatch: number;
    reasoningFit: number;
    loadBalance: number;
    successRate: number;
    costOptimization: number;
  };
  reasoning: string;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  sceneMatch: 0.35,
  reasoningFit: 0.25,
  loadBalance: 0.20,
  successRate: 0.15,
  costOptimization: 0.05
};

/**
 * 调度器服务：负责任务分配和Agent评分
 * 
 * 核心职责：
 * 1. 根据任务特征和Agent能力进行匹配评分
 * 2. 考虑Agent当前负载和健康状态
 * 3. 支持动态权重调整
 * 4. 提供降级和重新分配机制
 */
export class SchedulerService {
  private readonly weights: ScoringWeights = { ...DEFAULT_WEIGHTS };
  private readonly taskAssignmentHistory = new Map<string, string[]>();
  private readonly agentLoadMap = new Map<string, number>();

  constructor(
    private readonly agentService: AgentService,
    private readonly taskService: TaskService,
    private readonly state: StateStore,
    private readonly events: TypedEventEmitter,
    private readonly output: OutputChannel
  ) {
    this.initializeLoadTracking();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.events.on('state:task_transitioned', ({ taskState, transition }) => {
      if (transition.to === 'active' && taskState.assignedTo) {
        this.recordAssignment(taskState.taskId, taskState.assignedTo);
      } else if ((transition.to === 'done' || transition.to === 'failed') && taskState.assignedTo) {
        this.recordCompletion(taskState.taskId, taskState.assignedTo);
      }
    });
  }

  /**
   * 尝试为任务选择最佳 Agent 并指派（无效则保持原状）
   */
  tryAssignBestAgent(task: TaskStateRecord): AgentScore | null {
    const availableAgents = this.agentService.getOnlineLLMAgents();
    if (!availableAgents.length) {
      return null;
    }
    const healthMap = new Map<string, AgentHealthRecord>();
    this.state.queryAgentHealth({}).forEach(h => healthMap.set(h.agentId, h));
    const context: SchedulingContext = {
      taskId: task.taskId,
      taskState: task,
      availableAgents,
      agentHealthMap: healthMap
    };
    const best = this.selectBestAgent(context);
    if (best) {
      this.taskService.updateTask(task.taskId, {
        assigned_to: best.agentId,
        status: 'assigned'
      });
      this.events.emit('tasks_update', this.taskService.getAllTasks({}));
    }
    return best;
  }

  /**
   * 为任务选择最佳Agent
   */
  selectBestAgent(context: SchedulingContext): AgentScore | null {
    const scores = this.scoreAllAgents(context);

    if (scores.length === 0) {
      this.output.appendLine('[Scheduler] 没有可用的Agent');
      return null;
    }

    // 按分数排序，返回最高分的Agent
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];

    this.output.appendLine(
      `[Scheduler] 为任务 ${context.taskId} 选择Agent ${best.agentId}，分数：${best.score.toFixed(2)}`
    );

    return best;
  }

  /**
   * 为所有可用Agent评分
   */
  private scoreAllAgents(context: SchedulingContext): AgentScore[] {
    return context.availableAgents
      .map(agent => this.scoreAgent(agent, context))
      .filter((score): score is AgentScore => score !== null);
  }

  /**
   * 为单个Agent评分
   */
  private scoreAgent(agent: Agent, context: SchedulingContext): AgentScore | null {
    const health = context.agentHealthMap.get(agent.id);

    // 如果Agent离线或不可用，跳过
    if (health && (health.status === 'offline' || health.status === 'degraded')) {
      return null;
    }

    const breakdown = {
      sceneMatch: this.scoreSceneMatch(agent, context.taskState),
      reasoningFit: this.scoreReasoningFit(agent, context.taskState),
      loadBalance: this.scoreLoadBalance(agent, health),
      successRate: this.scoreSuccessRate(agent),
      costOptimization: this.scoreCostOptimization(agent)
    };

    const score =
      breakdown.sceneMatch * this.weights.sceneMatch +
      breakdown.reasoningFit * this.weights.reasoningFit +
      breakdown.loadBalance * this.weights.loadBalance +
      breakdown.successRate * this.weights.successRate +
      breakdown.costOptimization * this.weights.costOptimization;

    const reasoning = this.buildScoringReasoning(agent, breakdown, context.taskState);

    return {
      agentId: agent.id,
      agent,
      score,
      breakdown,
      reasoning
    };
  }

  /**
   * 场景匹配评分（0-100）
   * 根据Agent的能力标签和任务类型匹配
   */
  private scoreSceneMatch(agent: Agent, taskState: TaskStateRecord): number {
    const taskLabels = taskState.labels || [];
    const agentCapabilities = agent.capabilities || [];

    if (taskLabels.length === 0 || agentCapabilities.length === 0) {
      return 50; // 默认中等匹配
    }

    const matchCount = taskLabels.filter(label =>
      agentCapabilities.some(cap => this.labelMatches(label, cap))
    ).length;

    return Math.min(100, (matchCount / taskLabels.length) * 100);
  }

  /**
   * 推理能力适配评分（0-100）
   * 根据任务难度和Agent的推理档位匹配
   */
  private scoreReasoningFit(agent: Agent, taskState: TaskStateRecord): number {
    const difficulty = this.extractDifficulty(taskState.labels);
    const agentReasoningTier = agent.reasoning_tier || 5; // 默认中等推理能力

    const difficultyMap: Record<string, number> = {
      'low': 1,
      'medium': 5,
      'high': 8
    };

    const difficultyScore = difficultyMap[difficulty] || 5;

    // 推理能力应该 >= 任务难度
    if (agentReasoningTier >= difficultyScore) {
      return 100 - Math.abs(agentReasoningTier - difficultyScore) * 5;
    } else {
      return Math.max(0, 50 - (difficultyScore - agentReasoningTier) * 10);
    }
  }

  /**
   * 负载均衡评分（0-100）
   * 考虑Agent当前的任务负载
   */
  private scoreLoadBalance(agent: Agent, health: AgentHealthRecord | undefined): number {
    const currentLoad = this.agentLoadMap.get(agent.id) || 0;
    const maxLoad = 10; // 假设每个Agent最多处理10个并发任务

    if (currentLoad >= maxLoad) {
      return 0; // 已满载
    }

    const loadRatio = currentLoad / maxLoad;
    const baseScore = 100 * (1 - loadRatio);

    // 如果Agent健康状态良好，加分
    if (health && health.status === 'healthy') {
      return Math.min(100, baseScore + 10);
    }

    return baseScore;
  }

  /**
   * 成功率评分（0-100）
   * 基于Agent的历史成功率
   */
  private scoreSuccessRate(agent: Agent): number {
    // 从Agent的metrics中获取成功率
    const successRate = agent.metrics?.success_rate || 0.8;
    return Math.min(100, successRate * 100);
  }

  /**
   * 成本优化评分（0-100）
   * 考虑Agent的成本系数
   */
  private scoreCostOptimization(agent: Agent): number {
    const costFactor = agent.cost_factor || 1.0;

    // 成本系数越低越好
    if (costFactor <= 0.5) {
      return 100;
    } else if (costFactor <= 1.0) {
      return 100 - (costFactor - 0.5) * 100;
    } else {
      return Math.max(0, 100 - (costFactor - 1.0) * 50);
    }
  }

  /**
   * 标签匹配逻辑
   */
  private labelMatches(taskLabel: string, capability: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
    return normalize(taskLabel) === normalize(capability) ||
      taskLabel.includes(capability) ||
      capability.includes(taskLabel);
  }

  /**
   * 从标签中提取难度
   */
  private extractDifficulty(labels: string[] | null): string {
    if (!labels) return 'medium';

    const diffLabel = labels.find(l => l.startsWith('difficulty:'));
    if (diffLabel) {
      return diffLabel.replace('difficulty:', '');
    }

    return 'medium';
  }

  /**
   * 构建评分理由
   */
  private buildScoringReasoning(agent: Agent, breakdown: AgentScore['breakdown'], taskState: TaskStateRecord): string {
    const parts: string[] = [];

    parts.push(`Agent: ${agent.id}`);
    parts.push(`场景匹配: ${breakdown.sceneMatch.toFixed(1)}/100`);
    parts.push(`推理适配: ${breakdown.reasoningFit.toFixed(1)}/100`);
    parts.push(`负载均衡: ${breakdown.loadBalance.toFixed(1)}/100`);
    parts.push(`成功率: ${breakdown.successRate.toFixed(1)}/100`);
    parts.push(`成本优化: ${breakdown.costOptimization.toFixed(1)}/100`);

    return parts.join(' | ');
  }

  /**
   * 更新权重
   */
  updateWeights(weights: Partial<ScoringWeights>): void {
    Object.assign(this.weights, weights);

    // 验证权重总和为1
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      this.output.appendLine(`[Scheduler] 警告：权重总和为 ${sum.toFixed(2)}，应为 1.0`);
    }

    this.output.appendLine(`[Scheduler] 权重已更新: ${JSON.stringify(this.weights)}`);
  }

  /**
   * 记录任务分配
   */
  recordAssignment(taskId: string, agentId: string): void {
    if (!this.taskAssignmentHistory.has(taskId)) {
      this.taskAssignmentHistory.set(taskId, []);
    }

    const history = this.taskAssignmentHistory.get(taskId)!;
    history.push(agentId);

    // 更新Agent负载
    const currentLoad = this.agentLoadMap.get(agentId) || 0;
    this.agentLoadMap.set(agentId, currentLoad + 1);

    // this.output.appendLine(`[Scheduler] 任务 ${taskId} 已分配给 ${agentId}`);
  }

  /**
   * 记录任务完成
   */
  recordCompletion(taskId: string, agentId: string): void {
    const currentLoad = this.agentLoadMap.get(agentId) || 0;
    if (currentLoad > 0) {
      this.agentLoadMap.set(agentId, currentLoad - 1);
    }

    // this.output.appendLine(`[Scheduler] 任务 ${taskId} 已完成，${agentId} 负载减少`);
  }

  /**
   * 获取Agent当前负载
   */
  getAgentLoad(agentId: string): number {
    return this.agentLoadMap.get(agentId) || 0;
  }

  /**
   * 获取所有Agent的负载
   */
  getAllAgentLoads(): Map<string, number> {
    return new Map(this.agentLoadMap);
  }

  /**
   * 初始化负载追踪
   */
  private initializeLoadTracking(): void {
    const agents = this.agentService.getAllAgents();
    agents.forEach(agent => {
      this.agentLoadMap.set(agent.id, 0);
    });
  }

  /**
   * 重置负载追踪
   */
  resetLoadTracking(): void {
    this.agentLoadMap.clear();
    this.initializeLoadTracking();
  }
}
