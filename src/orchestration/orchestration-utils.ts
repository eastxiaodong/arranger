import type { Task } from '../types';

export const PHASE_ROLE_HINTS: Record<string, string> = {
  clarify: 'product',
  plan: 'architect',
  build: 'developer',
  verify: 'tester',
  delivery: 'scribe'
};

export const INTENT_ROLE_HINTS: Record<string, string> = {
  clarify_requirement: 'product',
  create_architecture_plan: 'architect',
  implement_requirement: 'developer',
  qa_signoff: 'tester',
  submit_verify_evidence: 'tester',
  release_approval: 'admin',
  compile_release_note: 'scribe',
  handle_warning: 'security',
  respond_to_command: 'coordinator'
};

export const PRIORITY_WEIGHTS: Record<Task['priority'], number> = {
  high: 3,
  medium: 2,
  low: 1
};

export function deriveTaskRoles(task: Task): string[] {
  const roles = new Set<string>();
  task.labels?.forEach(label => {
    if (label.startsWith('role:')) {
      roles.add(label.replace('role:', '').toLowerCase());
    }
    if (label.startsWith('workflow_role:')) {
      roles.add(label.replace('workflow_role:', '').toLowerCase());
    }
    if (label.startsWith('workflow_phase:')) {
      const phase = label.replace('workflow_phase:', '');
      const mapped = PHASE_ROLE_HINTS[phase];
      if (mapped) {
        roles.add(mapped);
      }
    }
  });
  if (roles.size === 0 && task.intent) {
    const mapped = INTENT_ROLE_HINTS[task.intent];
    if (mapped) {
      roles.add(mapped);
    }
  }
  return Array.from(roles);
}

export function deriveTaskCapabilities(task: Task): string[] {
  const capabilities = new Set<string>();
  task.labels?.forEach(label => {
    if (label.startsWith('capability:')) {
      capabilities.add(label.replace('capability:', '').toLowerCase());
    } else if (label.startsWith('workflow_capability:')) {
      capabilities.add(label.replace('workflow_capability:', '').toLowerCase());
    }
  });
  return Array.from(capabilities);
}

export function deriveTaskTools(task: Task): string[] {
  const tools = new Set<string>();
  task.labels?.forEach(label => {
    if (label.startsWith('tool:')) {
      tools.add(label.replace('tool:', '').toLowerCase());
    } else if (label.startsWith('workflow_tool:')) {
      tools.add(label.replace('workflow_tool:', '').toLowerCase());
    }
  });
  return Array.from(tools);
}

export function extractAssistTarget(task: Task): string | null {
  if (!Array.isArray(task.labels)) {
    return null;
  }
  for (const label of task.labels) {
    if (label.startsWith('assist_agent:')) {
      const value = label.replace('assist_agent:', '').trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

export function priorityWeight(task: Task): number {
  return PRIORITY_WEIGHTS[task.priority] ?? 1;
}
