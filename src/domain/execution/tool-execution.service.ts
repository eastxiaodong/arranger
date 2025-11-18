import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import type { TypedEventEmitter } from '../../core/events/emitter';
import type { Services } from '../../application/services';
import type {
  Task,
  ToolRun,
  KeywordAction,
  SensitiveOperationLog,
  SensitiveKeyword
} from '../../core/types';

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
  private readonly state: Services['state'];

  constructor(
    private readonly events: TypedEventEmitter,
    private readonly services: Services,
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel
  ) {
    this.state = services.state;
  }

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
    const record = this.state.createToolRun({
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
    return record;
  }

  recordExternalRunResult(runId: string, result: {
    status: 'succeeded' | 'failed';
    output?: Record<string, any> | null;
    exit_code?: number | null;
    error?: string | null;
  }): ToolRun | null {
    const updated = this.state.updateToolRun(runId, {
      status: result.status,
      output: result.output ?? null,
      exit_code: result.exit_code ?? null,
      error: result.error ?? null,
      completed_at: Date.now()
    });
    return updated;
  }

  async rerunAutomationFromRun(runId: string): Promise<void> {
    const run = this.state.getToolRun(runId);
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
        const existing = this.state.getToolRuns({ task_id: task.id, statuses: ['running', 'succeeded'] });
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
    const runId = `toolrun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const runRecord = this.state.createToolRun({
      id: runId,
      session_id: task.session_id,
      task_id: task.id,
      workflow_instance_id: null,
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
      this.state.updateToolRun(runRecord.id, {
        status,
        output: outputPayload,
        exit_code: exitCode,
        completed_at: Date.now()
      });

      if (exitCode === 0) {
        this.updateTaskAutomationMetadata(task, { last_run_status: 'succeeded', last_run_id: runRecord.id, last_run_at: Date.now() });
        await this.handleAutomationSuccess(task, automation, outputPayload, runRecord.id);
      } else {
        this.updateTaskAutomationMetadata(task, { last_run_status: 'failed', last_run_id: runRecord.id, last_run_at: Date.now() });
        await this.handleAutomationFailure(task, automation, outputPayload, runRecord.id, `命令退出码 ${exitCode}`);
      }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.state.updateToolRun(runRecord.id, {
        status: 'failed',
        error: message,
        completed_at: Date.now()
      });
      this.updateTaskAutomationMetadata(task, { last_run_status: 'failed', last_run_id: runRecord.id, last_run_at: Date.now() });
      await this.handleAutomationFailure(task, automation, { error: message }, runRecord.id, message);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  private async handleAutomationSuccess(
    task: Task,
    automation: CommandAutomationConfig,
    output: Record<string, any>,
    runId: string
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
    this.publishMessage(task.session_id, `✅ ${task.title} 完成`, messageBody, runId);
    // Proof recording removed - should be handled by state layer
  }

  private async handleAutomationFailure(
    task: Task,
    automation: CommandAutomationConfig,
    output: Record<string, any>,
    runId: string,
    reason: string
  ) {
    const message = automation.message || `自动执行失败：${automation.command}`;
    this.services.task.failTask(task.id, `${message} (${reason})`);
    const attachmentNote = this.buildAttachmentNote(automation.attachments);
    const lines = [`${message}`, `${reason}`];
    if (attachmentNote) {
      lines.push(attachmentNote);
    }
    this.publishMessage(task.session_id, `⚠️ ${task.title} 失败`, lines.join('\n'), runId, true);
    if (automation.notify_on_fail !== false) {
      this.services.notification.sendNotification({
        session_id: task.session_id || 'global',
        level: 'warning',
        title: '工具执行失败',
        message: `${task.title} 自动执行失败：${reason}`,
        metadata: {
          task_id: task.id,
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
    warning = false
  ) {
    if (!sessionId) {
      return;
    }
    this.services.message.sendMessage({
      id: `msg_tool_${runId}`,
      session_id: sessionId,
      agent_id: 'workflow_orchestrator',
      content: `${title}\n${content}`,
      priority: warning ? 'high' : 'medium',
      tags: ['tool_run'],
      reply_to: null,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      payload: { tool_run_id: runId }
    });
    if (this.services.notification) {
      this.services.notification.sendNotification({
        session_id: sessionId,
        level: warning ? 'warning' : 'info',
        title,
        message: content,
        metadata: {
          tool_run_id: runId
        }
      });
    }
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

  // REMOVED: extractWorkflowInfo - workflow functionality removed

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

  /**
   * 供外部主动触发一次命令执行（带工具运行记录）
   */
  async executeExternalCommand(run: {
    id?: string;
    session_id?: string | null;
    task_id?: string | null;
    tool_name: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    runner?: 'automation' | 'mcp' | 'manual' | 'system' | 'ace';
    source?: string | null;
    created_by?: string | null;
    confirmed?: boolean;
  }): Promise<ToolRun> {
    this.enforceSensitiveGuard(run);
    const runId = run.id ?? `toolrun_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const cwd = run.cwd
      ? path.isAbsolute(run.cwd) ? run.cwd : path.join(this.workspaceRoot, run.cwd)
      : this.workspaceRoot;
    const env = {
      ...process.env,
      ...(run.env || {})
    };

    const record = this.state.createToolRun({
      id: runId,
      session_id: run.session_id ?? null,
      task_id: run.task_id ?? null,
      workflow_instance_id: null,
      tool_name: run.tool_name,
      runner: run.runner ?? 'system',
      source: run.source ?? 'external',
      command: run.command,
      input: { cwd, env },
      output: null,
      status: 'running',
      exit_code: null,
      error: null,
      started_at: Date.now(),
      created_by: run.created_by ?? null,
      metadata: null,
      completed_at: null
    });

    try {
      const { stdout, stderr, exitCode, duration } = await this.runCommand(run.command, cwd, env);
      const outputPayload: Record<string, any> = {
        stdout,
        stderr,
        duration_ms: duration,
        cwd
      };
      const status = exitCode === 0 ? 'succeeded' : 'failed';
      return this.state.updateToolRun(record.id, {
        status,
        output: outputPayload,
        exit_code: exitCode,
        completed_at: Date.now()
      })!;
    } catch (error: any) {
      const message = error?.message ?? String(error);
      return this.state.updateToolRun(record.id, {
        status: 'failed',
        error: message,
        completed_at: Date.now()
      })!;
    }
  }

  async executeMcpTool(params: {
    server_id: number;
    tool: string;
    args?: Record<string, any>;
    session_id?: string | null;
    task_id?: string | null;
    created_by?: string | null;
  }): Promise<any> {
    const { server_id, tool, args = {}, session_id = null, task_id = null, created_by = 'system' } = params;
    const result = await this.services.mcp.callToolById(server_id, tool, args, {
      session_id,
      task_id,
      created_by
    });
    this.services.message?.sendMessage({
      id: `mcp_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      session_id: session_id || '',
      agent_id: created_by || 'system',
      content: `已触发 MCP 工具 ${tool}（server ${server_id}）`,
      priority: 'medium',
      tags: ['mcp', 'tool'],
      reply_to: null,
      references: task_id ? [task_id] : null,
      reference_type: task_id ? 'task' : null,
      reference_id: task_id,
      mentions: null,
      expires_at: null,
      category: 'system_event',
      visibility: 'blackboard',
      payload: {
        server_id,
        tool,
        result_preview: typeof result === 'string' ? result.slice(0, 200) : undefined
      }
    });
    return result;
  }

  /**
   * 将命令放入队列（pending），可指定延迟后执行。
   */
  scheduleExternalCommand(run: {
    id?: string;
    session_id?: string | null;
    task_id?: string | null;
    tool_name: string;
    command: string;
    delay_ms?: number;
    cwd?: string;
    env?: Record<string, string>;
    runner?: 'automation' | 'mcp' | 'manual' | 'system' | 'ace';
    source?: string | null;
    created_by?: string | null;
    confirmed?: boolean;
  }): ToolRun {
    const runId = run.id ?? `toolrun_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record = this.state.createToolRun({
      id: runId,
      session_id: run.session_id ?? null,
      task_id: run.task_id ?? null,
      workflow_instance_id: null,
      tool_name: run.tool_name,
      runner: run.runner ?? 'automation',
      source: run.source ?? 'automation',
      command: run.command,
      input: { delay_ms: run.delay_ms ?? 0, cwd: run.cwd, env: run.env },
      output: null,
      status: 'pending',
      exit_code: null,
      error: null,
      started_at: Date.now(),
      created_by: run.created_by ?? null,
      metadata: null,
      completed_at: null
    });

    const delay = Math.max(0, run.delay_ms ?? 0);
    setTimeout(() => {
      void this.executeExternalCommand({
        ...run,
        id: record.id,
        runner: run.runner ?? 'automation',
        source: run.source ?? 'automation'
      }).catch(() => {
        // 错误会在 executeExternalCommand 内部记录，不再重复抛出
      });
    }, delay);

    return record;
  }

  getRuns(sessionId?: string | null, limit = 200): ToolRun[] {
    return this.state.getToolRuns(sessionId ? { session_id: sessionId, limit } : { limit });
  }

  private enforceSensitiveGuard(run: {
    command?: string;
    tool_name: string;
    session_id?: string | null;
    task_id?: string | null;
    runner?: string | null;
    source?: string | null;
    created_by?: string | null;
    confirmed?: boolean;
  }) {
    const command = (run.command || '').toLowerCase();
    if (!command) {
      return;
    }
    const keywords = this.state.querySensitiveKeywords({ enabled: true });
    if (!keywords.length) {
      return;
    }
    const matches: SensitiveKeyword[] = [];
    keywords.forEach(keyword => {
      if (keyword.enabled && keyword.keyword && command.includes(keyword.keyword.toLowerCase())) {
        matches.push(keyword);
      }
    });
    if (!matches.length) {
      return;
    }
    const actionRank: Record<KeywordAction, number> = { block: 3, confirm: 2, log: 1 };
    const riskRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const dominant = matches.reduce(
      (acc, cur) => {
        const actionScore = actionRank[cur.action];
        const riskScore = riskRank[cur.riskLevel] || 1;
        if (actionScore > acc.actionScore || (actionScore === acc.actionScore && riskScore > acc.riskScore)) {
          return { action: cur.action, risk: cur.riskLevel, actionScore, riskScore };
        }
        return acc;
      },
      { action: matches[0].action, risk: matches[0].riskLevel, actionScore: actionRank[matches[0].action], riskScore: riskRank[matches[0].riskLevel] || 1 }
    );

    const log: SensitiveOperationLog = {
      id: `sens_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      taskId: run.task_id ?? '',
      sessionId: run.session_id ?? '',
      agentId: run.created_by || run.runner || 'system',
      operation: run.command || '',
      matchedKeywords: matches.map(m => m.keyword),
      riskLevel: dominant.risk,
      action: dominant.action,
      userConfirmed: run.confirmed ?? false,
      blocked: dominant.action === 'block' || (dominant.action === 'confirm' && !run.confirmed),
      context: {
        tool_name: run.tool_name,
        source: run.source,
        runner: run.runner
      },
      timestamp: Date.now()
    };
    this.state.logSensitiveOperation(log);

    if (log.blocked) {
      // 如果是需要确认的操作（而不是直接阻止），抛出特殊错误
      if (dominant.action === 'confirm' && !run.confirmed) {
        const error: any = new Error('需要用户确认敏感操作');
        error.requiresConfirmation = true;
        error.sensitiveData = {
          command: run.command,
          matchedKeywords: log.matchedKeywords,
          riskLevel: log.riskLevel,
          toolName: run.tool_name,
          source: run.source,
          runner: run.runner,
          sessionId: run.session_id,
          taskId: run.task_id
        };
        throw error;
      }
      
      // 如果是直接阻止的操作
      throw new Error(`命令包含敏感关键字：${log.matchedKeywords.join(', ')}，已被阻止执行。`);
    }
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
    this.state.emitToolRunsUpdate(sessionId);
  }
}
