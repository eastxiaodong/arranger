// 事件系统 - 替代 WebSocket 的实时更新机制

import { EventEmitter } from 'events';
import type {
  Agent,
  Task,
  BlackboardEntry,
  Topic,
  Approval,
  Notification,
  AutomationPolicy,
  FileChange,
  GovernanceHistoryEntry,
  MCPServer,
  ThinkingLog,
  Session,
  TaskMetrics,
  ProofRecord,
  TaskBacklogSummary,
  ToolRun
} from '../types';
import type { WorkflowInstanceSummary, WorkflowRuntimeEvent } from '../workflow';
import type { SchedulerEventPayload, SentinelEventPayload } from '../orchestration/orchestration-types';

// 事件类型映射
export interface EventMap {
  'agents_update': Agent[];
  'tasks_update': Task[];
  'messages_update': BlackboardEntry[];
  'votes_update': Topic[];
  'approvals_update': Approval[];
  'notifications_update': Notification[];
  'policies_update': AutomationPolicy[];
  'file_changes_update': FileChange[];
  'governance_history_update': GovernanceHistoryEntry[];
  'mcp_servers_update': MCPServer[];
  'thinking_logs_update': ThinkingLog[];
  'sessions_update': Session[];
  'task_metrics_update': TaskMetrics;
  'task_backlog_update': TaskBacklogSummary[];
  'llm_stream_update': {
    session_id: string | null;
    task_id?: string | null;
    agent_id?: string | null;
    status: 'stream' | 'done' | 'error';
    content?: string;
    delta?: string;
    error?: string;
    source?: 'thinking' | 'chat' | 'system';
    timestamp: number;
  };
  'mcp_server_status': {
    serverId: number;
    available: boolean;
    error?: string | null;
    toolCount?: number | null;
  };
  'workflow_instances_update': WorkflowInstanceSummary[];
  'workflow_event': WorkflowRuntimeEvent;
  'scheduler_event': SchedulerEventPayload;
  'sentinel_event': SentinelEventPayload;
  'proof_records_update': ProofRecord[];
  'proof_attested': ProofRecord;
  'workflow_template_update': {
    id: string;
    name: string;
    description?: string;
    metadata?: Record<string, any>;
  };
  'message_posted': BlackboardEntry;
  'task_completed': Task;
  'tool_runs_update': ToolRun[];
}

// 类型安全的事件发射器
export class TypedEventEmitter {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50); // 增加监听器限制
  }

  // 发射事件
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }

  // 监听事件
  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  // 监听一次
  once<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.once(event, listener);
  }

  // 移除监听器
  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  // 移除所有监听器
  removeAllListeners(event?: keyof EventMap): void {
    this.emitter.removeAllListeners(event);
  }
}
