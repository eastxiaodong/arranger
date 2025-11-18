// Agent 服务

import { DatabaseManager } from '../../core/database';
import { GlobalConfigDatabase } from '../../core/database/global-config.database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { Agent, AgentHealthRecord, AgentHealthStatus } from '../../core/types';
import type { StateStore } from '../state';

export class AgentService {
  constructor(
    private globalDb: GlobalConfigDatabase,
    private projectDb: DatabaseManager,
    private events: TypedEventEmitter,
    private readonly state?: StateStore
  ) {
    this.syncAllAgentHealth();
  }

  // 获取所有 Agent
  getAllAgents(): Agent[] {
    return this.globalDb.getAllAgents();
  }

  // 获取单个 Agent
  getAgent(id: string): Agent | null {
    return this.globalDb.getAgent(id);
  }

  // 创建 Agent
  createAgent(agent: Omit<Agent, 'created_at'> & { is_enabled?: boolean }): Agent {
    const normalized: Omit<Agent, 'created_at'> = {
      ...agent,
      is_enabled: agent.is_enabled !== false,
      capabilities: agent.capabilities ?? [],
      capability_tags: agent.capability_tags ?? agent.capabilities ?? [],
      reasoning_tier: typeof agent.reasoning_tier === 'number' ? agent.reasoning_tier : 5,
      cost_factor: agent.cost_factor ?? 1,
      tool_permissions: Array.isArray(agent.tool_permissions) ? agent.tool_permissions : [],
      metrics: agent.metrics ?? null,
      notes: agent.notes ?? null
    };
    const created = this.globalDb.createAgent(normalized);
    this.syncAgentHealth(created);
    this.broadcastAgents();
    return created;
  }

  // 更新 Agent
  updateAgent(id: string, updates: Partial<Agent>): void {
    this.globalDb.updateAgent(id, updates);
    const updated = this.globalDb.getAgent(id);
    if (updated) {
      this.syncAgentHealth(updated);
    }
    this.broadcastAgents();
  }

  setAgentEnabled(id: string, enabled: boolean): void {
    this.globalDb.updateAgent(id, { is_enabled: enabled });
    const updated = this.globalDb.getAgent(id);
    if (updated) {
      this.syncAgentHealth(updated);
    }
    this.broadcastAgents();
  }

  // 删除 Agent
  deleteAgent(id: string): void {
    this.globalDb.deleteAgent(id);
    this.state?.deleteAgentHealth(id);
    this.broadcastAgents();
  }

  // 获取在线且配置了 LLM 的 Agent
  getOnlineLLMAgents(): Agent[] {
    return this.globalDb.getAllAgents().filter(agent => {
      const hasLLM = !!agent.llm_provider && !!agent.llm_model && !!agent.llm_api_key;
      return agent.is_enabled !== false && agent.status === 'online' && hasLLM;
    });
  }

  // 根据能力标签获取 Agent
  getAgentsByCapability(tag: string): Agent[] {
    const lower = tag.toLowerCase();
    return this.globalDb.getAllAgents().filter(agent => {
      const hasLLM = !!agent.llm_provider && !!agent.llm_model && !!agent.llm_api_key;
      const hasCapability = (agent.capability_tags || agent.capabilities || []).some(cap => cap.toLowerCase() === lower);
      return agent.is_enabled !== false && agent.status === 'online' && hasLLM && hasCapability;
    });
  }

  // 获取负载最低的 Agent
  getLeastLoadedAgent(agents: Agent[]): Agent | null {
    if (!agents || agents.length === 0) {
      return null;
    }

    const relevantStatuses = new Set(['pending', 'assigned', 'running', 'blocked']);
    const tasks = this.projectDb.getTasks({});
    const loadMap = new Map<string, number>();
    tasks.forEach(task => {
      if (task.assigned_to && relevantStatuses.has(task.status)) {
        loadMap.set(task.assigned_to, (loadMap.get(task.assigned_to) || 0) + 1);
      }
    });

    const filtered = agents.filter(agent => agent.is_enabled !== false);
    if (filtered.length === 0) {
      return null;
    }

    const sorted = [...filtered].sort((a, b) => {
      const statusWeight = (agent: Agent) => {
        if (agent.status === 'online') return 0;
        if (agent.status === 'busy') return 1;
        return 2;
      };
      const loadA = loadMap.get(a.id) || 0;
      const loadB = loadMap.get(b.id) || 0;
      if (loadA !== loadB) {
        return loadA - loadB;
      }
      const statusDiff = statusWeight(a) - statusWeight(b);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return (a.status_updated_at || 0) - (b.status_updated_at || 0);
    });

    return sorted[0];
  }

