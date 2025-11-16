import { DatabaseManager } from '../database';
import { TypedEventEmitter } from '../events/emitter';
import type { GovernanceHistoryService } from './governance-history.service';
import type {
  ProofRecord,
  ProofReportResult
} from '../types';

interface RecordProofInput {
  id: string;
  sessionId: string | null;
  workflowId: string;
  workflowInstanceId: string;
  phaseId: string;
  proofType: ProofRecord['proof_type'];
  taskId?: string | null;
  description?: string | null;
  evidenceUri?: string | null;
  hash?: string | null;
  acknowledgers?: string[];
  createdBy?: string | null;
  metadata?: Record<string, any> | null;
}

interface ProofFilters {
  session_id?: string | null;
  workflow_instance_id?: string;
  workflow_id?: string;
  phase_id?: string;
  attestation_status?: ProofRecord['attestation_status'];
}

interface AttestProofInput {
  proofId: string;
  attestorId: string;
  status: ProofRecord['attestation_status'];
  note?: string | null;
}

export class ProofService {
  constructor(
    private readonly db: DatabaseManager,
    private readonly events: TypedEventEmitter,
    private readonly governance?: GovernanceHistoryService
  ) {}

  recordProof(input: RecordProofInput): ProofRecord {
    const normalizedAck = input.acknowledgers?.filter(Boolean) ?? [];
    const shouldAutoApprove = input.proofType === 'agreement' && normalizedAck.length > 0;
    const attestationStatus: ProofRecord['attestation_status'] = shouldAutoApprove ? 'approved' : 'pending';
    const attestorId = shouldAutoApprove ? normalizedAck[0] ?? input.createdBy ?? null : null;
    const attestedAt = shouldAutoApprove ? Date.now() : null;

    const record = this.db.upsertProofRecord({
      id: input.id,
      session_id: input.sessionId,
      workflow_id: input.workflowId,
      workflow_instance_id: input.workflowInstanceId,
      phase_id: input.phaseId,
      proof_type: input.proofType,
      task_id: input.taskId ?? null,
      description: input.description ?? null,
      evidence_uri: input.evidenceUri ?? null,
      hash: input.hash ?? null,
      acknowledgers: normalizedAck.length ? normalizedAck : null,
      created_by: input.createdBy ?? null,
      metadata: input.metadata ?? null,
      attestation_status: attestationStatus,
      attestor_id: attestorId,
      attested_at: attestedAt
    });

    this.logHistory(record, 'proof_recorded', input.createdBy ?? 'workflow');
    this.broadcast();
    return record;
  }

  listProofRecords(filters?: ProofFilters): ProofRecord[] {
    return this.db.getProofRecords(filters);
  }

  attestProof(input: AttestProofInput): ProofRecord {
    if (!input.proofId) {
      throw new Error('Proof ID 不能为空');
    }
    if (!input.attestorId) {
      throw new Error('需要提供签署人信息');
    }
    if (input.status !== 'approved' && input.status !== 'rejected') {
      throw new Error('只支持批准或驳回 Proof');
    }
    const updated = this.db.updateProofAttestation(input.proofId, {
      attestation_status: input.status,
      attestor_id: input.attestorId,
      attestation_note: input.note ?? null
    });
    if (!updated) {
      throw new Error(`未找到 Proof ${input.proofId}`);
    }
    const action = input.status === 'approved' ? 'proof_attested' : 'proof_rejected';
    this.logHistory(updated, action, input.attestorId, input.note ?? undefined);
    this.broadcast();
    if (updated.attestation_status !== 'pending') {
      this.events.emit('proof_attested', updated);
    }
    return updated;
  }

  generateReport(options: {
    sessionId?: string | null;
    workflowInstanceId?: string;
  }): ProofReportResult {
    const filters: ProofFilters = {};
    if (options.sessionId) {
      filters.session_id = options.sessionId;
    }
    if (options.workflowInstanceId) {
      filters.workflow_instance_id = options.workflowInstanceId;
    }
    const records = this.db.getProofRecords(filters);
    if (records.length === 0) {
      throw new Error('当前筛选条件下没有可用的 Proof 数据');
    }
    const now = Date.now();
    const workflowId = records[0].workflow_id;
    const instanceId = records[0].workflow_instance_id;
    const stats = records.reduce((acc, record) => {
      acc.total += 1;
      acc[record.attestation_status] = (acc[record.attestation_status] || 0) + 1;
      return acc;
    }, {
      total: 0,
      approved: 0,
      pending: 0,
      rejected: 0
    } as Record<'total' | ProofRecord['attestation_status'], number>);

    const grouped = new Map<string, ProofRecord[]>();
    records
      .sort((a, b) => a.created_at - b.created_at)
      .forEach(record => {
        if (!grouped.has(record.phase_id)) {
          grouped.set(record.phase_id, []);
        }
        grouped.get(record.phase_id)!.push(record);
      });

    const lines: string[] = [
      '# Proof Report',
      '',
      `- Workflow: ${workflowId}`,
      `- Workflow Instance: ${instanceId}`,
      `- Session: ${records[0].session_id ?? options.sessionId ?? 'N/A'}`,
      `- Generated At: ${new Date(now).toISOString()}`,
      '',
      '## Summary',
      `- Total Proofs: ${stats.total}`,
      `- Approved: ${stats.approved}`,
      `- Pending: ${stats.pending}`,
      `- Rejected: ${stats.rejected}`,
      ''
    ];

    grouped.forEach((phaseRecords, phaseId) => {
      lines.push(`## Phase ${phaseId}`);
      phaseRecords.forEach(record => {
        const title = record.description || record.task_id || record.id;
        const createdAt = new Date(record.created_at).toISOString();
        const attested = record.attested_at ? new Date(record.attested_at).toISOString() : '—';
        lines.push(`- [${record.proof_type}] ${title}`);
        lines.push(`  - 状态: ${record.attestation_status.toUpperCase()}`);
        lines.push(`  - 任务: ${record.task_id ?? 'N/A'}`);
        lines.push(`  - 证据: ${record.evidence_uri ?? 'N/A'}`);
        lines.push(`  - 哈希: ${record.hash ?? 'N/A'}`);
        lines.push(`  - 提交时间: ${createdAt}`);
        lines.push(`  - 签署时间: ${attested}`);
        lines.push(`  - 签署人: ${record.attestor_id ?? '待定'}`);
        if (record.attestation_note) {
          lines.push(`  - 备注: ${record.attestation_note}`);
        }
      });
      lines.push('');
    });

    return {
      session_id: records[0].session_id ?? options.sessionId ?? null,
      workflow_id: workflowId,
      workflow_instance_id: instanceId,
      generated_at: now,
      stats: {
        total: stats.total,
        approved: stats.approved,
        pending: stats.pending,
        rejected: stats.rejected
      },
      markdown: lines.join('\n')
    };
  }

  private logHistory(record: ProofRecord, action: string, actorId?: string | null, note?: string) {
    if (!this.governance) {
      return;
    }
    this.governance.recordEntry({
      session_id: record.session_id ?? 'default',
      type: 'proof',
      entity_id: record.id,
      action,
      actor_id: actorId ?? null,
      summary: `[${record.proof_type}] ${record.phase_id}`,
      payload: {
        workflow_id: record.workflow_id,
        workflow_instance_id: record.workflow_instance_id,
        phase_id: record.phase_id,
        attestation_status: record.attestation_status,
        attestation_note: note ?? undefined
      }
    });
  }

  private broadcast() {
    const all = this.db.getProofRecords();
    this.events.emit('proof_records_update', all);
  }
}
