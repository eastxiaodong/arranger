import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { WorkflowDefinition } from './workflow-types';
import { loadWorkflowDefinitionFromFile } from './workflow-loader';
import type { WorkflowKernel } from './workflow-kernel';
import type { TypedEventEmitter } from '../events/emitter';
import type { WorkspaceConfigManager } from '../config/workspace-config';

export interface WorkflowTemplateDescriptor {
  id: string;
  name: string;
  description?: string;
  path: string;
  tags?: string[];
}

interface TemplatesFile {
  templates: WorkflowTemplateDescriptor[];
}

type IntegrationEventType = 'workflow_event' | 'sentinel_event' | 'proof_attested';

export class WorkflowTemplateService {
  private templates: WorkflowTemplateDescriptor[] = [];
  private activeTemplateId: string | null = null;
  private readonly templatesFile: string;
  private activeMetadata: Record<string, any> | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly kernel: WorkflowKernel,
    private readonly events: TypedEventEmitter,
    private readonly output: vscode.OutputChannel,
    private readonly workspaceConfig: WorkspaceConfigManager,
    options?: {
      templatesFile?: string;
    }
  ) {
    this.templatesFile = options?.templatesFile
      ?? path.join(this.context.extensionPath, 'workflows', 'templates.json');
  }

  initialize() {
    this.loadTemplateLibrary();
    const config = this.workspaceConfig.read();
    const fallback = this.templates[0]?.id ?? 'universal_flow_v1';
    let targetId = config.workflowTemplateId || fallback;
    const exists = this.templates.some(template => template.id === targetId);
    if (!exists) {
      this.output.appendLine(`[Workflow] Template ${targetId} not found, fallback to ${fallback}`);
      targetId = fallback;
      this.workspaceConfig.update({ workflowTemplateId: targetId });
    }
    this.applyTemplate(targetId, { silent: true });
  }

  listTemplates(): WorkflowTemplateDescriptor[] {
    return [...this.templates];
  }

  getActiveTemplateId(): string {
    return this.activeTemplateId ?? (this.templates[0]?.id ?? 'universal_flow_v1');
  }

  getActiveTemplate(): WorkflowTemplateDescriptor | null {
    const id = this.getActiveTemplateId();
    return this.templates.find(template => template.id === id) ?? null;
  }

  getActiveTemplateMetadata(): Record<string, any> | null {
    return this.activeMetadata;
  }

  getActiveIntegrationTargets(): IntegrationEventType[] {
    const metadata = this.activeMetadata;
    if (!metadata || !Array.isArray(metadata.integration_targets)) {
      return [];
    }
    return metadata.integration_targets.filter((item: unknown): item is IntegrationEventType =>
      item === 'workflow_event' || item === 'sentinel_event' || item === 'proof_attested'
    );
  }

  applyTemplate(templateId: string, options?: { silent?: boolean }) {
    const template = this.templates.find(item => item.id === templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }
    const filePath = path.join(this.context.extensionPath, 'workflows', template.path);
    const definition = this.loadDefinition(filePath);
    const phasesMeta = definition.phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      description: phase.description ?? '',
      scenarioTags: phase.scenario_tags ?? [],
      requireArtifacts: Array.isArray(phase.exit?.require_artifacts) && phase.exit!.require_artifacts!.length > 0,
      requireDecisions: phase.exit?.require_decisions ?? []
    }));
    this.activeMetadata = {
      ...(definition.metadata ?? {}),
      phases: phasesMeta
    };
    this.kernel.registerDefinition(definition);
    this.workspaceConfig.update({ workflowTemplateId: templateId });
    this.activeTemplateId = templateId;
    if (!options?.silent) {
      this.output.appendLine(`[Workflow] Activated template ${template.name} (${template.id})`);
    }
    this.events.emit('workflow_template_update', {
      id: template.id,
      name: template.name,
      description: template.description ?? '',
      metadata: this.activeMetadata ?? undefined
    });
  }

  private loadTemplateLibrary() {
    try {
      const raw = fs.readFileSync(this.templatesFile, 'utf-8');
      const parsed = JSON.parse(raw) as TemplatesFile;
      this.templates = Array.isArray(parsed.templates) ? parsed.templates : [];
      if (this.templates.length === 0) {
        throw new Error('No workflow templates defined');
      }
    } catch (error) {
      this.output.appendLine(`[Workflow] Failed to load templates: ${error instanceof Error ? error.message : error}`);
      this.templates = [{
        id: 'universal_flow_v1',
        name: 'Universal Flow',
        path: 'universal_flow_v1.json',
        description: 'Default workflow template'
      }];
    }
  }

  private loadDefinition(filePath: string): WorkflowDefinition {
    return loadWorkflowDefinitionFromFile(filePath);
  }
}
