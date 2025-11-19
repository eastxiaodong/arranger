import type {
  Agent,
  TaskStateRecord,
  TaskStateTransition,
  AssistRequest,
  AgentHealthRecord,
  Conversation,
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
  SensitiveKeyword,
  SensitiveOperationLog,
  AceStateRecord,
  ToolRun,
  ManagerLLMConfig,
} from '../types';

/**
 * 定义了应用中所有事件及其负载的类型。
 * 这是事件系统的单一事实源（Single Source of Truth）。
 */
export interface EventMap {
  // StateStore Events
  'state:all_cleared': null;
  'state:session_cleared': string; // sessionId
  'state:task_created': TaskStateRecord;
  'state:task_updated': TaskStateRecord;
  'state:task_transitioned': { taskState: TaskStateRecord; transition: TaskStateTransition };
  'state:task_deleted': string; // taskId
  'state:assist_created': AssistRequest;
  'state:assist_updated': AssistRequest;
  'state:assist_deleted': string; // assistRequestId
  'state:agent_health_updated': AgentHealthRecord;
  'state:agent_health_deleted': string; // agentId
  'state:conversation_created': Conversation;
  'state:conversation_updated': Conversation;
  'state:conversation_deleted': string; // conversationId
  'state:tool_run_created': ToolRun;
  'state:tool_run_updated': ToolRun;
  'state:ace_state_updated': AceStateRecord;
  'state:keyword_created': SensitiveKeyword;
  'state:keyword_updated': SensitiveKeyword;
  'state:keyword_deleted': string; // keywordId
  'state:sensitive_operation_logged': SensitiveOperationLog;

  // Legacy/Other Events (now strongly-typed)
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
  'tool_runs_update': ToolRun[];
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
  'manager_llm_config_updated': ManagerLLMConfig;
}