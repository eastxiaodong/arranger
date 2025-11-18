import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TypedEventEmitter } from '../../core/events/emitter';
import type { ProofRecord } from '../../core/types';

interface IntegrationConfig {
  webhooks?: IntegrationWebhook[];
}

interface IntegrationWebhook {
  id: string;
  name?: string;
  event: 'workflow_event' | 'sentinel_event' | 'proof_attested';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

type IntegrationEventTarget = IntegrationWebhook['event'];

export class IntegrationBridge implements vscode.Disposable {
  private readonly configDir: string;
  private readonly configPath: string;
  private config: IntegrationConfig = {};
  private disposed = false;
  private fileWatcher: fs.FSWatcher | null = null;
  private subscribed = false;
  private templateTargets: IntegrationEventTarget[] = [];
  private readonly proofHandler = (record: ProofRecord) => {
    void this.dispatch('proof_attested', record);
  };

  constructor(
    private readonly workspaceRoot: string,
    private readonly events: TypedEventEmitter,
    private readonly output: vscode.OutputChannel
  ) {
    this.configDir = path.join(this.workspaceRoot, '.arranger');
    this.configPath = path.join(this.configDir, 'integrations.json');
  }

  start(context: vscode.ExtensionContext) {
    this.ensureConfig();
    this.loadConfig();
    this.watchConfigFile();
    context.subscriptions.push(this);
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe();
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  openConfig() {
    void vscode.workspace.openTextDocument(this.configPath).then(doc => {
      void vscode.window.showTextDocument(doc, { preview: false });
    });
  }

  reload() {
    this.loadConfig();
  }

  setTemplateTargets(targets: IntegrationEventTarget[]) {
    this.templateTargets = Array.isArray(targets) ? targets : [];
    this.mergeTemplateTargetsIntoConfig();
  }

  private ensureConfig() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    if (!fs.existsSync(this.configPath)) {
      const sample: IntegrationConfig = {
        webhooks: [
          {
            id: 'sample-ci',
            name: 'Sample CI',
            event: 'workflow_event',
            url: 'https://example.com/webhook',
            enabled: false
          }
        ]
      };
      fs.writeFileSync(this.configPath, JSON.stringify(sample, null, 2), 'utf-8');
    }
  }

  private loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(raw) as IntegrationConfig;
      this.output.appendLine('[Integration] Configuration loaded');
      this.updateSubscription();
      this.mergeTemplateTargetsIntoConfig();
    } catch (error) {
      this.output.appendLine(`[Integration] Failed to load configuration: ${error}`);
      this.config = {};
      this.updateSubscription();
    }
  }

  private async dispatch(eventType: IntegrationWebhook['event'], payload: any) {
    const webhooks = (this.config.webhooks ?? []).filter(hook => hook.event === eventType && hook.enabled !== false);
    if (webhooks.length === 0) {
      return;
    }
    await Promise.all(webhooks.map(async (hook) => {
      try {
        const response = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(hook.headers ?? {})
          },
          body: JSON.stringify({
            event: eventType,
            data: payload
          })
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        this.output.appendLine(`[Integration] Webhook ${hook.id}(${eventType}) dispatched`);
      } catch (error) {
        this.output.appendLine(`[Integration] Webhook ${hook.id} failed: ${error instanceof Error ? error.message : error}`);
      }
    }));
  }

  private watchConfigFile() {
    try {
      if (this.fileWatcher) {
        this.fileWatcher.close();
      }
      this.fileWatcher = fs.watch(this.configPath, { persistent: false }, () => {
        this.loadConfig();
      });
    } catch (error) {
      this.output.appendLine(`[Integration] Failed to watch configuration: ${error instanceof Error ? error.message : error}`);
    }
  }

  private hasActiveWebhooks() {
    return (this.config.webhooks ?? []).some(hook => hook.enabled !== false && hook.url && hook.url.trim().length > 0);
  }

  private updateSubscription() {
    if (this.hasActiveWebhooks()) {
      this.subscribe();
    } else {
      this.unsubscribe();
    }
  }

  private subscribe() {
    if (this.subscribed) {
      return;
    }
    this.events.on('proof_attested', this.proofHandler);
    this.subscribed = true;
    this.output.appendLine('[Integration] Event subscriptions activated');
  }

  private unsubscribe() {
    if (!this.subscribed) {
      return;
    }
    this.events.off('proof_attested', this.proofHandler);
    this.subscribed = false;
    this.output.appendLine('[Integration] Event subscriptions paused (no active webhooks)');
  }

  private mergeTemplateTargetsIntoConfig() {
    if (!this.templateTargets.length) {
      return;
    }
    const webhooks = this.config.webhooks ?? (this.config.webhooks = []);
    let mutated = false;
    for (const target of this.templateTargets) {
      const placeholderId = `template-${target}`;
      if (!webhooks.some(hook => hook.id === placeholderId)) {
        webhooks.push({
          id: placeholderId,
          name: `模板示例 (${target})`,
          event: target,
          url: '',
          enabled: false
        });
        mutated = true;
      }
    }
    if (mutated) {
      try {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
        this.output.appendLine('[Integration] Template targets merged into integrations.json');
      } catch (error) {
        this.output.appendLine(`[Integration] Failed to update integration config: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.updateSubscription();
  }
}
