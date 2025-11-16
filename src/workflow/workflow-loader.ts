import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowDefinition, PhaseDefinition } from './workflow-types';

export function loadWorkflowDefinitionFromFile(filePath: string): WorkflowDefinition {
  const resolvedPath = path.resolve(filePath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  let parsed: WorkflowDefinition;
  try {
    parsed = JSON.parse(raw) as WorkflowDefinition;
  } catch (error) {
    throw new Error(`Failed to parse workflow definition (${resolvedPath}): ${(error as Error).message}`);
  }

  validateWorkflowDefinition(parsed, resolvedPath);
  return parsed;
}

export function validateWorkflowDefinition(def: WorkflowDefinition, source?: string) {
  if (!def.id || !def.name || !def.version) {
    throw new Error(`Workflow definition ${source ?? ''} is missing id/name/version`);
  }
  if (!Array.isArray(def.phases) || def.phases.length === 0) {
    throw new Error(`Workflow definition ${def.id} must contain at least one phase`);
  }
  const phaseIds = new Set<string>();
  def.phases.forEach((phase: PhaseDefinition) => {
    if (!phase.id) {
      throw new Error(`Workflow definition ${def.id} contains a phase without id`);
    }
    if (phaseIds.has(phase.id)) {
      throw new Error(`Workflow definition ${def.id} contains duplicate phase id ${phase.id}`);
    }
    phaseIds.add(phase.id);
    phase.dependencies?.forEach(dep => {
      if (!phaseIds.has(dep) && !def.phases.some(p => p.id === dep)) {
        throw new Error(`Workflow definition ${def.id} phase ${phase.id} references unknown dependency ${dep}`);
      }
    });
  });
}
