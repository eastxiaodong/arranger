import { describe, it, expect } from 'vitest';
import { WorkflowKernel } from '../workflow-kernel';
import type { TypedEventEmitter } from '../../events/emitter';
import type { WorkflowRuntimeEvent } from '../workflow-types';

const mockEmitter = (): TypedEventEmitter => {
  return {
    emit: () => {},
    on: () => {},
    once: () => {},
    off: () => {},
    removeAllListeners: () => {}
  } as unknown as TypedEventEmitter;
};

const createTestDefinition = () => ({
  id: 'test_flow',
  name: 'Test Flow',
  version: '1.0',
  phases: [
    {
      id: 'phase_a',
      title: 'Phase A',
      exit: {
        require_decisions: ['decision_a']
      }
    },
    {
      id: 'phase_b',
      title: 'Phase B',
      dependencies: ['phase_a'],
      exit: {
        require_artifacts: ['artifact_b']
      }
    }
  ]
});

describe('WorkflowKernel', () => {
  it('activates phases respecting dependencies', () => {
    const kernel = new WorkflowKernel(mockEmitter());
    kernel.registerDefinition(createTestDefinition());
    const instance = kernel.createInstance('test_flow', 'session-1');

    const stateA = instance.phaseState['phase_a'];
    const stateB = instance.phaseState['phase_b'];
    expect(stateA.status).toBe('active');
    expect(stateB.status).toBe('pending');
  });

  it('completes phase when exit conditions met', () => {
    const kernel = new WorkflowKernel(mockEmitter());
    kernel.registerDefinition(createTestDefinition());
    const instance = kernel.createInstance('test_flow', 'session-2');

    kernel.recordDecision(instance.id, 'phase_a', 'decision_a');
    const stateA = kernel.getInstance(instance.id)?.phaseState['phase_a'];
    expect(stateA?.status).toBe('completed');

    const stateB = kernel.getInstance(instance.id)?.phaseState['phase_b'];
    expect(stateB?.status).toBe('active');
  });

  it('emits workflow events on phase transitions', () => {
    const events: WorkflowRuntimeEvent[] = [];
    const emitter = {
      emit: (event: string, payload: any) => {
        if (event === 'workflow_event') {
          events.push(payload as WorkflowRuntimeEvent);
        }
      },
      on: () => {},
      once: () => {},
      off: () => {},
      removeAllListeners: () => {}
    } as unknown as TypedEventEmitter;

    const kernel = new WorkflowKernel(emitter);
    kernel.registerDefinition(createTestDefinition());
    const instance = kernel.createInstance('test_flow', 'session-3');

    kernel.recordDecision(instance.id, 'phase_a', 'decision_a');
    kernel.recordArtifact(instance.id, 'phase_b', {
      id: 'artifact_b',
      type: 'doc',
      createdAt: Date.now()
    });

    const hasPhaseEnter = events.some(event => event.type === 'phase_enter');
    const hasPhaseComplete = events.filter(event => event.type === 'phase_complete').length >= 2;
    const hasWorkflowComplete = events.some(event => event.type === 'workflow_completed');

    expect(hasPhaseEnter).toBe(true);
    expect(hasPhaseComplete).toBe(true);
    expect(hasWorkflowComplete).toBe(true);
  });

  it('upserts proofs and exposes read APIs', () => {
    const kernel = new WorkflowKernel(mockEmitter());
    kernel.registerDefinition(createTestDefinition());
    const instance = kernel.createInstance('test_flow', 'session-4');

    kernel.recordProof(instance.id, 'phase_a', {
      id: 'proof-1',
      type: 'work',
      description: 'initial evidence',
      createdAt: Date.now()
    });

    kernel.recordProof(instance.id, 'phase_a', {
      id: 'proof-1',
      type: 'agreement',
      description: 'updated approval',
      createdAt: Date.now()
    });

    const proofs = kernel.listPhaseProofs(instance.id, 'phase_a');
    expect(proofs).toHaveLength(1);
    expect(proofs[0].type).toBe('agreement');
    expect(proofs[0].description).toContain('updated');
  });

  it('tracks defects and exposes snapshot', () => {
    const kernel = new WorkflowKernel(mockEmitter());
    kernel.registerDefinition(createTestDefinition());
    const instance = kernel.createInstance('test_flow', 'session-5');

    kernel.updateDefect(instance.id, 'phase_a', 'defect-1', 'open', 'critical');
    let defects = kernel.listOpenDefects(instance.id, 'phase_a');
    expect(defects).toHaveLength(1);
    expect(defects[0].severity).toBe('critical');

    kernel.updateDefect(instance.id, 'phase_a', 'defect-1', 'closed');
    defects = kernel.listOpenDefects(instance.id, 'phase_a');
    expect(defects).toHaveLength(0);
  });

  it('records and resolves user interventions', () => {
    const kernel = new WorkflowKernel(mockEmitter());
    kernel.registerDefinition(createTestDefinition());
    const instance = kernel.createInstance('test_flow', 'session-6');
    const note = kernel.recordUserIntervention(instance.id, 'phase_a', {
      messageId: 'msg-1',
      sessionId: 'session-6',
      content: 'Need additional clarification'
    });
    expect(note.status).toBe('pending');
    kernel.linkUserInterventionTask(instance.id, 'phase_a', note.id, 'task-followup');
    const state = kernel.getPhaseState(instance.id, 'phase_a');
    const storedNotes = state?.metadata?.user_notes || [];
    expect(storedNotes).toHaveLength(1);
    expect(storedNotes[0].followupTaskId).toBe('task-followup');
    kernel.resolveUserIntervention(instance.id, 'phase_a', note.id);
    const resolved = kernel.getPhaseState(instance.id, 'phase_a')?.metadata?.user_notes?.[0];
    expect(resolved?.status).toBe('resolved');
    const resolvedViaLookup = kernel.resolveUserInterventionByNoteId(note.id);
    expect(resolvedViaLookup).toBe(false);
  });
});
