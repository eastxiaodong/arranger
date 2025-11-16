import { randomUUID } from 'crypto';
import type { TypedEventEmitter } from '../events/emitter';
import type {
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowKernelOptions,
  PhaseDefinition,
  PhaseRuntimeState,
  WorkflowInstanceSummary,
  WorkflowRuntimeEvent,
  WorkflowArtifact,
  WorkflowProof,
  WorkflowTrackedDefect,
  WorkflowStatus
} from './workflow-types';

interface PhaseUserIntervention {
  id: string;
  messageId: string;
  sessionId: string;
  content: string;
  createdAt: number;
  createdBy: string;
  status: 'pending' | 'resolved';
  followupTaskId?: string | null;
  resolvedAt?: number | null;
}

export class WorkflowKernel {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly instances = new Map<string, WorkflowInstance>();
  private readonly sessionIndex = new Map<string, Set<string>>();
  private readonly emitter?: TypedEventEmitter;
  private readonly logger: NonNullable<WorkflowKernelOptions['logger']>;

  constructor(emitter?: TypedEventEmitter, options?: WorkflowKernelOptions) {
    this.emitter = emitter;
    this.logger = options?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {}
    };
  }

  registerDefinition(definition: WorkflowDefinition) {
    this.definitions.set(definition.id, definition);
    this.logger.info?.(`Workflow definition registered: ${definition.id}@${definition.version}`);
  }

  getDefinition(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  listDefinitions(): WorkflowDefinition[] {
    return Array.from(this.definitions.values());
  }

  createInstance(workflowId: string, sessionId: string | null, metadata?: Record<string, any>): WorkflowInstance {
    const definition = this.ensureDefinition(workflowId);
    const now = Date.now();
    const instance: WorkflowInstance = {
      id: randomUUID(),
      workflowId,
      sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      metadata,
      phaseState: {},
      activePhases: []
    };

    definition.phases.forEach(phase => {
      const state = this.createPhaseRuntimeState(phase.id);
      if (phase.scenario_tags && phase.scenario_tags.length > 0) {
        state.metadata = {
          ...(state.metadata || {}),
          scenario_gate: [...phase.scenario_tags]
        };
      }
      instance.phaseState[phase.id] = state;
    });

    this.instances.set(instance.id, instance);
    if (sessionId) {
      const set = this.sessionIndex.get(sessionId) ?? new Set<string>();
      set.add(instance.id);
      this.sessionIndex.set(sessionId, set);
    }
    this.activateEligiblePhases(instance, definition);
    this.emitInstanceUpdate();
    return instance;
  }

  getInstance(instanceId: string): WorkflowInstance | undefined {
    return this.instances.get(instanceId);
  }

  listInstances(): WorkflowInstance[] {
    return Array.from(this.instances.values());
  }

  getPhaseState(instanceId: string, phaseId: string): PhaseRuntimeState | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return undefined;
    }
    const phaseState = instance.phaseState[phaseId];
    if (!phaseState) {
      return undefined;
    }
    return this.clonePhaseState(phaseState);
  }

  listPhaseProofs(instanceId: string, phaseId: string): WorkflowProof[] {
    const state = this.getPhaseState(instanceId, phaseId);
    return state ? [...state.proofs] : [];
  }

  listOpenDefects(instanceId: string, phaseId: string): WorkflowTrackedDefect[] {
    const state = this.getPhaseState(instanceId, phaseId);
    if (!state) {
      return [];
    }
    return Object.values(state.openDefects).map(defect => ({ ...defect }));
  }

  findInstanceBySession(sessionId: string | null | undefined): WorkflowInstance | undefined {
    if (!sessionId) {
      return undefined;
    }
    const ids = this.sessionIndex.get(sessionId);
    if (!ids || ids.size === 0) {
      return undefined;
    }
    const firstId = ids.values().next().value as string;
    return this.instances.get(firstId);
  }

  recordUserIntervention(
    instanceId: string,
    phaseId: string,
    payload: {
      messageId: string;
      sessionId: string;
      content: string;
      createdAt?: number;
      createdBy?: string;
    }
  ): PhaseUserIntervention {
    const { instance, phaseState } = this.resolvePhaseState(instanceId, phaseId);
    const createdAt = payload.createdAt ?? Date.now();
    const note: PhaseUserIntervention = {
      id: `user_note_${createdAt}_${Math.random().toString(36).slice(2, 7)}`,
      messageId: payload.messageId,
      sessionId: payload.sessionId,
      content: payload.content,
      createdAt,
      createdBy: payload.createdBy ?? 'user',
      status: 'pending'
    };
    const notes = this.ensureUserInterventions(phaseState);
    notes.push(note);
    instance.updatedAt = createdAt;
    this.emitInstanceUpdate();
    return note;
  }

  linkUserInterventionTask(instanceId: string, phaseId: string, noteId: string, taskId: string) {
    const { instance, phaseState } = this.resolvePhaseState(instanceId, phaseId);
    const note = this.ensureUserInterventions(phaseState).find(item => item.id === noteId);
    if (!note) {
      return;
    }
    note.followupTaskId = taskId;
    instance.updatedAt = Date.now();
    this.emitInstanceUpdate();
  }

  resolveUserIntervention(instanceId: string, phaseId: string, noteId: string): boolean {
    const { instance, phaseState } = this.resolvePhaseState(instanceId, phaseId);
    const note = this.ensureUserInterventions(phaseState).find(item => item.id === noteId);
    if (!note || note.status === 'resolved') {
      return false;
    }
    note.status = 'resolved';
    note.resolvedAt = Date.now();
    instance.updatedAt = note.resolvedAt;
    this.emitInstanceUpdate();
    return true;
  }

  resolveUserInterventionByNoteId(noteId: string): boolean {
    for (const instance of this.instances.values()) {
      for (const [phaseId, runtime] of Object.entries(instance.phaseState)) {
        const note = this.ensureUserInterventionLookup(runtime, noteId);
        if (note) {
          return this.resolveUserIntervention(instance.id, phaseId, noteId);
        }
      }
    }
    return false;
  }

  recordDecision(instanceId: string, phaseId: string, decisionId: string) {
    const { instance, phaseState, definition } = this.resolvePhaseState(instanceId, phaseId);
    if (!phaseState.decisions.includes(decisionId)) {
      phaseState.decisions.push(decisionId);
      instance.updatedAt = Date.now();
      this.tryCompletePhase(instance, definition, phaseId);
    }
  }

  recordArtifact(instanceId: string, phaseId: string, artifact: WorkflowArtifact) {
    const { instance, phaseState, definition } = this.resolvePhaseState(instanceId, phaseId);
    phaseState.artifacts[artifact.id] = artifact;
    instance.updatedAt = Date.now();
    this.tryCompletePhase(instance, definition, phaseId);
  }

  recordProof(instanceId: string, phaseId: string, proof: WorkflowProof) {
    const { instance, phaseState, definition } = this.resolvePhaseState(instanceId, phaseId);
    const timestamp = proof.createdAt ?? Date.now();
    const normalized: WorkflowProof = {
      ...proof,
      createdAt: timestamp
    };
    const existingIndex = phaseState.proofs.findIndex(existing => existing.id === normalized.id);
    if (existingIndex >= 0) {
      phaseState.proofs[existingIndex] = {
        ...phaseState.proofs[existingIndex],
        ...normalized
      };
    } else {
      phaseState.proofs.push(normalized);
    }
    instance.updatedAt = timestamp;
    this.tryCompletePhase(instance, definition, phaseId);
  }

  updateTrackedTask(instanceId: string, phaseId: string, task: PhaseRuntimeState['trackedTasks'][string]) {
    const { instance, phaseState, definition } = this.resolvePhaseState(instanceId, phaseId);
    phaseState.trackedTasks[task.id] = task;
    instance.updatedAt = Date.now();
    this.tryCompletePhase(instance, definition, phaseId);
  }

  updateInstanceMetadata(instanceId: string, patch: Record<string, any>) {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance ${instanceId} not found`);
    }
    instance.metadata = {
      ...(instance.metadata || {}),
      ...(patch || {})
    };
    instance.updatedAt = Date.now();
    const definition = this.ensureDefinition(instance.workflowId);
    this.activateEligiblePhases(instance, definition);
    this.emitInstanceUpdate();
  }

  updateDefect(instanceId: string, phaseId: string, defectId: string, status: 'open' | 'closed', severity?: string) {
    const { instance, phaseState, definition } = this.resolvePhaseState(instanceId, phaseId);
    phaseState.openDefects[defectId] = {
      id: defectId,
      status,
      severity,
      lastUpdated: Date.now()
    };
    if (status === 'closed') {
      delete phaseState.openDefects[defectId];
    }
    instance.updatedAt = Date.now();
    this.tryCompletePhase(instance, definition, phaseId);
  }

  blockPhase(instanceId: string, phaseId: string, blocker: PhaseRuntimeState['blockers'][number]) {
    const { instance, phaseState } = this.resolvePhaseState(instanceId, phaseId);
    phaseState.status = 'blocked';
    phaseState.blockers.push(blocker);
    instance.updatedAt = Date.now();
    this.emitWorkflowEvent({
      type: 'phase_blocked',
      workflowId: instance.workflowId,
      instanceId: instance.id,
      phaseId,
      timestamp: Date.now(),
      payload: blocker
    });
    this.emitInstanceUpdate();
  }

  private activateEligiblePhases(instance: WorkflowInstance, definition: WorkflowDefinition) {
    const newlyActive: string[] = [];
    definition.phases.forEach(phase => {
      const runtime = instance.phaseState[phase.id];
      if (runtime.status !== 'pending') {
        return;
      }
      const applicable = this.phaseApplicableToScenario(phase, instance.metadata);
      if (!applicable) {
        runtime.metadata = {
          ...(runtime.metadata || {}),
          scenario_gate: phase.scenario_tags ?? runtime.metadata?.scenario_gate,
          scenario_pending: true
        };
        return;
      }
      const dependencies = phase.dependencies ?? [];
      const allDepsCompleted = dependencies.every(depId => instance.phaseState[depId]?.status === 'completed');
      if (allDepsCompleted || dependencies.length === 0) {
        runtime.status = 'active';
        runtime.enteredAt = Date.now();
        instance.activePhases.push(phase.id);
        newlyActive.push(phase.id);
        this.emitWorkflowEvent({
          type: 'phase_enter',
          workflowId: instance.workflowId,
          instanceId: instance.id,
          phaseId: phase.id,
          timestamp: runtime.enteredAt,
          payload: { autoTasks: phase.entry?.auto_tasks?.length ?? 0 }
        });
      }
    });
    if (newlyActive.length > 0) {
      this.emitInstanceUpdate();
    }
  }

  private tryCompletePhase(instance: WorkflowInstance, definition: WorkflowDefinition, phaseId: string) {
    const phase = definition.phases.find(p => p.id === phaseId);
    if (!phase) {
      return;
    }
    const runtime = instance.phaseState[phaseId];
    if (runtime.status !== 'active') {
      return;
    }
    if (!this.phaseExitConditionsMet(phase, runtime)) {
      return;
    }
    runtime.status = 'completed';
    runtime.completedAt = Date.now();
    instance.updatedAt = runtime.completedAt;
    instance.activePhases = instance.activePhases.filter(id => id !== phaseId);
    this.emitWorkflowEvent({
      type: 'phase_complete',
      workflowId: instance.workflowId,
      instanceId: instance.id,
      phaseId,
      timestamp: runtime.completedAt,
      payload: {
        decisions: runtime.decisions,
        artifacts: Object.keys(runtime.artifacts)
      }
    });
    this.activateEligiblePhases(instance, definition);
    this.checkWorkflowCompletion(instance, definition);
    this.emitInstanceUpdate();
  }

  private phaseExitConditionsMet(phase: PhaseDefinition, runtime: PhaseRuntimeState): boolean {
    const exit = phase.exit;
    if (!exit) {
      return true;
    }
    if (exit.require_decisions) {
      const satisfied = exit.require_decisions.every(decision => runtime.decisions.includes(decision));
      if (!satisfied) {
        return false;
      }
    }
    if (exit.require_artifacts) {
      const satisfied = exit.require_artifacts.every(artifactId => Boolean(runtime.artifacts[artifactId]));
      if (!satisfied) {
        return false;
      }
    }
    if (exit.require_tasks_created) {
      const satisfied = exit.require_tasks_created.every(taskId => Boolean(runtime.trackedTasks[taskId]));
      if (!satisfied) {
        return false;
      }
    }
    if (exit.require_tasks_completed) {
      const satisfied = exit.require_tasks_completed.every(taskId => runtime.trackedTasks[taskId]?.status === 'completed');
      if (!satisfied) {
        return false;
      }
    }
    if (typeof exit.require_defects_open === 'number') {
      const openCount = Object.keys(runtime.openDefects).length;
      if (openCount > exit.require_defects_open) {
        return false;
      }
    }
    return true;
  }

  private checkWorkflowCompletion(instance: WorkflowInstance, definition: WorkflowDefinition) {
    const allCompleted = definition.phases.every(phase => instance.phaseState[phase.id]?.status === 'completed');
    if (allCompleted) {
      instance.status = 'completed';
      instance.updatedAt = Date.now();
      this.emitWorkflowEvent({
        type: 'workflow_completed',
        workflowId: instance.workflowId,
        instanceId: instance.id,
        timestamp: instance.updatedAt
      });
    }
  }

  private ensureDefinition(id: string): WorkflowDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new Error(`Workflow definition ${id} not found`);
    }
    return definition;
  }

  private resolvePhaseState(instanceId: string, phaseId: string) {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance ${instanceId} not found`);
    }
    const definition = this.ensureDefinition(instance.workflowId);
    const phaseState = instance.phaseState[phaseId];
    if (!phaseState) {
      throw new Error(`Phase ${phaseId} not part of workflow ${definition.id}`);
    }
    return { instance, phaseState, definition };
  }

  private createPhaseRuntimeState(id: string): PhaseRuntimeState {
    return {
      id,
      status: 'pending',
      blockers: [],
      decisions: [],
      artifacts: {},
      proofs: [],
      autoTasksSpawned: [],
      trackedTasks: {},
      openDefects: {}
    };
  }

  private phaseApplicableToScenario(phase: PhaseDefinition, metadata?: Record<string, any>): boolean {
    if (!phase.scenario_tags || phase.scenario_tags.length === 0) {
      return true;
    }
    const raw = metadata?.scenario;
    if (!raw) {
      return false;
    }
    const scenarioList = Array.isArray(raw) ? raw : [raw];
    const normalized = scenarioList
      .map(item => String(item || '').toLowerCase())
      .filter(Boolean);
    if (!normalized.length) {
      return false;
    }
    const tags = phase.scenario_tags.map(tag => tag.toLowerCase());
    return normalized.some(value => tags.includes(value));
  }

  private emitInstanceUpdate() {
    if (!this.emitter) {
      return;
    }
    const summaries = this.listInstances().map(instance => this.toSummary(instance));
    this.emitter.emit('workflow_instances_update', summaries);
  }

  private emitWorkflowEvent(event: WorkflowRuntimeEvent) {
    if (!this.emitter) {
      return;
    }
    this.emitter.emit('workflow_event', event);
  }

  private toSummary(instance: WorkflowInstance): WorkflowInstanceSummary {
    const blocked = Object.entries(instance.phaseState)
      .filter(([, state]) => state.status === 'blocked')
      .map(([phaseId]) => phaseId);
    const rawScenario = instance.metadata?.scenario;
    const scenario = Array.isArray(rawScenario)
      ? rawScenario.map(value => String(value))
      : rawScenario
        ? [String(rawScenario)]
        : undefined;
    return {
      id: instance.id,
      workflowId: instance.workflowId,
      sessionId: instance.sessionId,
      status: instance.status,
      activePhases: instance.activePhases,
      blockedPhases: blocked,
      updatedAt: instance.updatedAt,
      scenario
    };
  }

  dispose() {
    this.instances.clear();
    this.definitions.clear();
    this.sessionIndex.clear();
  }

  private clonePhaseState(state: PhaseRuntimeState): PhaseRuntimeState {
    return JSON.parse(JSON.stringify(state)) as PhaseRuntimeState;
  }

  private ensureUserInterventions(state: PhaseRuntimeState): PhaseUserIntervention[] {
    if (!state.metadata) {
      state.metadata = {};
    }
    const metadata = state.metadata as Record<string, any>;
    if (!Array.isArray(metadata.user_notes)) {
      metadata.user_notes = [];
    }
    return metadata.user_notes as PhaseUserIntervention[];
  }

  private ensureUserInterventionLookup(state: PhaseRuntimeState, noteId: string): PhaseUserIntervention | null {
    const metadata = state.metadata as Record<string, any> | undefined;
    if (!metadata || !Array.isArray(metadata.user_notes)) {
      return null;
    }
    return (metadata.user_notes as PhaseUserIntervention[]).find(note => note.id === noteId) || null;
  }
}
