import type { Task } from '../types';

export type PhaseStatus = 'pending' | 'active' | 'completed' | 'blocked';
export type WorkflowStatus = 'running' | 'completed' | 'failed';

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  phases: PhaseDefinition[];
  metadata?: Record<string, any>;
}

export interface PhaseDefinition {
  id: string;
  title: string;
  description?: string;
  dependencies?: string[];
  scenario_tags?: string[];
  entry?: PhaseEntryConfig;
  exit?: PhaseExitConfig;
  loop?: PhaseLoopConfig;
  failure?: PhaseFailureConfig;
}

export interface PhaseEntryConfig {
  auto_tasks?: AutoTaskTemplate[];
  governance?: GovernanceTriggerConfig | GovernanceTriggerConfig[];
}

export interface AutoTaskTemplate {
  template?: string;
  generator?: string;
  generator_options?: Record<string, any>;
  inputs?: string[];
  intent?: string;
  assignee_role?: string;
  priority?: Task['priority'];
  labels?: string[];
  metadata?: Record<string, any>;
}

export interface GovernanceTriggerConfig {
  type: 'vote' | 'approval';
  title: string;
  description?: string;
  required_roles?: string[];
  timeout_minutes?: number;
  options?: string[];
}

export interface PhaseExitConfig {
  require_decisions?: string[];
  require_artifacts?: string[];
  require_tasks_created?: string[];
  require_tasks_completed?: string[];
  require_defects_open?: number;
  governance?: GovernanceTriggerConfig | GovernanceTriggerConfig[];
}

export interface PhaseLoopConfig {
  until?: {
    all_tasks_completed?: boolean;
    decision?: string;
    defects_zero?: boolean;
  };
  on_iteration?: AutoTaskTemplate[];
}

export interface PhaseFailureConfig {
  on_agent_offline?: 'reassign' | 'escalate';
  on_blocker?: 'escalate' | 'pause_workflow';
  notify_roles?: string[];
}

export interface WorkflowInstance {
  id: string;
  workflowId: string;
  sessionId: string | null;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, any>;
  phaseState: Record<string, PhaseRuntimeState>;
  activePhases: string[];
}

export interface PhaseRuntimeState {
  id: string;
  status: PhaseStatus;
  enteredAt?: number;
  completedAt?: number;
  blockers: WorkflowBlocker[];
  decisions: string[];
  artifacts: Record<string, WorkflowArtifact>;
  proofs: WorkflowProof[];
  autoTasksSpawned: string[];
  trackedTasks: Record<string, WorkflowTrackedTask>;
  openDefects: Record<string, WorkflowTrackedDefect>;
  metadata?: Record<string, any>;
}

export interface WorkflowArtifact {
  id: string;
  type: string;
  uri?: string;
  description?: string;
  createdAt: number;
  createdBy?: string;
  payload?: Record<string, any>;
}

export interface WorkflowProof {
  id: string;
  type: 'work' | 'agreement';
  description?: string;
  uri?: string;
  hash?: string;
  createdAt: number;
  createdBy?: string;
  acknowledgers?: string[];
}

export interface WorkflowTrackedTask {
  id: string;
  intent?: string;
  status: Task['status'];
  assignee?: string | null;
  labels?: string[];
  lastUpdated: number;
}

export interface WorkflowTrackedDefect {
  id: string;
  status: 'open' | 'closed';
  severity?: string;
  lastUpdated: number;
}

export interface WorkflowBlocker {
  id: string;
  reason: string;
  createdAt: number;
  severity: 'info' | 'warning' | 'critical';
  resolved?: boolean;
  resolvedAt?: number;
}

export interface WorkflowInstanceSummary {
  id: string;
  workflowId: string;
  sessionId: string | null;
  status: WorkflowStatus;
  activePhases: string[];
  blockedPhases: string[];
  updatedAt: number;
  scenario?: string[];
}

export interface WorkflowRuntimeEvent {
  type: 'phase_enter' | 'phase_complete' | 'phase_blocked' | 'workflow_completed';
  workflowId: string;
  instanceId: string;
  phaseId?: string;
  timestamp: number;
  payload?: Record<string, any>;
}

export interface WorkflowKernelOptions {
  emitter?: {
    emit: <K extends string>(event: K, data: any) => void;
  };
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}
