import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: vi.fn().mockResolvedValue({}),
  },
  window: {
    showTextDocument: vi.fn().mockResolvedValue(undefined)
  }
}));

import type * as vscode from 'vscode';
import { TypedEventEmitter } from '../../events/emitter';
import { IntegrationBridge } from '../integration-bridge';

describe('IntegrationBridge', () => {
  let tempDir: string;
  let events: TypedEventEmitter;
  let bridge: IntegrationBridge;
  const output = { appendLine: vi.fn() } as unknown as vscode.OutputChannel;
  const fakeContext = {
    subscriptions: []
  } as unknown as vscode.ExtensionContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arranger-integration-'));
    events = new TypedEventEmitter();
    bridge = new IntegrationBridge(tempDir, events, output);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK'
    }) as any;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('dispatches workflow events to configured webhooks', async () => {
    const configPath = path.join(tempDir, '.arranger', 'integrations.json');
    bridge.start(fakeContext);
    const config = {
      webhooks: [
        {
          id: 'test-hook',
          event: 'workflow_event',
          url: 'https://example.com/hook',
          enabled: true
        }
      ]
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    bridge.reload();
    events.emit('workflow_event', {
      type: 'phase_enter',
      workflowId: 'universal_flow_v1',
      instanceId: 'instance-1',
      phaseId: 'clarify',
      timestamp: Date.now()
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
