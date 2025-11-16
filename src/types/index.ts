// 统一类型定义 - 一体化架构

// Agent 角色
export type AgentRole =
  | 'admin'
  | 'developer'
  | 'reviewer'
  | 'tester'
  | 'security'
  | 'documenter'
  | 'coordinator'
  | 'analyzer';

export type AgentToolPermission =
  | 'terminal_exec'
  | 'workspace_write'
  | 'mcp_tools'
  | 'web_fetch'
  | 'context_engine'
  | 'custom_tool';

export interface AgentMetrics {
  success_rate?: number;
  average_response_ms?: number;
  tasks_completed?: number;
  tasks_failed?: number;
  last_active_at?: number;
}

// Agent 状态
export type AgentStatus = 'online' | 'offline' | 'busy';

// 任务状态
export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'blocked' | 'paused';

// 消息类型
export type MessageType = 'discussion' | 'decision' | 'question' | 'warning' | 'suggestion' | 'system' | 'requirement';

export type BlackboardReferenceType = 'task' | 'file' | 'proof' | 'message' | 'notification' | 'custom';

// 优先级
export type Priority = 'high' | 'medium' | 'low';

// 投票类型
export type VoteType = 'simple_majority' | 'absolute_majority' | 'unanimous' | 'veto';

// 投票选择
export type VoteChoice = 'approve' | 'reject' | 'abstain';

// 投票状态
export type TopicStatus = 'pending' | 'completed' | 'timeout';

// 审批决策
export type ApprovalDecision = 'pending' | 'approved' | 'rejected';

// 策略类型
export type PolicyType =
  | 'auto_approve'
  | 'auto_merge'
  | 'auto_test'
  | 'auto_notify'
  | 'require_review'
  | 'require_vote'
  | 'message_router';

// 通知级别
export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

export type BlackboardCategory =
  | 'user'
  | 'agent_summary'
  | 'moderator'
  | 'system_event'
  | 'automation';

export type BlackboardVisibility = 'blackboard' | 'event_log' | 'thinking';

// 思考步骤类型
export type ThinkingStepType = 'thought' | 'tool_call' | 'observation' | 'result';

// Session
export interface Session {
  id: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, any> | null;
}

// Agent
export interface Agent {
  id: string;
  display_name: string;
  roles: AgentRole[];
  status: AgentStatus;
  is_enabled: boolean;
  capabilities: string[];
  tool_permissions?: AgentToolPermission[] | null;
  metrics?: AgentMetrics | null;
  last_heartbeat_at: number;
  status_detail: string | null;
  status_eta: number | null;
  active_task_id: string | null;
  status_updated_at: number | null;
  created_at: number;
  notes?: string | null;
  // LLM 配置
  llm_provider?: string;
  llm_model?: string;
  llm_api_key?: string;
  llm_base_url?: string;
}

// Task
export interface Task {
  id: string;
  session_id: string;
  title: string;
  intent: string;
  description: string | null;
  scope: string;
  priority: Priority;
  labels: string[] | null;
  due_at: number | null;
  status: TaskStatus;
  assigned_to: string | null;
  parent_task_id?: string | null;
  dependencies?: string[] | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  result_summary: string | null;
  result_details: string | null;
  result_artifacts: any[] | null;
  run_after?: number | null;
  retry_count?: number;
  max_retries?: number | null;
  timeout_seconds?: number | null;
  last_started_at?: number | null;
  metadata?: Record<string, any> | null;
}

export type CreateTaskInput = Omit<Task,
  'created_at' |
  'updated_at' |
  'result_summary' |
  'result_details' |
  'result_artifacts' |
  'completed_at'
> & {
  parent_task_id?: string | null;
  dependencies?: string[] | null;
  result_summary?: string | null;
  result_details?: string | null;
  result_artifacts?: any[] | null;
  completed_at?: number | null;
  run_after?: number | null;
  retry_count?: number;
  max_retries?: number | null;
  timeout_seconds?: number | null;
  last_started_at?: number | null;
  metadata?: Record<string, any> | null;
};

export type ToolRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ToolRun {
  id: string;
  session_id: string | null;
  task_id: string | null;
  workflow_instance_id: string | null;
  tool_name: string;
  runner: 'automation' | 'mcp' | 'manual' | 'system';
  source?: string | null;
  command?: string | null;
  input?: Record<string, any> | null;
  output?: Record<string, any> | null;
  status: ToolRunStatus;
  exit_code?: number | null;
  error?: string | null;
  created_at: number;
  started_at: number;
  completed_at?: number | null;
  created_by?: string | null;
  metadata?: Record<string, any> | null;
}

export type ProofType = 'work' | 'agreement';
export type ProofAttestationStatus = 'pending' | 'approved' | 'rejected';

export interface ProofRecord {
  id: string;
  session_id: string | null;
  workflow_id: string;
  workflow_instance_id: string;
  phase_id: string;
  proof_type: ProofType;
  task_id: string | null;
  description: string | null;
  evidence_uri: string | null;
  hash: string | null;
  acknowledgers: string[] | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  attestation_status: ProofAttestationStatus;
  attestor_id: string | null;
  attested_at: number | null;
  attestation_note: string | null;
  metadata: Record<string, any> | null;
}

