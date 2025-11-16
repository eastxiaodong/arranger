import * as vscode from 'vscode';
import type { TypedEventEmitter } from '../events/emitter';
import type { Services } from '../services';
import type { WorkflowKernel } from './workflow-kernel';
import type { BlackboardEntry } from '../types';
import { classifyScenarioFromText, mergeScenarioValues, normalizeScenarioId } from './scenario-registry';

interface ScenarioInfo {
  values: string[];
  confidence?: number;
  source: string;
}

export class WorkflowOrchestrator implements vscode.Disposable {
  private disposed = false;
  private readonly sessionDefaultInstanceMap = new Map<string, string>();
  private readonly sessionScenarioIndex = new Map<string, Map<string, string>>();
  private readonly handledBootstrapMessageIds = new Set<string>();
  private messageListener: ((messages: BlackboardEntry[]) => void) | null = null;

  constructor(
    private readonly kernel: WorkflowKernel,
    private readonly services: Services,
    private readonly events: TypedEventEmitter,
    private readonly output: vscode.OutputChannel,
    private defaultWorkflowId: string
  ) {}

  start(context: vscode.ExtensionContext) {
    if (this.messageListener) {
      return;
    }
    this.messageListener = (messages) => this.handleMessages(messages);
    this.events.on('messages_update', this.messageListener);
    context.subscriptions.push(this);
    this.output.appendLine('[Workflow] Orchestrator started');
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.messageListener) {
      this.events.off('messages_update', this.messageListener);
      this.messageListener = null;
    }
    this.sessionDefaultInstanceMap.clear();
    this.sessionScenarioIndex.clear();
    this.handledBootstrapMessageIds.clear();
  }

  setDefaultWorkflowId(workflowId: string) {
    this.defaultWorkflowId = workflowId;
    this.sessionDefaultInstanceMap.clear();
    this.sessionScenarioIndex.clear();
    this.handledBootstrapMessageIds.clear();
    this.output.appendLine(`[Workflow] Orchestrator switched to template ${workflowId}, upcoming requirements will use the new workflow`);
  }

  private handleMessages(messages: BlackboardEntry[]) {
    if (!messages || messages.length === 0) {
      return;
    }
    const sorted = [...messages]
      .filter(message => Boolean(message.session_id))
      .sort((a, b) => a.created_at - b.created_at);
    sorted.forEach(message => {
      const scenarioInfo = this.extractScenarioInfo(message);
      this.persistSessionScenarioMetadata(message, scenarioInfo);
      if (!this.shouldBootstrapForMessage(message, scenarioInfo)) {
        return;
      }
      if (this.handledBootstrapMessageIds.has(message.id)) {
        return;
      }
      this.handledBootstrapMessageIds.add(message.id);
      this.ensureInstancesForMessage(message, scenarioInfo);
    });
  }

  private ensureInstancesForMessage(message: BlackboardEntry, scenarioInfo?: ScenarioInfo | null) {
    const sessionId = message.session_id;
    if (!sessionId) {
      this.output.appendLine('[Workflow] Message missing session_id, skipping bootstrap');
      return;
    }
    const scenarioValues = scenarioInfo?.values?.length ? scenarioInfo.values : ['new_feature'];
    scenarioValues.forEach(value => {
      const instanceId = this.ensureInstanceForScenario(sessionId, value, message, scenarioInfo);
      if (instanceId) {
        this.maybeRecordInitialArtifact(instanceId, message);
      }
    });
  }

  private shouldBootstrapForMessage(message: BlackboardEntry, scenarioInfo?: ScenarioInfo | null): boolean {
    if (!message.session_id) {
      return false;
    }
    if (!this.isHumanMessage(message)) {
      return false;
    }
    if (message.message_type === 'requirement') {
      return true;
    }
    return Boolean(scenarioInfo && scenarioInfo.values.length > 0);
  }

  private isHumanMessage(message: BlackboardEntry): boolean {
    const agentId = (message.agent_id || '').toLowerCase();
    return agentId === 'user' || agentId === 'customer';
  }

  private extractScenarioInfo(message: BlackboardEntry): ScenarioInfo | null {
    const values: string[] = [];
    let confidence: number | undefined;
    let source = 'default';
    const payloadScenario = message.payload?.scenario;
    if (payloadScenario) {
      const merged = mergeScenarioValues(values, payloadScenario);
      values.splice(0, values.length, ...merged);
      source = message.payload?.scenario_source || 'payload';
      if (typeof message.payload?.scenario_confidence === 'number') {
        confidence = message.payload.scenario_confidence;
      }
    }
    const tagScenarios = (message.tags || [])
      .filter(tag => tag.startsWith('scenario:'))
      .map(tag => tag.replace('scenario:', ''));
    if (tagScenarios.length > 0) {
      const merged = mergeScenarioValues(values, tagScenarios);
      values.splice(0, values.length, ...merged);
      source = 'tag';
    }
    if (!values.length && message.session_id) {
      const session = this.services.session.getSession(message.session_id);
      if (session?.metadata?.scenario) {
        const merged = mergeScenarioValues(values, session.metadata.scenario);
        if (merged.length > 0) {
          values.splice(0, values.length, ...merged);
          source = 'session_metadata';
          confidence = confidence ?? session.metadata?.scenario_confidence;
        }
      }
    }
    if (!values.length && this.isHumanMessage(message)) {
      const match = classifyScenarioFromText(message.content || '');
      if (match) {
        const merged = mergeScenarioValues(values, match.scenarioId);
        values.splice(0, values.length, ...merged);
        confidence = match.confidence;
        source = 'classifier';
      }
    }
    if (!values.length && this.isHumanMessage(message)) {
      values.push('new_feature');
      source = 'default';
    }
    if (!values.length) {
      return null;
    }
    return {
      values,
      confidence,
      source
    };
  }

  private persistSessionScenarioMetadata(message: BlackboardEntry, info?: ScenarioInfo | null) {
    if (!message.session_id || !info || info.values.length === 0) {
      return;
    }
    const session = this.services.session.getSession(message.session_id);
    const merged = mergeScenarioValues(session?.metadata?.scenario, info.values);
    this.services.session.mergeMetadata(message.session_id, {
      scenario: merged,
      scenario_confidence: info.confidence,
      scenario_source: info.source,
      scenario_updated_at: Date.now()
    });
  }

  private ensureInstanceForScenario(
    sessionId: string,
    scenarioId: string,
    message: BlackboardEntry,
    scenarioInfo?: ScenarioInfo | null
  ): string | null {
    const normalized = normalizeScenarioId(scenarioId);
    let mapping = this.sessionScenarioIndex.get(sessionId);
    if (!mapping) {
      mapping = new Map<string, string>();
      this.sessionScenarioIndex.set(sessionId, mapping);
    }
    const existing = mapping.get(normalized);
    if (existing) {
      this.updateInstanceScenarioMetadata(existing, scenarioInfo, message);
      return existing;
    }
    try {
      const instance = this.kernel.createInstance(
        this.defaultWorkflowId,
        sessionId,
        {
          requirementMessageId: message.id,
          requirementContent: message.content,
          scenario: [normalized],
          scenario_confidence: scenarioInfo?.confidence,
          scenario_source: scenarioInfo?.source ?? 'default'
        }
      );
      mapping.set(normalized, instance.id);
      if (!this.sessionDefaultInstanceMap.has(sessionId)) {
        this.sessionDefaultInstanceMap.set(sessionId, instance.id);
      }
      this.output.appendLine(`[Workflow] Created workflow instance ${instance.id} for session ${sessionId} · scenario=${normalized}`);
      return instance.id;
    } catch (error: any) {
      this.output.appendLine(`[Workflow] Failed to initialize workflow for session ${sessionId}: ${error?.message ?? error}`);
      return null;
    }
  }

  private maybeRecordInitialArtifact(instanceId: string, message: BlackboardEntry) {
    const definition = this.kernel.getDefinition(this.defaultWorkflowId);
    const firstPhase = definition?.phases[0];
    if (!firstPhase) {
      return;
    }
    const existingProofs = this.kernel.listPhaseProofs(instanceId, firstPhase.id);
    if (existingProofs.length > 0) {
      return;
    }
    this.kernel.recordArtifact(instanceId, firstPhase.id, {
      id: `requirement:${message.id}`,
      type: 'requirement',
      description: message.content,
      createdAt: Date.now(),
      createdBy: message.agent_id,
      payload: {
        messageId: message.id
      }
    });
  }

  private updateInstanceScenarioMetadata(instanceId: string, info?: ScenarioInfo | null, message?: BlackboardEntry) {
    if (!info || info.values.length === 0) {
      return;
    }
    const instance = this.kernel.getInstance(instanceId);
    if (!instance) {
      return;
    }
    const currentScenarios = mergeScenarioValues(instance.metadata?.scenario, []);
    const nextScenarios = mergeScenarioValues(currentScenarios, info.values);
    if (this.sameScenarioList(currentScenarios, nextScenarios)) {
      return;
    }
    this.kernel.updateInstanceMetadata(instanceId, {
      scenario: nextScenarios,
      scenario_confidence: info.confidence ?? instance.metadata?.scenario_confidence,
      scenario_source: info.source ?? instance.metadata?.scenario_source,
      scenario_updated_at: Date.now(),
      last_message_id: message?.id ?? instance.metadata?.last_message_id
    });
  }

  private sameScenarioList(current: string[] | string | null | undefined, next: string[]): boolean {
    const currentList = mergeScenarioValues(current, []);
    if (currentList.length !== next.length) {
      return false;
    }
    const set = new Set(currentList);
    return next.every(value => set.has(value));
  }

}
