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

// 审批决策


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
  roles?: AgentRole[] | null; // 兼容旧字段，当前不再强制使用角色
  status: AgentStatus;
  is_enabled: boolean;
  capabilities?: string[] | null; // 兼容旧字段
  capability_tags?: string[] | null; // 能力标签（新）
  reasoning_tier?: number | null; // 推理档位（1-10 越高推理越强）
  cost_factor?: number | null; // 成本系数（相对权重）
  tool_permissions?: AgentToolPermission[] | null; // 不再使用，保留兼容
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

export interface ManagerLLMConfig {
  provider: string;
  model: string;
  api_key: string;
  base_url: string;
  temperature: number;
  max_output_tokens: number;
  system_prompt: string;
  updated_at: number;
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
  runner: 'automation' | 'mcp' | 'manual' | 'system' | 'ace';
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

export interface ToolRunFilter {
  session_id?: string | null;
  task_id?: string | null;
  statuses?: ToolRunStatus[];
  limit?: number;
}

export interface AceSettings {
  baseUrl: string;
  token: string;
  projectRoot: string;
  batchSize: number;
  maxLinesPerBlob: number;
  excludePatterns: string[];
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


export interface GovernanceHistoryQuery {
  session_id?: string;
  type?: 'approval' | 'task' | 'all';
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
    roles: string[]; // 兼容旧字段，此处承载能力/标签
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

// ===== 状态层与调度相关类型 =====

export type TaskState = 'pending' | 'active' | 'blocked' | 'needs-confirm' | 'reassigning' | 'finalizing' | 'done' | 'failed';
export type AssistState = 'requested' | 'assigned' | 'in-progress' | 'completed' | 'timeout' | 'cancelled';
export type AssistPriority = 'critical' | 'high' | 'normal' | 'low';
export type AceRunType = 'index' | 'search' | 'test';
export type AceRunStatus = 'running' | 'succeeded' | 'failed';

export interface TaskStateTransition {
  from: TaskState;
  to: TaskState;
  reason: string;
  triggeredBy: string;
  timestamp: number;
}

export interface TaskStateRecord {
  taskId: string;
  sessionId: string;
  state: TaskState;
  previousState: TaskState | null;
  assignedTo: string | null;
  priority: Priority;
  labels: string[];
  dependencies: string[];
  blockedBy: string[];
  context: Record<string, any>;
  history: TaskStateTransition[];
  createdAt: number;
  updatedAt: number;
}

export interface AssistRequest {
  id: string;
  taskId: string;
  sessionId: string;
  requesterId: string;
  targetAgentId: string | null;
  requiredCapabilities: string[];
  priority: AssistPriority;
  state: AssistState;
  description: string;
  context: Record<string, any>;
  assignedTo: string | null;
  responseDeadline: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type AgentHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'offline';

export interface AgentHealthRecord {
  agentId: string;
  status: AgentHealthStatus;
  lastHeartbeat: number;
  activeTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  avgResponseTime: number;
  errorRate: number;
  capabilities: string[];
  metadata: Record<string, any>;
  updatedAt: number;
}

export type KeywordRiskLevel = 'low' | 'medium' | 'high';
export type KeywordAction = 'log' | 'confirm' | 'block';

export interface SensitiveKeyword {
  id: string;
  keyword: string;
  riskLevel: KeywordRiskLevel;
  action: KeywordAction;
  category: string;
  description: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SensitiveOperationLog {
  id: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  operation: string;
  matchedKeywords: string[];
  riskLevel: KeywordRiskLevel;
  action: KeywordAction;
  userConfirmed: boolean | null;
  blocked: boolean;
  context: Record<string, any>;
  timestamp: number;
}

export interface AceRunSummary {
  runId: string;
  type: AceRunType;
  status: AceRunStatus;
  startedAt: number;
  completedAt: number | null;
  projectRoot: string | null;
  query?: string | null;
  message?: string | null;
  stats?: Record<string, any> | null;
}

export interface AceStateRecord {
  workspaceRoot: string;
  projectRoot: string | null;
  lastRunType: AceRunType | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureStreak: number;
  lastFailureMessage: string | null;
  lastIndex: AceRunSummary | null;
  lastSearch: AceRunSummary | null;
  lastTest: AceRunSummary | null;
  updatedAt: number;
}

export interface AceRunUpdatePayload {
  runId: string;
  type: AceRunType;
  stage: 'start' | 'end';
  status: AceRunStatus;
  query?: string;
  message?: string;
  metadata?: Record<string, any>;
}

export interface TaskStateFilter {
  taskId?: string;
  sessionId?: string;
  state?: TaskState;
  assignedTo?: string;
  labels?: string[];
}

export interface AssistRequestFilter {
  id?: string;
  taskId?: string;
  sessionId?: string;
  requesterId?: string;
  targetAgentId?: string;
  state?: AssistState;
  priority?: AssistPriority;
}

export interface AgentHealthFilter {
  agentId?: string;
  status?: AgentHealthRecord['status'];
  minActiveTaskCount?: number;
  maxActiveTaskCount?: number;
}

export interface SensitiveKeywordFilter {
  keyword?: string;
  riskLevel?: KeywordRiskLevel;
  action?: KeywordAction;
  category?: string;
  enabled?: boolean;
}
