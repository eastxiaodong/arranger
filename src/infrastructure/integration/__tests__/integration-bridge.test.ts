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
import { TypedEventEmitter } from '../../../core/events/emitter';
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


});
