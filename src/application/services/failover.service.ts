import type { OutputChannel } from 'vscode';
import type { AgentService } from '../../domain/agent/agent.service';
import type { TaskService } from '../../domain/task/task.service';
import type { StateStore } from '../../domain/state';
import type { TypedEventEmitter } from '../../core/events/emitter';
import type { Agent, TaskStateRecord, AgentHealthRecord } from '../../core/types';
import type { NotificationService } from '../../domain/communication/notification.service';
import type { MessageService } from '../../domain/communication/message.service';

interface FailoverContext {
  taskId: string;
  taskState: TaskStateRecord;
  failedAgentId: string;
  failureReason: string;
  availableAgents: Agent[];
  agentHealthMap: Map<string, AgentHealthRecord>;
}

interface ManagerPoolConfig {
  managers: string[]; // Manager Agent IDs
  currentIndex: number;
  rotationInterval: number; // 每N个任务后轮换
  taskCountSinceRotation: number;
}

/**
 * 故障降级和经理池轮值服务
 * 
 * 核心职责：
 * 1. 监控Agent健康状态
 * 2. 触发自动降级流程
 * 3. 管理经理池轮值
 * 4. 处理任务重新分配
 */
export class FailoverService {
  private managerPool: ManagerPoolConfig = {
    managers: [],
    currentIndex: 0,
    rotationInterval: 10,
    taskCountSinceRotation: 0
  };

  private readonly failureThresholds = {
    errorCountThreshold: 5,
    errorRateThreshold: 0.3, // 30%
    heartbeatTimeoutMs: 30000 // 30秒
  };

  constructor(
    private readonly agentService: AgentService,
    private readonly taskService: TaskService,
    private readonly state: StateStore,
    private readonly events: TypedEventEmitter,
    private readonly output: OutputChannel,
    private readonly notificationService?: NotificationService,
    private readonly messageService?: MessageService
  ) {
    this.initializeManagerPool();
  }

  start() {
    this.events.on('state:agent_health_updated', (health: AgentHealthRecord) => {
      this.handleAgentHealthChange(health);
    });
    this.events.on('state:task_transitioned', ({ taskState }: { taskState: TaskStateRecord }) => {
      if (taskState.assignedTo) {
        this.managerPool.taskCountSinceRotation += 1;
        if (this.shouldRotateManager()) {
          this.rotateManager('轮值阈值已达');
        }
      }
    });
  }

  private handleAgentHealthChange(health: AgentHealthRecord) {
    if (health.status === 'offline' || health.status === 'unhealthy') {
      const reason = health.status === 'offline' ? '离线' : '健康异常';
      const affected = this.taskService.reassignTasksForAgent(health.agentId, reason);
      if (affected > 0) {
        this.output.appendLine(`[Failover] Agent ${health.agentId} ${reason}，已回队 ${affected} 个任务等待重指派`);
      }
      if (this.isCurrentManager(health.agentId)) {
        const rotated = this.rotateManager(`当前经理 ${health.agentId} ${reason}`);
        if (rotated) {
          this.notifyManagerSwitch(health.agentId, rotated, reason);
        }
      }
    }

    if (this.shouldDegradeAgent(health) && health.status !== 'degraded') {
      this.state.updateAgentHealth(health.agentId, { status: 'degraded' });
      this.output.appendLine(`[Failover] Agent ${health.agentId} 标记为降级（错误率/心跳异常）`);
    }
  }

  /**
   * 初始化经理池
   */
  private initializeManagerPool(): void {
    const agents = this.agentService.getAllAgents();
    // 选择coordinator角色作为经理，或者所有在线的Agent
    const managers = agents.filter(a => 
      a.roles?.includes('coordinator') || 
      (a.is_enabled && a.status === 'online')
    );
    
    this.managerPool.managers = managers.map(m => m.id);
    this.managerPool.currentIndex = 0;

    this.output.appendLine(
      `[Failover] 初始化经理池，共 ${this.managerPool.managers.length} 个经理`
    );
  }

  /**
   * 获取当前活跃的经理
   */
  getCurrentManager(): string | null {
    if (this.managerPool.managers.length === 0) {
      return null;
    }

    const currentManager = this.managerPool.managers[this.managerPool.currentIndex];
    return currentManager;
  }