export interface ProofReportResult {
  session_id: string | null;
  workflow_id: string;
  workflow_instance_id: string;
  generated_at: number;
  stats: {
    total: number;
    approved: number;
    pending: number;
    rejected: number;
  };
  markdown: string;
}

export interface FileChange {
  id: number;
  session_id: string;
  task_id: string | null;
  agent_id: string;
  file_path: string;
  change_type: 'create' | 'modify' | 'delete';
  old_content: string | null;
  new_content: string | null;
  diff: string | null;
  line_changes: { added: number; removed: number } | null;
  reason: string | null;
  created_at: number;
}

// Blackboard Entry
export interface BlackboardEntry {
  id: string;
  session_id: string;
  agent_id: string;
  message_type: MessageType;
  content: string;
  priority: Priority;
  category: BlackboardCategory;
  visibility: BlackboardVisibility;
  tags: string[] | null;
  reply_to: string | null;        // 回复的消息 ID
  references: string[] | null;    // 引用的消息 ID 列表
  reference_type: BlackboardReferenceType | null;
  reference_id: string | null;
  mentions: string[] | null;
  expires_at: number | null;
  payload: Record<string, any> | null;
  created_at: number;
}

// Topic (投票主题)
export interface Topic {
  id: string;
  session_id: string;
  task_id: string | null;
  title: string;
  description: string | null;
  vote_type: VoteType;
  required_roles: string[] | null;
  created_by: string;  // 发起投票的 agent_id
  timeout_at: number;
  status: TopicStatus;
  result: string | null;
  created_at: number;
  // 关联数据（由 getTopics 填充）
  votes?: Vote[];
  options?: VoteOption[];
}

// 投票选项
export interface VoteOption {
  value: string;
  label: string;
}

// Vote
export interface Vote {
  id: number;
  topic_id: string;
  agent_id: string;
  choice: VoteChoice;
  comment: string | null;
  created_at: number;
}

export interface Approval {
  id: number;
  session_id: string;
  task_id: string;
  created_by: string;  // 发起审批的 agent_id
  approver_id: string;
  decision: ApprovalDecision;
  comment: string | null;
  created_at: number;
}

export interface AutomationPolicy {
  id: number;
  name: string;
  type: PolicyType;
  scope: string;
  conditions: Record<string, any>;
  actions: Record<string, any>;
  priority: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface Lock {
  resource: string;
  holder_id: string;
  session_id: string;
  expires_at: number;
}

export interface Notification {
  id: number;
  session_id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  metadata?: Record<string, any> | null;
  read: boolean;
  created_at: number;
}

export interface GovernanceHistoryEntry {
  id: number;
  session_id: string;
  type: 'vote' | 'approval' | 'task' | 'proof';
  entity_id: string;
  action: string;
  actor_id: string | null;
  summary: string | null;
  payload: Record<string, any> | null;
  created_at: number;
}

export interface GovernanceHistoryQuery {
  session_id?: string;
  type?: 'vote' | 'approval' | 'task' | 'all';
  action?: string | null;
  entity_id?: string | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

export interface TaskTimeoutRecord {
  task_id: string;
  task_title?: string | null;
  session_id: string;
  action: 'task_timeout_requeued' | 'task_timeout_failed' | 'task_failed';
  attempt?: number | null;
  timeout_ms?: number | null;
  message: string;
  occurred_at: number;
}

export interface TaskMetrics {
  total: number;
  running: number;
  queued: number;
  blocked: number;
  failed: number;
  updated_at: number;
  last_timeout?: TaskTimeoutRecord | null;
  sweep_duration_ms?: number;
  session_id?: string | null;
  scope?: 'global' | 'session';
}

export interface TaskBacklogSummary {
  id: string;
  session_id: string;
  title: string;
  total: number;
  completed: number;
  running: number;
  blocked: number;
  pending: number;
  source_task_id?: string | null;
}

export interface MCPServer {
  id: number;
  name: string;
  description?: string | null;
  command: string;
  args: string[];
  env?: Record<string, string> | null;
  enabled: boolean;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

// Thinking Log
export interface ThinkingLog {
  id: string;
  session_id: string;
  agent_id: string;
  task_id: string | null;
  step_type: ThinkingStepType;
  content: string | null;
  tool_name: string | null;
  tool_input: any | null;
  tool_output: any | null;
  created_at: number;
}

export interface TaskResult {
  task_id: string;
  summary: string | null;
  details: string | null;
  artifacts: any[] | null;
  completed_at: number | null;
}

export interface AgentOverview {
  agent: Agent;
  stats: {
    running: number;
    pending: number;
    completed_recent: number;
    locks: number;
  };
  tasks: {
    running: Task[];
    pending: Task[];
    completed: Task[];
  };
  messages: BlackboardEntry[];
  thinking: ThinkingLog[];
  locks: Lock[];
  notifications: Notification[];
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

// Extension 特有的类型

export interface ExtensionConfig {
  backendUrl: string;
  llm: {
    provider: 'claude' | 'openai' | 'glm' | 'gemini' | 'custom';
    apiKey: string;
    model: string;
    baseURL?: string;
  };
  agent: {
    id: string;
    roles: AgentRole[];
    displayName: string;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  result?: any;
  error?: string;
  timestamp: number;
}

export interface ThinkingStep {
  id: string;
  type: 'thought' | 'tool_call' | 'observation' | 'result';
  content: string;
  timestamp: number;
  toolCall?: ToolCall;
}
