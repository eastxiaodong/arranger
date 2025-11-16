import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from '../../database';
import { TypedEventEmitter } from '../../events/emitter';
import { ProofService } from '../proof.service';
import { GovernanceHistoryService } from '../governance-history.service';

describe('ProofService', () => {
  let db: DatabaseManager;
  let events: TypedEventEmitter;
  let governance: GovernanceHistoryService;
  let service: ProofService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arranger-proof-'));
    const dbPath = path.join(tempDir, 'arranger.db');
    db = await DatabaseManager.create(dbPath);
    events = new TypedEventEmitter();
    governance = new GovernanceHistoryService(db, events);
    service = new ProofService(db, events, governance);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records proofs and updates attestation', () => {
    const created = service.recordProof({
      id: 'proof:test-1',
      sessionId: 'session-1',
      workflowId: 'universal_flow_v1',
      workflowInstanceId: 'instance-1',
      phaseId: 'verify',
      proofType: 'work',
      taskId: 'task-1',
      description: '测试日志',
      acknowledgers: []
    });
    expect(created.attestation_status).toBe('pending');
    const updated = service.attestProof({
      proofId: created.id,
      attestorId: 'qa_lead',
      status: 'approved',
      note: '验证通过'
    });
    expect(updated.attestation_status).toBe('approved');
    expect(updated.attestor_id).toBe('qa_lead');
    const history = governance.getEntries({ type: 'proof' });
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('generates markdown report with stats', () => {
    service.recordProof({
      id: 'proof:test-2',
      sessionId: 'session-1',
      workflowId: 'universal_flow_v1',
      workflowInstanceId: 'instance-2',
      phaseId: 'delivery',
      proofType: 'agreement',
      taskId: 'task-2',
      description: '发布批准',
      acknowledgers: ['release_manager']
    });
    const report = service.generateReport({ sessionId: 'session-1' });
    expect(report.markdown).toContain('# Proof Report');
    expect(report.markdown).toContain('Phase delivery');
    expect(report.stats.total).toBeGreaterThan(0);
  });
});
