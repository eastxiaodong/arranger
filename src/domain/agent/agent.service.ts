// Agent 服务

import { DatabaseManager } from '../../core/database';
import { GlobalConfigDatabase } from '../../core/database/global-config.database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { Agent } from '../../core/types';

export class AgentService {
  constructor(
    private globalDb: GlobalConfigDatabase,
    private projectDb: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

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
    this.broadcastAgents();
    return created;
  }

  // 更新 Agent
  updateAgent(id: string, updates: Partial<Agent>): void {
    this.globalDb.updateAgent(id, updates);
    this.broadcastAgents();
  }

  setAgentEnabled(id: string, enabled: boolean): void {
    this.globalDb.updateAgent(id, { is_enabled: enabled });
    this.broadcastAgents();
  }

  // 删除 Agent
  deleteAgent(id: string): void {
    this.globalDb.deleteAgent(id);
    this.broadcastAgents();
  }

  // 获取在线且配置了 LLM 的 Agent
  getOnlineLLMAgents(): Agent[] {
    return this.globalDb.getAllAgents().filter(agent => {
      const hasLLM = !!agent.llm_provider && !!agent.llm_api_key;
      return agent.is_enabled !== false && agent.status === 'online' && hasLLM;
    });
  }

  // 根据能力标签获取 Agent
  getAgentsByCapability(tag: string): Agent[] {
    const lower = tag.toLowerCase();
    return this.globalDb.getAllAgents().filter(agent =>
      agent.is_enabled !== false &&
      (agent.capability_tags || agent.capabilities || []).some(cap => cap.toLowerCase() === lower)
    );
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
}
