import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DatabaseManager } from './core/database';
import { GlobalConfigDatabase } from './core/database/global-config.database';
import { TypedEventEmitter } from './core/events/emitter';
import {
  createServices,
  type Services
} from './application/services';
import { AgentEngine } from './domain/agent/agent.engine';
import { MinimalPanelProvider } from './presentation/webview/minimal-panel';
import type { ExtensionConfig, Agent, MCPServer, ToolRun } from './core/types';
import { PerformanceRecorder } from './application/monitoring/performance-recorder';
import { buildConfigFromAgent } from './presentation/commands/agent-config';
import { WorkspaceConfigManager } from './infrastructure/config/workspace-config';
import { IntegrationBridge } from './infrastructure/integration/integration-bridge';

let db: DatabaseManager;
let globalConfigDb: GlobalConfigDatabase;
let events: TypedEventEmitter;
let services: Services;
let agentEngine: AgentEngine | undefined;
let currentSessionId: string | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let activeAgentId: string | null = null;
let performanceRecorder: PerformanceRecorder | undefined;
let workspaceConfigManager: WorkspaceConfigManager | undefined;
let integrationBridge: IntegrationBridge | undefined;
let agentHealthCheckPromise: Promise<void> | null = null;
const ACE_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 小时
const ACE_STALE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟检查一次
const ACE_FAILURE_WINDOW_MS = 45 * 60 * 1000; // 45 分钟内连续失败告警
const ACE_FAILURE_ALERT_COUNT = 2;
type AceAutoRefreshReason = 'startup' | 'workspace-change' | 'scheduled';
let aceAutoRefreshTimer: NodeJS.Timeout | null = null;
let aceRefreshInProgress = false;
let lastAceFailureAlertRunId: string | null = null;
type MCPServerInput = Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>;
let assistDeadlineTimer: NodeJS.Timeout | null = null;

class ArrangerWebviewViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly minimalPanelProvider: MinimalPanelProvider
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    webview.html = this.minimalPanelProvider.getHtmlForWebview(webview);

    webview.onDidReceiveMessage(async (message) => {
      outputChannel.appendLine(`[Panel] Received message: ${message.type}`);
      await this.minimalPanelProvider.handleMessage(message, webview);
    });

    webviewView.onDidDispose(() => {
      // 当前实现不需要额外清理；保留钩子以便未来扩展
    });
  }
}

// 获取数据库路径
function getDatabasePath(): string {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const globalDir = path.join(os.homedir(), '.arranger');
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }
  const globalDbPath = path.join(globalDir, 'arranger.db');

  if (!workspace) {
    return globalDbPath;
  }

  // 优先使用工作区 .arranger；若文件为空则删除后重建，避免误回退到全局导致状态混杂
  const workspaceDir = path.join(workspace, '.arranger');
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  const workspaceDbPath = path.join(workspaceDir, 'arranger.db');
  try {
    if (fs.existsSync(workspaceDbPath)) {
      const stat = fs.statSync(workspaceDbPath);
      if (stat.size === 0) {
        console.warn('[Arranger] 检测到工作区数据库为空文件，重新创建');
        fs.unlinkSync(workspaceDbPath);
      } else {
        return workspaceDbPath;
      }
    }
  } catch (err) {
    console.warn('[Arranger] Failed to stat workspace DB, fallback to global:', err);
    return globalDbPath;
  }
  return workspaceDbPath;
}

function getGlobalConfigPath(): string {
  const storageDir = path.join(os.homedir(), '.arranger');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  return path.join(storageDir, 'system-setting.db');
}

function openOrchestratorPanel() {
  vscode.commands.executeCommand('arranger.arrangerView.focus');
}


function setupAssistDeadlineSweep(context: vscode.ExtensionContext) {
  if (assistDeadlineTimer) {
    clearInterval(assistDeadlineTimer);
  }
  assistDeadlineTimer = setInterval(() => {
    try {
      services.assist.runDeadlineSweep();
    } catch (error: any) {
      outputChannel.appendLine(`[AssistDeadline] Sweep error: ${error?.message ?? error}`);
    }
  }, 60 * 1000);
  context.subscriptions.push({
    dispose: () => {
      if (assistDeadlineTimer) {
        clearInterval(assistDeadlineTimer);
        assistDeadlineTimer = null;
      }
    }
  });
}

