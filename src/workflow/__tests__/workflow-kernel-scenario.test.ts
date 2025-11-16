import { describe, it, expect, beforeEach } from 'vitest';
import { TypedEventEmitter } from '../../events/emitter';
import { WorkflowKernel } from '../workflow-kernel';
import type { WorkflowDefinition } from '../workflow-types';

const buildDefinition = (): WorkflowDefinition => ({
  id: 'universal_test',
  name: 'Universal Scenario Test',
  version: '1.0.0',
  description: 'Covers new_feature and doc_work branches',
  phases: [
    {
      id: 'intake_alignment',
      title: '对齐',
      exit: {}
    },
    {
      id: 'clarify',
      title: 'Clarify',
      dependencies: ['intake_alignment'],
      scenario_tags: ['new_feature'],
      exit: {}
    },
    {
      id: 'doc_outline',
      title: 'Doc Outline',
      dependencies: ['intake_alignment'],
      scenario_tags: ['doc_work'],
      exit: {}
    }
  ]
});

describe('WorkflowKernel scenario-aware activation', () => {
  let kernel: WorkflowKernel;

  beforeEach(() => {
    kernel = new WorkflowKernel(new TypedEventEmitter());
    kernel.registerDefinition(buildDefinition());
  });

  it('activates feature phases for new_feature scenario', () => {
    const instance = kernel.createInstance('universal_test', 'session-feature', {
      scenario: ['new_feature']
    });
    expect(instance.phaseState.intake_alignment.status).toBe('active');
    // clarify should enter because scenario matches
    expect(instance.phaseState.clarify.status).toBe('pending'); // dependencies not completed yet
    // doc phase should remain pending awaiting scenario
    expect(instance.phaseState.doc_outline.status).toBe('pending');
    expect(instance.phaseState.doc_outline.metadata?.scenario_pending).toBe(true);
  });

  it('activates doc phases when scenario includes doc_work', () => {
    const instance = kernel.createInstance('universal_test', 'session-doc', {
      scenario: ['doc_work']
    });
    expect(instance.phaseState.intake_alignment.status).toBe('active');
    expect(instance.phaseState.doc_outline.metadata?.scenario_pending).toBeUndefined();
  });

  it('skips scenario gated phases when metadata missing', () => {
    const instance = kernel.createInstance('universal_test', 'session-empty');
    expect(instance.phaseState.doc_outline.metadata?.scenario_pending).toBe(true);
    expect(instance.phaseState.clarify.metadata?.scenario_pending).toBe(true);
  });
});