  /**
   * 轮换经理
   */
  rotateManager(reason?: string): string | null {
    if (this.managerPool.managers.length === 0) {
      return null;
    }

    const oldIndex = this.managerPool.currentIndex;
    this.managerPool.currentIndex = (this.managerPool.currentIndex + 1) % this.managerPool.managers.length;
    this.managerPool.taskCountSinceRotation = 0;

    const oldManager = this.managerPool.managers[oldIndex];
    const newManager = this.managerPool.managers[this.managerPool.currentIndex];

    this.output.appendLine(
      `[Failover] 经理轮换：${oldManager} → ${newManager}${reason ? `（${reason}）` : ''}`
    );

    return newManager;
  }

  private isCurrentManager(agentId: string): boolean {
    return this.managerPool.managers[this.managerPool.currentIndex] === agentId;
  }

  private notifyManagerSwitch(oldManager: string, newManager: string, reason?: string) {
    const message = `经理切换：${oldManager} → ${newManager}${reason ? `（${reason}）` : ''}`;
    this.notificationService?.sendNotification({
      session_id: 'global',
      level: 'warning',
      title: '经理已切换',
      message,
      metadata: { old_manager: oldManager, new_manager: newManager, reason }
    });
    this.messageService?.sendMessage({
      id: `mgr_switch_${Date.now()}`,
      session_id: 'global',
      agent_id: 'failover',
      content: message,
      priority: 'medium',
      tags: ['manager', 'failover'],
      reply_to: null,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      category: 'system_event',
      visibility: 'blackboard',
      payload: { old_manager: oldManager, new_manager: newManager, reason }
    });
  }

  /**
   * 检查是否需要轮换经理
   */
  shouldRotateManager(): boolean {
    return this.managerPool.taskCountSinceRotation >= this.managerPool.rotationInterval;
  }

  /**
   * 记录任务分配给经理
   */
  recordManagerAssignment(): void {
    this.managerPool.taskCountSinceRotation++;
  }

  /**
   * 检查Agent是否应该降级
   */
  shouldDegradeAgent(health: AgentHealthRecord): boolean {
    if (health.status === 'offline' || health.status === 'degraded') {
      return false; // 已经降级
    }

    // 检查错误计数
    if (health.failedTaskCount >= this.failureThresholds.errorCountThreshold) {
      return true;
    }

    // 检查错误率
    const totalRuns = health.completedTaskCount + health.failedTaskCount || 1;
    const errorRate = health.failedTaskCount / totalRuns;
    if (errorRate >= this.failureThresholds.errorRateThreshold) {
      return true;
    }

    // 检查心跳超时
    const lastHeartbeat = health.lastHeartbeat || 0;
    const timeSinceHeartbeat = Date.now() - lastHeartbeat;
    if (timeSinceHeartbeat > this.failureThresholds.heartbeatTimeoutMs) {
      return true;
    }

    return false;
  }

  /**
   * 执行故障降级
   */
  async performFailover(context: FailoverContext): Promise<string | null> {
    this.output.appendLine(
      `[Failover] 开始故障降级：任务 ${context.taskId}，失败Agent ${context.failedAgentId}，原因：${context.failureReason}`
    );

    // 1. 更新任务状态为 reassigning
    const taskState = this.state.transitionTaskState(
      context.taskId,
      'reassigning',
      `Agent ${context.failedAgentId} 故障：${context.failureReason}`,
      'failover_service'
    );

    if (!taskState) {
      this.output.appendLine(`[Failover] 任务 ${context.taskId} 不存在`);
      return null;
    }

    // 2. 从可用Agent中选择替代Agent
    const alternativeAgent = this.selectAlternativeAgent(context);

    if (!alternativeAgent) {
      // 3a. 如果没有可用Agent，标记任务为阻塞
      this.state.transitionTaskState(
        context.taskId,
        'blocked',
        '无可用Agent接手任务',
        'failover_service'
      );

      this.output.appendLine(
        `[Failover] 任务 ${context.taskId} 无可用Agent，已标记为阻塞`
      );

      this.output.appendLine(
        `[Failover] 事件：无可用Agent接手任务 ${context.taskId}`
      );

      return null;
    }

    // 3b. 重新分配任务给替代Agent
    const updated = this.state.updateTaskState(context.taskId, {
      assignedTo: alternativeAgent.id
    });

    if (updated) {
      this.state.transitionTaskState(
        context.taskId,
        'active',
        `已由 ${alternativeAgent.id} 接手`,
        'failover_service'
      );

      this.output.appendLine(
        `[Failover] 任务 ${context.taskId} 已重新分配给 ${alternativeAgent.id}`
      );

      this.output.appendLine(
        `[Failover] 事件：任务已重新分配 ${context.taskId} → ${alternativeAgent.id}`
      );

      return alternativeAgent.id;
    }

    return null;
  }