async function selectAgent(agents: Agent[]): Promise<Agent | undefined> {
  if (agents.length === 0) {
    vscode.window.showWarningMessage('尚未配置任何 Agent，请先在 Agent 管理中添加。');
    return undefined;
  }

  if (agents.length === 1) {
    return agents[0];
  }

  const pick = await vscode.window.showQuickPick<{ label: string; description?: string; detail?: string; agentId: string; disabled?: boolean }>(
    agents.map(agent => ({
      label: `${agent.display_name || agent.id}${agent.is_enabled === false ? ' (已停用)' : ''}`,
      description: `ID: ${agent.id}`,
      detail: agent.capability_tags && agent.capability_tags.length > 0 ? `能力: ${agent.capability_tags.join(', ')}` : undefined,
      agentId: agent.id,
      disabled: agent.is_enabled === false
    })),
    {
      placeHolder: '选择要启动的 Agent'
    }
  );

  if (!pick) {
    return undefined;
  }

  return agents.find(agent => agent.id === pick.agentId);
}

export async function activate(context: vscode.ExtensionContext) {
  // 创建输出通道
  outputChannel = vscode.window.createOutputChannel('Arranger');
  outputChannel.show();
  outputChannel.appendLine('=== Arranger Extension Activating (v3.0 Unified Architecture) ===');
  console.log('Arranger extension is now active');

  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || context.storageUri?.fsPath
      || os.homedir();
    workspaceConfigManager = new WorkspaceConfigManager(workspaceRoot);

    // 初始化数据库
    const dbPath = getDatabasePath();
    outputChannel.appendLine(`Database path: ${dbPath}`);
    db = await DatabaseManager.create(dbPath);
    outputChannel.appendLine('Database initialized');

    const globalConfigPath = getGlobalConfigPath();
    outputChannel.appendLine(`Global config database path: ${globalConfigPath}`);
    globalConfigDb = await GlobalConfigDatabase.create(globalConfigPath);
    outputChannel.appendLine('Global configuration database initialized');
    context.subscriptions.push({
      dispose: () => {
        globalConfigDb?.close();
      }
    });

    // 初始化事件系统
    events = new TypedEventEmitter();
    outputChannel.appendLine('Event system initialized');
    const serviceInit = createServices({
      db,
      globalConfigDb,
      events,
      workspaceRoot,
      outputChannel
    });
    services = serviceInit.services;
    serviceInit.toolExecution.start(context);
    context.subscriptions.push(serviceInit.toolExecution);
    outputChannel.appendLine('All services initialized');

    const existingSessions = services.session.getAllSessions();
    if (existingSessions.length === 0) {
      const autoSessionId = `session-${Date.now()}`;
      const autoSession = services.session.createSession(autoSessionId, { auto_created: true });
      currentSessionId = autoSession.id;
      outputChannel.appendLine(`[Session] Auto-created default session ${autoSessionId}`);
    }

    void setupAceAutoMonitor(context);
    setupAssistDeadlineSweep(context);

    const minimalPanelProvider = new MinimalPanelProvider(services, events);
    const arrangerViewProvider = new ArrangerWebviewViewProvider(minimalPanelProvider);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('arranger.arrangerView', arrangerViewProvider, {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      })
    );
    outputChannel.appendLine('Arranger view provider registered');

    const existingAgents = services.agent.getAllAgents();
    if (existingAgents.length === 0) {
      // Create a default agent for new installations
      const defaultAgent = services.agent.createAgent({
        id: 'default-agent',
        display_name: 'Default Agent',
        capability_tags: ['general'],
        status: 'offline',
        is_enabled: true,
        capabilities: [],
        tool_permissions: [],
        last_heartbeat_at: Date.now(),
        status_detail: null,
        status_eta: null,
        active_task_id: null,
        status_updated_at: null
      });
      outputChannel.appendLine(`Created default agent: ${defaultAgent.id}`);
    } else {
      outputChannel.appendLine(`Found ${existingAgents.length} configured agents`);
    }

    performanceRecorder = new PerformanceRecorder(events, outputChannel, workspaceRoot);
    context.subscriptions.push({
      dispose: () => performanceRecorder?.dispose()
    });
    outputChannel.appendLine('Performance recorder initialized');

    integrationBridge = new IntegrationBridge(workspaceRoot, events, outputChannel);
    integrationBridge.start(context);
    outputChannel.appendLine('Integration bridge initialized');

    context.subscriptions.push(vscode.commands.registerCommand('arranger.integration.openConfig', () => {
      integrationBridge?.openConfig();
    }));

    context.subscriptions.push(
      vscode.commands.registerCommand('arranger.ace.search', async () => {
        if (!services.aceContext.isConfigured()) {
          const pick = await vscode.window.showInformationMessage(
            'ACE 尚未配置，无法执行搜索。请在 Arranger 面板的“ACE 集成”中设置 Base URL 和 Token。'
          );
          return;
        }
        const query = await vscode.window.showInputBox({
          prompt: '输入需要搜索的上下文关键词',
          placeHolder: '例如：logging configuration or user authentication',
          ignoreFocusOut: true
        });
        if (!query || !query.trim()) {
          return;
        }
        const trimmedQuery = query.trim();
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'ACE 搜索中...'
          },
          async () => {
            const result = await services.aceContext.search(trimmedQuery);
            outputChannel.appendLine(`[ACE] Query: ${trimmedQuery}`);
            outputChannel.appendLine(result);
            vscode.window.showInformationMessage('ACE 搜索完成，结果已写入 Arranger 输出。');
          }
        );
      })
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = 'Arranger';
    statusBarItem.tooltip = '打开 Arranger Orchestrator 面板';
    statusBarItem.command = 'arranger.openPanel';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    outputChannel.appendLine('Status bar item created');

  // 注册命令：打开面板
  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.openPanel', () => {
      openOrchestratorPanel();
    })
  );

  // 注册命令：启动 Agent
  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.startAgent', async () => {
      try {
        const agents = services.agent.getAllAgents();
        const agentRecord = await selectAgent(agents);
        if (!agentRecord) {
          return;
        }

        if (agentRecord.is_enabled === false) {
          vscode.window.showWarningMessage('该 Agent 已停用，请先在全局配置中启用后再启动。');
          return;
        }



        const agentConfig = buildConfigFromAgent(agentRecord);

        if (agentEngine && activeAgentId !== agentRecord.id) {
          await agentEngine.stop();
          agentEngine = undefined;
        }

        if (!agentEngine) {
          agentEngine = new AgentEngine(agentConfig, context, services, events, outputChannel);
          activeAgentId = agentRecord.id;
          outputChannel.appendLine(`Agent Engine initialized for ${agentRecord.display_name || agentRecord.id}`);
        }

        if (!currentSessionId) {
          const sessionId = `session-${Date.now()}`;
          const session = services.session.createSession(sessionId);
          currentSessionId = session.id;
          outputChannel.appendLine(`Session created: ${currentSessionId}`);
        }

        await agentEngine.start(currentSessionId);
        vscode.window.showInformationMessage(`Agent ${agentRecord.display_name || agentRecord.id} started successfully`);
        outputChannel.appendLine('Agent started via command');
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to start agent: ${error.message}`);
        outputChannel.appendLine(`Failed to start agent: ${error.message}`);
      }
    })
  );

  // 注册命令：停止 Agent
  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.stopAgent', async () => {
      try {
        if (!agentEngine) {
          vscode.window.showWarningMessage('No running agent engine to stop.');
          return;
        }

        // 停止 Agent
        await agentEngine.stop();
        agentEngine = undefined;
        activeAgentId = null;
        vscode.window.showInformationMessage('Agent stopped successfully');
        outputChannel.appendLine('Agent stopped via command');
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to stop agent: ${error.message}`);
        outputChannel.appendLine(`Failed to stop agent: ${error.message}`);
      }
    })
  );

  // 导出性能快照
  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.exportPerformanceSnapshot', async () => {
      if (!performanceRecorder || performanceRecorder.isEmpty()) {
        vscode.window.showInformationMessage('暂无性能快照数据，请等待任务监控运行一段时间。');
        return;
      }
      const snapshot = performanceRecorder.getSnapshot();
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(snapshot, null, 2),
        language: 'json'
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );

  // 注册命令：性能诊断
  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.runPerformanceCheck', async () => {
      try {
        const metrics = services.task.getTaskMetrics();
        const unreadNotifications = services.notification.getAllNotifications({ read: false });
        outputChannel.appendLine('--- Arranger Performance Snapshot ---');
        outputChannel.appendLine(`Tasks: total=${metrics.total}, running=${metrics.running}, queued=${metrics.queued}, blocked=${metrics.blocked}, failed=${metrics.failed}`);
        if (metrics.sweep_duration_ms !== undefined) {
          outputChannel.appendLine(`Last maintenance sweep: ${metrics.sweep_duration_ms} ms`);
        }
        if (metrics.last_timeout) {
          outputChannel.appendLine(`Last timeout: ${metrics.last_timeout.message}`);
        }
        outputChannel.appendLine(`Unread notifications: ${unreadNotifications.length}`);
        outputChannel.appendLine('--------------------------------------');
        vscode.window.showInformationMessage('性能快照已写入 Arranger 输出面板');
      } catch (error: any) {
        vscode.window.showErrorMessage(`性能检测失败：${error?.message ?? error}`);
        outputChannel.appendLine(`Performance check failed: ${error?.message ?? error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.testMcpServer', async () => {
      try {
        const servers = services.mcpServer.getAllServers();
        if (servers.length === 0) {
          vscode.window.showWarningMessage('尚未配置任何 MCP Server');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          servers.map(server => ({
            label: server.name + (server.enabled ? '' : ' (已禁用)'),
            description: server.command,
            server
          })),
          { placeHolder: '选择要检测的 MCP Server' }
        );
        if (!pick) {
          return;
        }
        const server = pick.server;
        const result = await services.mcp.pingServer(server);
        events.emit('mcp_server_status', {
          serverId: server.id,
          available: result.available,
          error: result.error ?? null,
          toolCount: Array.isArray(result.tools) ? result.tools.length : null
        });
        if (result.available) {
          vscode.window.showInformationMessage(`MCP Server ${server.name} 可用，工具数 ${Array.isArray(result.tools) ? result.tools.length : 0}`);
        } else {
          vscode.window.showErrorMessage(`MCP Server ${server.name} 不可用：${result.error ?? '未知错误'}`);
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`检测 MCP Server 失败：${error?.message ?? error}`);
      }
    })
  );

  // 注册命令：创建任务
  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.createTask', async () => {
      if (!currentSessionId) {
        vscode.window.showWarningMessage('Please start the agent first');
        return;
      }

      const intent = await vscode.window.showInputBox({
        prompt: 'Enter task intent',
        placeHolder: 'e.g., Implement user authentication'
      });

      if (!intent) {
        return;
      }

      const scope = await vscode.window.showInputBox({
        prompt: 'Enter task scope',
        placeHolder: 'e.g., src/auth/'
      });

      if (!scope) {
        return;
      }

      try {
        const task = services.task.createTask({
          id: `task-${Date.now()}`,
          session_id: currentSessionId,
          title: intent,
          intent,
          description: null,
          scope,
          priority: 'medium',
          labels: null,
          due_at: null,
          status: 'pending',
          assigned_to: null
        });
        vscode.window.showInformationMessage(`Task created: ${task.id}`);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create task: ${error.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('arranger.manageMcpServers', async () => {
      await manageMcpServers(services, outputChannel);
    })
  );

    // 状态栏项已在前面创建

    outputChannel.appendLine('=== Arranger Extension Activated Successfully ===');
  } catch (error: any) {
    outputChannel.appendLine(`=== ACTIVATION ERROR: ${error.message} ===`);
    outputChannel.appendLine(error.stack || '');
    vscode.window.showErrorMessage(`Arranger activation failed: ${error.message}`);
    throw error;
  }
}

export function deactivate() {
  services?.mcp?.dispose();
  services?.managerOrchestrator?.dispose?.();
  services?.state?.dispose?.();
  if (aceAutoRefreshTimer) {
    clearInterval(aceAutoRefreshTimer);
    aceAutoRefreshTimer = null;
  }

  if (events) {
    events.removeAllListeners();
  }
  outputChannel?.appendLine('=== Arranger Extension Deactivated ===');
}

async function setupAceAutoMonitor(context: vscode.ExtensionContext) {
  if (!services?.aceContext) {
    return;
  }
  const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void maybeAutoRefreshAce('workspace-change');
  });
  context.subscriptions.push(workspaceListener);

  if (aceAutoRefreshTimer) {
    clearInterval(aceAutoRefreshTimer);
  }
  aceAutoRefreshTimer = setInterval(() => {
    void maybeAutoRefreshAce('scheduled');
  }, ACE_STALE_CHECK_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => {
      if (aceAutoRefreshTimer) {
        clearInterval(aceAutoRefreshTimer);
        aceAutoRefreshTimer = null;
      }
    }
  });

  await maybeAutoRefreshAce('startup');
}

async function maybeAutoRefreshAce(reason: AceAutoRefreshReason) {
  if (!services?.aceContext?.isConfigured() || !services.toolExecution) {
    return;
  }
  if (aceRefreshInProgress) {
    return;
  }
  const runs = services.toolExecution.getRuns(undefined, 100);
  const now = Date.now();
  const lastIndexSuccess = runs.find(run => isAceRun(run, 'index') && run.status === 'succeeded');
  const lastIndexAt = lastIndexSuccess ? getRunTimestamp(lastIndexSuccess) : 0;
  const isStale = !lastIndexAt || now - lastIndexAt > ACE_STALE_THRESHOLD_MS;
  const shouldRefresh = reason === 'workspace-change' ? services.aceContext.isConfigured() : isStale;

  if (!shouldRefresh) {
    maybeNotifyAceFailures(runs);
    return;
  }

  aceRefreshInProgress = true;
  const notifyForReason = reason !== 'workspace-change';
  try {
    if (notifyForReason && isStale) {
      services.notification.sendNotification({
        session_id: currentSessionId || 'global',
        level: 'warning',
        title: 'ACE 索引已过期',
        message: '超过 6 小时未刷新，正在自动更新索引…',
        metadata: { reason }
      });
    }
    outputChannel.appendLine(`[ACE] Auto-refresh triggered (${reason})`);
    await services.aceContext.refreshIndex();
    if (notifyForReason) {
      services.notification.sendNotification({
        session_id: currentSessionId || 'global',
        level: 'success',
        title: 'ACE 索引已更新',
        message: isStale ? '索引已自动刷新，ACE 可以继续使用。' : '因上下文变化已刷新索引。',
        metadata: { reason }
      });
    }
  } catch (error: any) {
    const message = error?.message ?? 'ACE 自动刷新失败';
    services.notification.sendNotification({
      session_id: currentSessionId || 'global',
      level: 'error',
      title: 'ACE 自动刷新失败',
      message,
      metadata: { reason }
    });
    outputChannel.appendLine(`[ACE] Auto-refresh failed (${reason}): ${message}`);
  } finally {
    aceRefreshInProgress = false;
    const refreshedRuns = services.toolExecution.getRuns(undefined, 100);
    maybeNotifyAceFailures(refreshedRuns);
  }
}

function getRunTimestamp(run: ToolRun): number {
  return run.completed_at ?? run.started_at ?? run.created_at ?? Date.now();
}

function isAceRun(run: ToolRun, type?: 'index' | 'search' | 'test'): boolean {
  if (!run) {
    return false;
  }
  const normalized = run.tool_name?.startsWith('ace:')
    ? run.tool_name.split(':')[1]
    : undefined;
  if (!normalized && run.runner !== 'ace') {
    return false;
  }
  if (!type) {
    return true;
  }
  if (normalized === type) {
    return true;
  }
  if (type === 'search' && run.command?.startsWith('search')) {
    return true;
  }
  if (type === 'index' && run.command === 'index') {
    return true;
  }
  if (type === 'test' && run.command?.includes('test')) {
    return true;
  }
  return false;
}

function maybeNotifyAceFailures(runs: ToolRun[]) {
  if (!services?.notification || !Array.isArray(runs)) {
    return;
  }
  const now = Date.now();
  const recentFailures = runs.filter(run => isAceRun(run) && run.status === 'failed' && now - getRunTimestamp(run) <= ACE_FAILURE_WINDOW_MS);
  if (recentFailures.length < ACE_FAILURE_ALERT_COUNT) {
    return;
  }
  const newest = recentFailures[0];
  if (lastAceFailureAlertRunId === newest.id) {
    return;
  }
  lastAceFailureAlertRunId = newest.id;
  services.notification.sendNotification({
    session_id: currentSessionId || 'global',
    level: 'warning',
    title: 'ACE 多次运行失败',
    message: `最近 ${recentFailures.length} 次 ACE 操作均失败，请检查 Base URL 或 Token。`,
    metadata: {
      run_ids: recentFailures.slice(0, 3).map(run => run.id)
    }
  });
}

async function manageMcpServers(services: Services, output: vscode.OutputChannel) {
  while (true) {
    const servers = services.mcpServer.getAllServers();
    const picks: Array<vscode.QuickPickItem & { action?: string; serverId?: number }> = [
      ...servers.map(server => ({
        label: `${server.enabled ? '$(check)' : '$(circle-slash)'}${server.is_default ? ' $(star-full)' : ''} ${server.name}`,
        description: server.description || server.command,
        detail: `${server.command} ${server.args.join(' ')}`.trim(),
        serverId: server.id
      })),
      { label: '$(add) 新增 MCP Server', action: 'add' },
      { label: '$(refresh) 刷新列表', action: 'refresh' },
      { label: '$(close) 关闭管理器', action: 'exit' }
    ];
    const selection = await vscode.window.showQuickPick(picks, {
      placeHolder: '选择要管理的 MCP Server 或操作',
      ignoreFocusOut: true
    });
    if (!selection || selection.action === 'exit') {
      break;
    }
    if (selection.action === 'refresh') {
      services.mcpServer.refresh();
      continue;
    }
    if (selection.action === 'add') {
      const hasDefault = servers.some(server => server.is_default);
      const config = await promptForMcpServer(undefined, !hasDefault);
      if (config) {
        services.mcpServer.createServer(config);
        output.appendLine(`[MCP] Created server ${config.name}`);
        vscode.window.showInformationMessage(`已创建 MCP Server：${config.name}`);
      }
      continue;
    }
    const server = servers.find(item => item.id === selection.serverId);
    if (!server) {
      continue;
    }
    const actionOptions: Array<vscode.QuickPickItem & { action: string }> = [
      {
        label: server.enabled ? '$(circle-slash) 禁用' : '$(check) 启用',
        action: 'toggle'
      },
      { label: '$(edit) 编辑', action: 'edit' }
    ];
    if (!server.is_default) {
      actionOptions.push({ label: '$(star) 设为默认', action: 'setDefault' });
    }
    actionOptions.push({ label: '$(trash) 删除', action: 'delete' });
    actionOptions.push({ label: '返回', action: 'back' });
    const action = await vscode.window.showQuickPick(actionOptions, {
      placeHolder: `选择对「${server.name}」的操作`,
      ignoreFocusOut: true
    });
    if (!action || action.action === 'back') {
      continue;
    }
    if (action.action === 'toggle') {
      services.mcpServer.setServerEnabled(server.id, !server.enabled);
      vscode.window.showInformationMessage(`${server.name} 已${server.enabled ? '禁用' : '启用'}`);
      continue;
    }
    if (action.action === 'setDefault') {
      services.mcpServer.setDefaultServer(server.id);
      vscode.window.showInformationMessage(`已将 ${server.name} 设为默认 MCP Server`);
      continue;
    }
    if (action.action === 'delete') {
      const confirm = await vscode.window.showWarningMessage(
        `确定要删除 MCP Server「${server.name}」吗？此操作不可恢复。`,
        { modal: true },
        '删除'
      );
      if (confirm === '删除') {
        services.mcpServer.deleteServer(server.id);
        vscode.window.showInformationMessage(`已删除 MCP Server：${server.name}`);
      }
      continue;
    }
    if (action.action === 'edit') {
      const updated = await promptForMcpServer(server, server.is_default);
      if (updated) {
        services.mcpServer.updateServer(server.id, updated);
        vscode.window.showInformationMessage(`已更新 MCP Server：${updated.name}`);
      }
    }
  }
}

async function promptForMcpServer(existing?: MCPServer, initialIsDefault = false): Promise<MCPServerInput | null> {
  const name = await vscode.window.showInputBox({
    prompt: 'Server 名称',
    value: existing?.name,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? '名称不能为空' : undefined)
  });
  if (!name) {
    return null;
  }
  const description = await vscode.window.showInputBox({
    prompt: '描述（可选）',
    value: existing?.description || '',
    ignoreFocusOut: true
  });
  const command = await vscode.window.showInputBox({
    prompt: '启动命令',
    placeHolder: '例如: python',
    value: existing?.command,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? '命令不能为空' : undefined)
  });
  if (!command) {
    return null;
  }

  const argsInput = await vscode.window.showInputBox({
    prompt: '启动参数（JSON 数组）',
    placeHolder: '例如: ["-m", "server.entry"]',
    value: existing ? JSON.stringify(existing.args || []) : '[]',
    ignoreFocusOut: true
  });
  if (argsInput === undefined) {
    return null;
  }
  let args: string[] = [];
  try {
    const parsed = argsInput.trim() ? JSON.parse(argsInput) : [];
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
      throw new Error('参数必须是字符串数组');
    }
    args = parsed;
  } catch (error: any) {
    vscode.window.showErrorMessage(`参数格式错误：${error.message}`);
    return null;
  }

  const envInput = await vscode.window.showInputBox({
    prompt: '环境变量（JSON 对象，可选）',
    placeHolder: '{"KEY":"value"}',
    value: existing?.env ? JSON.stringify(existing.env) : '',
    ignoreFocusOut: true
  });
  let env: Record<string, string> | undefined;
  if (envInput) {
    try {
      const parsed = JSON.parse(envInput);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('必须是对象');
      }
      const sanitized: Record<string, string> = {};
      Object.entries(parsed).forEach(([key, value]) => {
        sanitized[String(key)] = String(value);
      });
      env = sanitized;
    } catch (error: any) {
      vscode.window.showErrorMessage(`环境变量格式错误：${error.message}`);
      return null;
    }
  }

  const enabledPick = await vscode.window.showQuickPick(
    [
      { label: '启用', value: true },
      { label: '禁用', value: false }
    ],
    {
      placeHolder: '是否启用该 Server',
      ignoreFocusOut: true,
      canPickMany: false
    }
  );
  if (!enabledPick) {
    return null;
  }

  const defaultPick = await vscode.window.showQuickPick(
    [
      { label: '设为默认 Server', value: true, picked: initialIsDefault },
      { label: '不设为默认', value: false, picked: !initialIsDefault }
    ],
    {
      placeHolder: '是否设为默认 MCP Server',
      ignoreFocusOut: true,
      canPickMany: false
    }
  );
  if (!defaultPick) {
    return null;
  }

  return {
    name: name.trim(),
    description: description?.trim() || undefined,
    command: command.trim(),
    args,
    env,
    enabled: enabledPick.value ?? true,
    is_default: defaultPick.value ?? initialIsDefault
  };
}
