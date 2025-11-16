import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { WorkflowKernel } from '../workflow-kernel';
import { TypedEventEmitter } from '../../events/emitter';
import { WorkflowTemplateService } from '../workflow-template.service';
import { WorkspaceConfigManager } from '../../config/workspace-config';

const createTempWorkspace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arranger-template-'));
  const workflowsDir = path.join(dir, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  const templateContent = {
    id: 'template_a',
    name: 'Template A',
    version: '1.0.0',
    phases: [
      {
        id: 'phase_a',
        title: 'A',
        exit: {}
      }
    ]
  };
  fs.writeFileSync(path.join(workflowsDir, 'template_a.json'), JSON.stringify(templateContent, null, 2), 'utf-8');
  fs.writeFileSync(
    path.join(workflowsDir, 'templates.json'),
    JSON.stringify({
      templates: [
        {
          id: 'template_a',
          name: 'Template A',
          path: 'template_a.json'
        }
      ]
    }, null, 2),
    'utf-8'
  );
  return dir;
};

describe('WorkflowTemplateService', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads templates and applies active definition', () => {
    const emitter = new TypedEventEmitter();
    const kernel = new WorkflowKernel(emitter);
    const configManager = new WorkspaceConfigManager(tempDir);
    configManager.update({ workflowTemplateId: 'template_a' });
    const output = { appendLine: vi.fn() } as any;
    const fakeContext = {
      extensionPath: tempDir,
      subscriptions: []
    } as unknown as vscode.ExtensionContext;
    const service = new WorkflowTemplateService(
      fakeContext,
      kernel,
      emitter,
      output,
      configManager
    );
    service.initialize();
    expect(service.getActiveTemplateId()).toBe('template_a');
    expect(kernel.getDefinition('template_a')).toBeTruthy();
  });

  it('persists selected template to config', () => {
    const emitter = new TypedEventEmitter();
    const kernel = new WorkflowKernel(emitter);
    const configManager = new WorkspaceConfigManager(tempDir);
    configManager.update({ workflowTemplateId: 'template_a' });
    const output = { appendLine: vi.fn() } as any;
    const fakeContext = {
      extensionPath: tempDir,
      subscriptions: []
    } as unknown as vscode.ExtensionContext;
    const service = new WorkflowTemplateService(
      fakeContext,
      kernel,
      emitter,
      output,
      configManager
    );
    service.initialize();
    const cfg = configManager.read();
    expect(cfg.workflowTemplateId).toBe('template_a');
  });

  it('falls back to available template when stored template is missing', () => {
    const emitter = new TypedEventEmitter();
    const kernel = new WorkflowKernel(emitter);
    const configManager = new WorkspaceConfigManager(tempDir);
    configManager.update({ workflowTemplateId: 'missing_template' });
    const output = { appendLine: vi.fn() } as any;
    const fakeContext = {
      extensionPath: tempDir,
      subscriptions: []
    } as unknown as vscode.ExtensionContext;
    const service = new WorkflowTemplateService(
      fakeContext,
      kernel,
      emitter,
      output,
      configManager
    );
    service.initialize();
    expect(service.getActiveTemplateId()).toBe('template_a');
    expect(configManager.read().workflowTemplateId).toBe('template_a');
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('Template missing_template not found'));
  });
});
