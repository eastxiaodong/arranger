// 事件系统 - 替代 WebSocket 的实时更新机制

import { EventEmitter } from 'events';
import type {
  Agent,
  Task,
  BlackboardEntry,
  Notification,
  AutomationPolicy,
  FileChange,
  MCPServer,
  ThinkingLog,
  Session,
  TaskMetrics,
  TaskBacklogSummary,
  ToolRun,
  ManagerLLMConfig
} from '../types';


// 事件类型映射
export interface EventMap {
  'agents_update': Agent[];
  'tasks_update': Task[];
  'messages_update': BlackboardEntry[];
  'notifications_update': Notification[];
  'policies_update': AutomationPolicy[];
  'file_changes_update': FileChange[];
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
  'message_posted': BlackboardEntry;
  'task_completed': Task;
  'tool_runs_update': ToolRun[];
  // 状态编排层事件
  'state:task_created': any;
  'state:task_transitioned': any;
  'state:task_updated': any;
  'state:task_deleted': string;
  'state:assist_created': any;
  'state:assist_updated': any;
  'state:assist_deleted': string;
  'state:agent_health_updated': any;
  'state:agent_health_deleted': string;
  'state:tool_run_created': ToolRun;
  'state:tool_run_updated': ToolRun;
  'state:keyword_created': any;
  'state:keyword_updated': any;
  'state:keyword_deleted': string;
  'state:sensitive_operation_logged': any;
  'state:session_cleared': string;
  'state:all_cleared': null;
  'state:ace_state_updated': any;
  'manager_llm_config_updated': ManagerLLMConfig;
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