  // 更新心跳
  updateHeartbeat(id: string): void {
    this.globalDb.updateAgent(id, {
      last_heartbeat_at: Date.now()
    });
    const updated = this.globalDb.getAgent(id);
    if (updated) {
      this.syncAgentHealth(updated);
    }
    this.broadcastAgents();
  }

  // 更新状态
  updateStatus(id: string, status: Agent['status'], detail?: string, eta?: number): void {
    this.globalDb.updateAgent(id, {
      status,
      status_detail: detail || null,
      status_eta: eta || null,
      status_updated_at: Date.now()
    });
    const updated = this.globalDb.getAgent(id);
    if (updated) {
      this.syncAgentHealth(updated);
    }
    this.broadcastAgents();
  }

  // 更新 Agent 状态（别名方法）
  updateAgentStatus(id: string, updates: {
    status?: Agent['status'];
    status_detail?: string | null;
    status_eta?: number | null;
    active_task_id?: string | null;
  }): void {
    this.globalDb.updateAgent(id, {
      ...updates,
      status_updated_at: Date.now()
    });
    const updated = this.globalDb.getAgent(id);
    if (updated) {
      this.syncAgentHealth(updated);
    }
    this.broadcastAgents();
  }

  private broadcastAgents() {
    this.events.emit('agents_update', this.globalDb.getAllAgents());
  }

  markAgentOffline(id: string, reason?: string) {
    this.updateAgentStatus(id, {
      status: 'offline',
      status_detail: reason || '自动标记为离线',
      active_task_id: null
    });
  }

  private mapHealthStatus(agent: Agent): AgentHealthStatus {
    if (agent.is_enabled === false || agent.status === 'offline') {
      return 'offline';
    }
    if (agent.status === 'busy') {
      return 'degraded';
    }
    return 'healthy';
  }

  private computeErrorRate(agent: Agent, completed: number, failed: number): number {
    const total = completed + failed;
    if (total > 0) {
      return failed / total;
    }
    if (typeof agent.metrics?.success_rate === 'number') {
      return Math.max(0, 1 - agent.metrics.success_rate);
    }
    return 0;
  }

  private syncAgentHealth(agent: Agent) {
    if (!this.state) {
      return;
    }
    const tasks = this.projectDb.getTasks({ assigned_to: agent.id });
    const activeStatuses = new Set(['pending', 'queued', 'assigned', 'running', 'blocked', 'paused']);
    const activeTaskCount = tasks.filter(task => activeStatuses.has(task.status)).length;
    const completedTaskCount = tasks.filter(task => task.status === 'completed').length;
    const failedTaskCount = tasks.filter(task => task.status === 'failed').length;
    const health: AgentHealthRecord = {
      agentId: agent.id,
      status: this.mapHealthStatus(agent),
      lastHeartbeat: agent.last_heartbeat_at || Date.now(),
      activeTaskCount,
      completedTaskCount,
      failedTaskCount,
      avgResponseTime: agent.metrics?.average_response_ms ?? 0,
      errorRate: this.computeErrorRate(agent, completedTaskCount, failedTaskCount),
      capabilities: (agent.capability_tags || agent.capabilities || []) as string[],
      metadata: {
        display_name: agent.display_name,
        status_detail: agent.status_detail,
        status_eta: agent.status_eta,
        metrics: agent.metrics || null
      },
      updatedAt: Date.now()
    };
    this.state.updateAgentHealth(agent.id, health);
  }

  private syncAllAgentHealth() {
    if (!this.state) {
      return;
    }
    this.globalDb.getAllAgents().forEach(agent => this.syncAgentHealth(agent));
  }
}
