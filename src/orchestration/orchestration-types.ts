export type SchedulerEventType =
  | 'queued'
  | 'assigned'
  | 'reassigned'
  | 'skipped'
  | 'agent_offline'
  | 'assist_required'
  | 'human_required';

export interface SchedulerEventPayload {
  type: SchedulerEventType;
  taskId?: string;
  agentId?: string;
  sessionId?: string | null;
  reason?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export type SentinelEventType =
  | 'phase_timeout'
  | 'proof_missing'
  | 'task_stalled'
  | 'agent_offline'
  | 'defect_loop'
  | 'human_required'
  | 'assist_required';

export interface SentinelEventPayload {
  type: SentinelEventType;
  severity: 'info' | 'warning' | 'critical';
  workflowInstanceId?: string;
  phaseId?: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string | null;
  message: string;
  timestamp: number;
  resolved?: boolean;
  metadata?: Record<string, any>;
}
