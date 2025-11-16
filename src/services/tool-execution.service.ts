import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import type { DatabaseManager } from '../database';
import type { TypedEventEmitter } from '../events/emitter';
import type { Services } from '.';
import type { Task, ToolRun } from '../types';
import type { WorkflowKernel } from '../workflow';

interface CommandAutomationConfig {
  type: 'command';
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  auto?: boolean;
  repeatable?: boolean;
  summary?: string;
  message?: string;
  proof?: {
    phase_id?: string;
    proof_type?: 'work' | 'agreement';
    description?: string;
  };
  tool_name?: string;
  runner?: string;
  source?: string;
  created_by?: string;
  notify_on_fail?: boolean;
  attachments?: {
    files?: string[];
    links?: string[];
    notes?: string[];
  };
  metadata?: Record<string, any> | null;
}

type AutomationConfig = CommandAutomationConfig;

const DEFAULT_OUTPUT_LIMIT = 20000;

export class ToolExecutionService implements vscode.Disposable {
  private taskListener: ((tasks: Task[]) => void) | null = null;
  private disposed = false;
  private readonly runningTasks = new Set<string>();

  constructor(
    private readonly db: DatabaseManager,
    private readonly events: TypedEventEmitter,
    private readonly services: Services,
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel,
    private readonly workflowKernel?: WorkflowKernel | null
  ) {}

  start(context: vscode.ExtensionContext) {
    if (this.taskListener) {
      return;
    }
    this.taskListener = (tasks) => this.handleTasksUpdate(tasks);
    this.events.on('tasks_update', this.taskListener);
    context.subscriptions.push(this);
    this.broadcastRuns();
  }

  dispose() {
    if (this.taskListener) {
      this.events.off('tasks_update', this.taskListener);
      this.taskListener = null;
    }
    this.disposed = true;
  }

  recordExternalRunStart(run: {
    id: string;
    session_id?: string | null;
    task_id?: string | null;
    workflow_instance_id?: string | null;
    tool_name: string;
    runner?: string;
    source?: string;
    command?: string;
    input?: Record<string, any> | null;
    created_by?: string | null;
  }): ToolRun {
    const record = this.db.createToolRun({
      id: run.id,
      session_id: run.session_id ?? null,
      task_id: run.task_id ?? null,
      workflow_instance_id: run.workflow_instance_id ?? null,
      tool_name: run.tool_name,
      runner: run.runner || 'automation',
      source: run.source || 'external',
      command: run.command ?? null,
      input: run.input ?? null,
      output: null,
      status: 'running',
      exit_code: null,
      error: null,
      started_at: Date.now(),
      created_by: run.created_by ?? null,
      metadata: null,
      completed_at: null
    });
    this.broadcastRuns();
    return record;
  }

  recordExternalRunResult(runId: string, result: {
    status: 'succeeded' | 'failed';
    output?: Record<string, any> | null;
    exit_code?: number | null;
    error?: string | null;
  }): ToolRun | null {
    const updated = this.db.updateToolRun(runId, {
      status: result.status,
      output: result.output ?? null,
      exit_code: result.exit_code ?? null,
      error: result.error ?? null,
      completed_at: Date.now()
    });
    this.broadcastRuns();
    return updated;
  }

  async rerunAutomationFromRun(runId: string): Promise<void> {
    const run = this.db.getToolRun(runId);
    if (!run || !run.task_id) {
      throw new Error('无法重新执行：未找到对应运行或任务');
    }
    const task = this.services.task.getTask(run.task_id);
    if (!task) {
      throw new Error(`任务 ${run.task_id} 不存在`);
    }
    const automation = this.getAutomationConfig(task, { force: true });
    if (!automation) {
      throw new Error('该任务未配置自动化执行或已禁用');
    }
    await this.executeAutomation(task, automation, true);
  }

  private handleTasksUpdate(tasks: Task[]) {
    tasks.forEach(task => {
      const automation = this.getAutomationConfig(task);
      if (!automation) {
        return;
      }
      if (this.runningTasks.has(task.id)) {
        return;
      }
      if (task.status === 'completed' || task.status === 'failed') {
        return;
      }
      if (!automation.repeatable) {
        const existing = this.db.getToolRuns({ task_id: task.id, statuses: ['running', 'succeeded'] });
        if (existing.some(run => run.status === 'succeeded')) {
          return;
        }
      }
      void this.executeAutomation(task, automation, false);
    });
  }

  private getAutomationConfig(task: Task, options?: { force?: boolean }): AutomationConfig | null {
    const automation = task.metadata?.automation;
    if (!automation) {
      return null;
    }
    if (automation.type !== 'command') {
      return null;
    }
    if (!automation.command || (automation.auto === false && !options?.force)) {
      return null;
    }
    return {
      type: 'command',
      command: automation.command,
      cwd: automation.cwd,
      env: automation.env,
      auto: automation.auto !== false,
      repeatable: automation.repeatable ?? false,
      summary: automation.summary,
      message: automation.message,
      proof: automation.proof,
      tool_name: automation.tool_name,
      runner: automation.runner,
      source: automation.source,
      created_by: automation.created_by,
      notify_on_fail: automation.notify_on_fail !== false,
      attachments: automation.attachments,
      metadata: automation.metadata ?? null
    };
  }

