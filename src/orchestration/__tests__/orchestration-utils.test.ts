import { describe, it, expect } from 'vitest';
import { deriveTaskRoles, deriveTaskTools, extractAssistTarget, priorityWeight } from '../orchestration-utils';
import type { Task } from '../../types';

const baseTask = (): Task => ({
  id: 'task-1',
  session_id: 'session-1',
  title: 'Demo task',
  intent: 'implement_requirement',
  description: '',
  scope: 'workspace',
  priority: 'medium',
  labels: [],
  due_at: null,
  status: 'pending',
  assigned_to: null,
  parent_task_id: null,
  dependencies: [],
  created_at: Date.now(),
  updated_at: Date.now(),
  completed_at: null,
  result_summary: null,
  result_details: null,
  result_artifacts: null,
  run_after: null,
  retry_count: 0,
  max_retries: null,
  timeout_seconds: null,
  last_started_at: null
});

describe('orchestration-utils', () => {
  it('derives roles from explicit labels', () => {
    const task = {
      ...baseTask(),
      labels: ['role:security']
    };
    expect(deriveTaskRoles(task)).toEqual(['security']);
  });

  it('falls back to phase/intent hints', () => {
    const task = {
      ...baseTask(),
      intent: 'qa_signoff',
      labels: ['workflow_phase:verify']
    };
    const roles = deriveTaskRoles(task);
    expect(roles).toContain('tester');
  });

  it('computes priority weight', () => {
    const high = { ...baseTask(), priority: 'high' as const };
    const low = { ...baseTask(), priority: 'low' as const };
    expect(priorityWeight(high)).toBeGreaterThan(priorityWeight(low));
  });

  it('derives task tools from labels', () => {
    const task = {
      ...baseTask(),
      labels: ['tool:terminal_exec', 'workflow_tool:web_fetch']
    };
    const tools = deriveTaskTools(task);
    expect(tools).toContain('terminal_exec');
    expect(tools).toContain('web_fetch');
  });

  it('extracts assist target label', () => {
    const task = {
      ...baseTask(),
      labels: ['assist_agent:agent-1']
    };
    expect(extractAssistTarget(task)).toBe('agent-1');
  });

  it('returns null for missing assist target', () => {
    const task = {
      ...baseTask(),
      labels: ['capability:coding']
    };
    expect(extractAssistTarget(task)).toBeNull();
  });
});