  /**
   * 选择替代Agent
   */
  private selectAlternativeAgent(context: FailoverContext): Agent | null {
    // 过滤掉失败的Agent和不可用的Agent
    const candidates = context.availableAgents.filter(agent => {
      if (agent.id === context.failedAgentId) {
        return false;
      }

      const health = context.agentHealthMap.get(agent.id);
      if (health && (health.status === 'offline' || health.status === 'degraded')) {
        return false;
      }

      const hasLLM = !!agent.llm_provider && !!agent.llm_model && !!agent.llm_api_key;
      if (!agent.is_enabled || agent.status === 'offline' || !hasLLM) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    // 选择负载最低的Agent
    let bestAgent = candidates[0];
    let minLoad = this.getAgentLoad(bestAgent.id);

    for (const agent of candidates.slice(1)) {
      const load = this.getAgentLoad(agent.id);
      if (load < minLoad) {
        bestAgent = agent;
        minLoad = load;
      }
    }

    return bestAgent;
  }

  /**
   * 获取Agent负载（简化版，实际应该从SchedulerService获取）
   */
  private getAgentLoad(agentId: string): number {
    const taskStates = this.state.queryTaskStates({ assignedTo: agentId });
    return taskStates.filter(t => t.state === 'active' || t.state === 'pending').length;
  }

  /**
   * 更新故障阈值
   */
  updateFailureThresholds(thresholds: Partial<typeof this.failureThresholds>): void {
    Object.assign(this.failureThresholds, thresholds);
    this.output.appendLine(
      `[Failover] 故障阈值已更新: ${JSON.stringify(this.failureThresholds)}`
    );
  }

  /**
   * 更新经理池轮换间隔
   */
  setManagerRotationInterval(interval: number): void {
    this.managerPool.rotationInterval = interval;
    this.output.appendLine(
      `[Failover] 经理池轮换间隔已更新为 ${interval} 个任务`
    );
  }

  /**
   * 获取经理池配置
   */
  getManagerPoolConfig(): ManagerPoolConfig {
    return { ...this.managerPool };
  }

  /**
   * 获取所有经理
   */
  getManagers(): string[] {
    return [...this.managerPool.managers];
  }

  /**
   * 手动指定经理
   */
  setCurrentManager(managerId: string): boolean {
    const index = this.managerPool.managers.indexOf(managerId);
    if (index === -1) {
      this.output.appendLine(`[Failover] 经理 ${managerId} 不在池中`);
      return false;
    }

    this.managerPool.currentIndex = index;
    this.output.appendLine(`[Failover] 当前经理已设置为 ${managerId}`);

    return true;
  }

  /**
   * 运行健康检查
   */
  runHealthCheck(agentHealthMap: Map<string, AgentHealthRecord>): void {
    const degradedAgents: string[] = [];

    agentHealthMap.forEach((health, agentId) => {
      if (this.shouldDegradeAgent(health)) {
        degradedAgents.push(agentId);
      }
    });

    if (degradedAgents.length > 0) {
      this.output.appendLine(
        `[Failover] 检测到 ${degradedAgents.length} 个降级Agent：${degradedAgents.join(', ')}`
      );
    }
  }

  /**
   * 恢复Agent
   */
  recoverAgent(agentId: string): void {
    const agent = this.agentService.getAgent(agentId);
    if (!agent) {
      return;
    }

    this.output.appendLine(`[Failover] Agent ${agentId} 已恢复`);
  }
}