  private async executeAutomation(task: Task, automation: AutomationConfig, manual: boolean) {
    if (automation.type !== 'command') {
      return;
    }
    this.runningTasks.add(task.id);
    const workflowInfo = this.extractWorkflowInfo(task.labels);
    const runId = `toolrun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const runRecord = this.db.createToolRun({
      id: runId,
      session_id: task.session_id,
      task_id: task.id,
      workflow_instance_id: workflowInfo.instanceId,
      tool_name: automation.tool_name || 'terminal_command',
      runner: automation.runner || 'automation',
      source: automation.source || (manual ? 'manual_rerun' : 'command_auto'),
      command: automation.command,
      input: {
        cwd: automation.cwd || '.',
        env: automation.env || null
      },
      output: null,
      status: 'running',
      exit_code: null,
      error: null,
      started_at: Date.now(),
      created_by: automation.created_by || 'workflow'
    });
    this.broadcastRuns(task.session_id || undefined);
    this.updateTaskAutomationMetadata(task, { last_run_id: runRecord.id, last_run_status: 'running' });

    try {
      const cwd = automation.cwd ? path.isAbsolute(automation.cwd) ? automation.cwd : path.join(this.workspaceRoot, automation.cwd) : this.workspaceRoot;
      const env = {
        ...process.env,
        ...(automation.env || {})
      };
      const { stdout, stderr, exitCode, duration } = await this.runCommand(automation.command, cwd, env);
      const outputPayload: Record<string, any> = {
        stdout,
        stderr,
        duration_ms: duration,
        cwd
      };
      if (automation.attachments) {
        outputPayload.attachments = automation.attachments;
      }
      if (automation.metadata) {
        outputPayload.metadata = automation.metadata;
      }
      const status = exitCode === 0 ? 'succeeded' : 'failed';
      this.db.updateToolRun(runRecord.id, {
        status,
        output: outputPayload,
        exit_code: exitCode,
        completed_at: Date.now()
      });
      this.broadcastRuns(task.session_id || undefined);

      if (exitCode === 0) {
        this.updateTaskAutomationMetadata(task, { last_run_status: 'succeeded', last_run_id: runRecord.id, last_run_at: Date.now() });
        await this.handleAutomationSuccess(task, automation, outputPayload, runRecord.id, workflowInfo);
      } else {
        this.updateTaskAutomationMetadata(task, { last_run_status: 'failed', last_run_id: runRecord.id, last_run_at: Date.now() });
        await this.handleAutomationFailure(task, automation, outputPayload, runRecord.id, workflowInfo, `命令退出码 ${exitCode}`);
      }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.db.updateToolRun(runRecord.id, {
        status: 'failed',
        error: message,
        completed_at: Date.now()
      });
      this.broadcastRuns(task.session_id || undefined);
      this.updateTaskAutomationMetadata(task, { last_run_status: 'failed', last_run_id: runRecord.id, last_run_at: Date.now() });
      await this.handleAutomationFailure(task, automation, { error: message }, runRecord.id, workflowInfo, message);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  private async handleAutomationSuccess(
    task: Task,
    automation: CommandAutomationConfig,
    output: Record<string, any>,
    runId: string,
    workflowInfo: { workflowId: string | null; instanceId: string | null; phaseIds: string[] }
  ) {
    const summary = automation.summary || `自动执行：${automation.command}`;
    const details = output.stdout || output.stderr || '命令已执行';
    const attachmentNote = this.buildAttachmentNote(automation.attachments);
    const messageBody = attachmentNote ? `${summary}\n${attachmentNote}` : summary;
    const artifacts: any[] = [{ type: 'tool_run', id: runId, command: automation.command }];
    if (automation.attachments?.files?.length) {
      automation.attachments.files.forEach(file => {
        artifacts.push({ type: 'file', path: file, source: 'tool_run', tool_run_id: runId });
      });
    }
    if (automation.attachments?.links?.length) {
      automation.attachments.links.forEach(link => {
        artifacts.push({ type: 'link', url: link, source: 'tool_run', tool_run_id: runId });
      });
    }
    this.services.task.completeTask(task.id, {
      summary,
      details,
      artifacts
    });
    this.publishMessage(task.session_id, `✅ ${task.title} 完成`, messageBody, runId, workflowInfo.instanceId);
    if (workflowInfo.instanceId && workflowInfo.workflowId && automation.proof) {
      const phaseId = automation.proof.phase_id || workflowInfo.phaseIds[0] || 'automation';
      this.services.proof.recordProof({
        id: `proof_${runId}`,
        sessionId: task.session_id,
        workflowId: workflowInfo.workflowId,
        workflowInstanceId: workflowInfo.instanceId,
        phaseId,
        proofType: automation.proof.proof_type || 'work',
        taskId: task.id,
        description: automation.proof.description || summary,
        metadata: {
          tool_run_id: runId,
          command: automation.command,
          attachments: automation.attachments ?? null
        }
      });
    }
  }

  private async handleAutomationFailure(
    task: Task,
    automation: CommandAutomationConfig,
    output: Record<string, any>,
    runId: string,
    workflowInfo: { workflowId: string | null; instanceId: string | null; phaseIds: string[] },
    reason: string
  ) {
    const message = automation.message || `自动执行失败：${automation.command}`;
    this.services.task.failTask(task.id, `${message} (${reason})`);
    const attachmentNote = this.buildAttachmentNote(automation.attachments);
    const lines = [`${message}`, `${reason}`];
    if (attachmentNote) {
      lines.push(attachmentNote);
    }
    this.publishMessage(task.session_id, `⚠️ ${task.title} 失败`, lines.join('\n'), runId, workflowInfo.instanceId, true);
    if (automation.notify_on_fail !== false) {
      this.services.notification.sendNotification({
        session_id: task.session_id || 'global',
        level: 'warning',
        title: '工具执行失败',
        message: `${task.title} 自动执行失败：${reason}`,
        metadata: {
          task_id: task.id,
          workflow_instance_id: workflowInfo.instanceId,
          tool_run_id: runId
        }
      });
    }
  }

  private publishMessage(
    sessionId: string | null,
    title: string,
    content: string,
    runId: string,
    workflowInstanceId: string | null,
    warning = false
  ) {
    if (!sessionId) {
      return;
    }
    this.services.message.sendMessage({
      id: `msg_tool_${runId}`,
      session_id: sessionId,
      agent_id: 'workflow_orchestrator',
      message_type: 'system',
      content: `${title}\n${content}`,
      priority: warning ? 'high' : 'medium',
      tags: ['tool_run'],
      reply_to: null,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      payload: workflowInstanceId ? { workflow_instance_id: workflowInstanceId, tool_run_id: runId } : { tool_run_id: runId }
    });
  }

  private buildAttachmentNote(attachments?: { files?: string[]; links?: string[]; notes?: string[] } | null): string | null {
    if (!attachments) {
      return null;
    }
    const parts: string[] = [];
    if (attachments.files?.length) {
      parts.push(`文件：${attachments.files.slice(0, 4).join(', ')}`);
    }
    if (attachments.links?.length) {
      parts.push(`链接：${attachments.links.slice(0, 4).join(', ')}`);
    }
    if (attachments.notes?.length) {
      parts.push(...attachments.notes.slice(0, 3));
    }
    return parts.length ? parts.join('\n') : null;
  }

  private extractWorkflowInfo(labels?: string[] | null): { workflowId: string | null; instanceId: string | null; phaseIds: string[] } {
    const info = {
      workflowId: null as string | null,
      instanceId: null as string | null,
      phaseIds: [] as string[]
    };
    if (!Array.isArray(labels)) {
      return info;
    }
    labels.forEach(label => {
      if (label.startsWith('workflow_instance:')) {
        info.instanceId = label.replace('workflow_instance:', '');
      } else if (label.startsWith('workflow_phase:')) {
        info.phaseIds.push(label.replace('workflow_phase:', ''));
      } else if (label.startsWith('workflow:')) {
        info.workflowId = label.replace('workflow:', '');
      }
    });
    return info;
  }

  private runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; exitCode: number; duration: number }> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const child = spawn(command, {
        cwd,
        env,
        shell: true
      });
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', chunk => {
        stdout = this.appendWithLimit(stdout, chunk.toString());
      });
      child.stderr?.on('data', chunk => {
        const text = chunk.toString();
        stderr = this.appendWithLimit(stderr, text);
        this.output.appendLine(`[ToolExecution] ${text}`);
      });
      child.on('error', reject);
      child.on('close', code => {
        resolve({
          stdout,
          stderr,
          exitCode: typeof code === 'number' ? code : -1,
          duration: Date.now() - start
        });
      });
    });
  }

  private appendWithLimit(buffer: string, chunk: string): string {
    const next = buffer + chunk;
    if (next.length <= DEFAULT_OUTPUT_LIMIT) {
      return next;
    }
    return next.slice(next.length - DEFAULT_OUTPUT_LIMIT);
  }

  getRuns(sessionId?: string | null, limit = 200): ToolRun[] {
    return this.db.getToolRuns(sessionId ? { session_id: sessionId, limit } : { limit });
  }

  private updateTaskAutomationMetadata(task: Task, patch: Record<string, any>) {
    const currentMeta = task.metadata ? JSON.parse(JSON.stringify(task.metadata)) : {};
    const automationMeta = currentMeta.automation ? { ...currentMeta.automation } : {};
    Object.assign(automationMeta, patch);
    currentMeta.automation = automationMeta;
    this.services.task.updateTask(task.id, { metadata: currentMeta });
  }

  private broadcastRuns(sessionId?: string) {
    if (this.disposed) {
      return;
    }
    const runs = this.db.getToolRuns(sessionId ? { session_id: sessionId } : { limit: 200 });
    this.events.emit('tool_runs_update', runs);
  }
}
