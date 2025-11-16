import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DatabaseManager } from './database';
import { GlobalConfigDatabase } from './database/global-config.database';
import { TypedEventEmitter } from './events/emitter';
import {
  AgentService,
  TaskService,
  MessageService,
  TaskContextService,
  VoteService,
  ApprovalService,
  PolicyService,
  NotificationService,
  SessionService,
  ThinkingService,
  FileChangeService,
  ContextService,
  MCPServerService,
  MCPService,
  LockService,
  GovernanceHistoryService,
  ProofService,
  ToolExecutionService,
  type Services
} from './services';
import { PolicyEnforcer } from './services/policy-enforcer.service';
import { AgentEngine } from './agent/engine';
import { MinimalPanelProvider } from './webview/minimal-panel';
import { TaskMonitor } from './orchestration/task-monitor';
import { LockMonitor } from './monitoring/lock-monitor';
import { MCPMonitor } from './orchestration/mcp-monitor';
import type { ExtensionConfig, Agent, MCPServer } from './types';
import { GovernanceMonitor } from './governance/governance-monitor';
import { PerformanceRecorder } from './monitoring/performance-recorder';
import { buildConfigFromAgent } from './helpers/agent-config';
import { AgentRuntimePool } from './orchestration/agent-runtime-pool';
import { AgentScheduler } from './orchestration/agent-scheduler';
import { SentinelService } from './orchestration/sentinel.service';
import { WorkflowOrchestrator } from './workflow/workflow-orchestrator';
import { WorkflowKernel } from './workflow/workflow-kernel';
import { WorkflowPluginManager } from './workflow/workflow-plugin-manager';
import { WorkflowTimelineService } from './workflow/workflow-timeline.service';
import { WorkflowInterventionService } from './workflow/workflow-intervention.service';
import {
  AutoTaskWorkflowPlugin,
  ClarifierWorkflowPlugin,
  PlannerWorkflowPlugin,
  BuilderWorkflowPlugin,
  MessagePolicyWorkflowPlugin,
  ProofWorkflowPlugin
} from './workflow/plugins';
import { WorkflowTemplateService } from './workflow/workflow-template.service';
import { WorkspaceConfigManager } from './config/workspace-config';
import { IntegrationBridge } from './integration/integration-bridge';

let db: DatabaseManager;
let globalConfigDb: GlobalConfigDatabase;
let events: TypedEventEmitter;
let services: Services;
let agentEngine: AgentEngine | undefined;
let currentSessionId: string | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let voteTimeoutChecker: NodeJS.Timeout | undefined;
let approvalTimeoutChecker: NodeJS.Timeout | undefined;
let activeAgentId: string | null = null;
let governanceMonitor: GovernanceMonitor | undefined;
let taskMonitor: TaskMonitor | undefined;
let mcpMonitor: MCPMonitor | undefined;
let performanceRecorder: PerformanceRecorder | undefined;
let lockMonitor: LockMonitor | undefined;
let agentRuntimePool: AgentRuntimePool | undefined;
let agentScheduler: AgentScheduler | undefined;
let sentinelService: SentinelService | undefined;
let workflowKernel: WorkflowKernel | undefined;
let workflowOrchestrator: WorkflowOrchestrator | undefined;
let workflowPluginManager: WorkflowPluginManager | undefined;
let workflowTemplateService: WorkflowTemplateService | undefined;
let workspaceConfigManager: WorkspaceConfigManager | undefined;
let integrationBridge: IntegrationBridge | undefined;
let workflowTimelineService: WorkflowTimelineService | undefined;
let workflowInterventionService: WorkflowInterventionService | undefined;
let agentHealthCheckPromise: Promise<void> | null = null;
type MCPServerInput = Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>;

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
  if (workspace) {
    // 工作空间目录优先
    const dbDir = path.join(workspace, '.arranger');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    return path.join(dbDir, 'arranger.db');
  }
  // 备用：用户主目录
  const dbDir = path.join(os.homedir(), '.arranger');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'arranger.db');
}

function getGlobalConfigPath(context: vscode.ExtensionContext): string {
  const storageDir = context.globalStorageUri?.fsPath ?? path.join(os.homedir(), '.arranger-global');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  return path.join(storageDir, 'arranger-global.db');
}

function openOrchestratorPanel() {
  vscode.commands.executeCommand('arranger.arrangerView.focus');
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
      detail: agent.roles && agent.roles.length > 0 ? `角色: ${agent.roles.join(', ')}` : undefined,
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

    const globalConfigPath = getGlobalConfigPath(context);
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

    // 初始化 Workflow Kernel
    workflowKernel = new WorkflowKernel(events, {
      logger: {
        info: (msg: string) => outputChannel.appendLine(`[Workflow] ${msg}`),
        warn: (msg: string) => outputChannel.appendLine(`[Workflow][warn] ${msg}`),
        error: (msg: string) => outputChannel.appendLine(`[Workflow][error] ${msg}`)
      }
    });
    context.subscriptions.push({
      dispose: () => workflowKernel?.dispose()
    });

    workflowTemplateService = new WorkflowTemplateService(
      context,
      workflowKernel,
      events,
      outputChannel,
      workspaceConfigManager
    );
    workflowTemplateService.initialize();
    const activeWorkflowId = workflowTemplateService.getActiveTemplateId();

    // 初始化所有服务
    const agentService = new AgentService(globalConfigDb, db, events);
    const lockService = new LockService(db);
    const notificationService = new NotificationService(db, events);
    const governanceHistoryService = new GovernanceHistoryService(db, events);
    const proofService = new ProofService(db, events, governanceHistoryService);
    const taskService = new TaskService(db, events, notificationService, governanceHistoryService, lockService);
    const messageService = new MessageService(db, events);
    const taskContextService = new TaskContextService(messageService);
    const mcpServerService = new MCPServerService(globalConfigDb, events);
    const mcpService = new MCPService(mcpServerService, events, outputChannel);
    services = {
      agent: agentService,
      task: taskService,
      message: messageService,
      vote: new VoteService(db, events, taskService, governanceHistoryService),
      approval: new ApprovalService(db, events, taskService, governanceHistoryService),
      policy: new PolicyService(globalConfigDb, events),
      notification: notificationService,
      session: new SessionService(db, events),
      thinking: new ThinkingService(db, events),
      fileChange: new FileChangeService(db, events),
      context: new ContextService(outputChannel, mcpService),
      mcpServer: mcpServerService,
      mcp: mcpService,
      lock: lockService,
      governanceHistory: governanceHistoryService,
      taskContext: taskContextService,
      proof: proofService,
      toolExecution: {} as ToolExecutionService
    };
    const toolExecutionService = new ToolExecutionService(db, events, services, workspaceRoot, outputChannel, workflowKernel);
    services.toolExecution = toolExecutionService;
    services.mcp.setToolRunRecorder(toolExecutionService);
    toolExecutionService.start(context);
    context.subscriptions.push(toolExecutionService);
    const policyEnforcer = new PolicyEnforcer(services.policy, services.approval, services.vote, notificationService);
    policyEnforcer.ensureBuiltInPolicies();
    taskService.setPolicyEnforcer(policyEnforcer);
    outputChannel.appendLine('All services initialized');

    const existingSessions = services.session.getAllSessions();
    if (existingSessions.length === 0) {
      const autoSessionId = `session-${Date.now()}`;
      const autoSession = services.session.createSession(autoSessionId, { auto_created: true });
      currentSessionId = autoSession.id;
      outputChannel.appendLine(`[Session] Auto-created default session ${autoSessionId}`);
    }

    if (workflowKernel) {
      workflowTimelineService = new WorkflowTimelineService(events, workflowKernel, services.message, outputChannel);
      workflowTimelineService.start(context);
      context.subscriptions.push({
        dispose: () => workflowTimelineService?.dispose()
      });
      workflowInterventionService = new WorkflowInterventionService(events, workflowKernel, services.task, services.message, outputChannel);
      workflowInterventionService.start(context);
      context.subscriptions.push({
        dispose: () => workflowInterventionService?.dispose()
      });
    }

async function performAgentHealthCheck(services: Services, runtimePool: AgentRuntimePool) {
  if (agentHealthCheckPromise) {
    return agentHealthCheckPromise;
  }
  agentHealthCheckPromise = (async () => {
    const agents = services.agent.getAllAgents();
    const enabledAgents = agents.filter(agent => agent.is_enabled !== false);
    for (const agent of enabledAgents) {
      try {
        if (agent.status === 'online') {
          continue;
        }
        const engine = await runtimePool.ensureEngine(agent.id);
        await engine.stop();
        services.agent.updateAgentStatus(agent.id, {
          status: 'online',
          status_detail: 'Health-check passed',
          active_task_id: null
        });
        outputChannel.appendLine(`[AgentHealthCheck] Agent ${agent.display_name || agent.id} is online`);
      } catch (error: any) {
        services.agent.markAgentOffline(agent.id, error?.message ?? 'Health-check failed');
        outputChannel.appendLine(`[AgentHealthCheck] Agent ${agent.display_name || agent.id} failed health check: ${error?.message ?? error}`);
      }
    }
    agentHealthCheckPromise = null;
  })();
  return agentHealthCheckPromise;
}

    const minimalPanelProvider = new MinimalPanelProvider(services, events, workflowKernel, workflowTemplateService);
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
      vscode.window.showWarningMessage('Arranger 需要至少一个 Agent，请在 Agent 管理中添加后再启动。');
      outputChannel.appendLine('No agents configured. Waiting for user to add agents via UI.');
    }

    const startWorkflowPlugins = async (workflowId: string) => {
      if (!workflowKernel) {
        return;
      }
      if (workflowPluginManager) {
        workflowPluginManager.dispose();
      }
      workflowPluginManager = new WorkflowPluginManager(
        workflowKernel,
        services,
        events,
        outputChannel,
        workflowId
      );
      workflowPluginManager.register(new AutoTaskWorkflowPlugin());
      workflowPluginManager.register(new ClarifierWorkflowPlugin());
      workflowPluginManager.register(new PlannerWorkflowPlugin());
      workflowPluginManager.register(new BuilderWorkflowPlugin());
      workflowPluginManager.register(new MessagePolicyWorkflowPlugin());
      workflowPluginManager.register(new ProofWorkflowPlugin());
      await workflowPluginManager.start(context);
      if (integrationBridge && workflowTemplateService) {
        integrationBridge.setTemplateTargets(workflowTemplateService.getActiveIntegrationTargets());
      }
    };

    if (workflowKernel) {
      workflowOrchestrator = new WorkflowOrchestrator(
        workflowKernel,
        services,
        events,
        outputChannel,
        activeWorkflowId
      );
      workflowOrchestrator.start(context);
      await startWorkflowPlugins(activeWorkflowId);
    }

    taskMonitor = new TaskMonitor(taskService, events, outputChannel);
    taskMonitor.start();
    context.subscriptions.push({
      dispose: () => taskMonitor?.dispose()
    });
    outputChannel.appendLine('Task monitor initialized');

    performanceRecorder = new PerformanceRecorder(events, outputChannel, workspaceRoot);
    context.subscriptions.push({
      dispose: () => performanceRecorder?.dispose()
    });
    outputChannel.appendLine('Performance recorder initialized');

    lockMonitor = new LockMonitor(lockService, outputChannel);
    lockMonitor.start();
    context.subscriptions.push({
      dispose: () => lockMonitor?.dispose()
    });
    outputChannel.appendLine('Lock monitor initialized');

    governanceMonitor = new GovernanceMonitor(
      {
        vote: services.vote,
        approval: services.approval,
        notification: services.notification,
        task: services.task
      },
      outputChannel
    );
    governanceMonitor.start();
    context.subscriptions.push({
      dispose: () => governanceMonitor?.dispose()
    });
    outputChannel.appendLine('Governance monitor initialized');

    mcpMonitor = new MCPMonitor(mcpServerService, mcpService, events, outputChannel);
    mcpMonitor.start();
    context.subscriptions.push({
      dispose: () => mcpMonitor?.dispose()
    });
    outputChannel.appendLine('MCP monitor initialized');

    agentRuntimePool = new AgentRuntimePool(context, services, events, outputChannel);
    agentRuntimePool.start();
    context.subscriptions.push(agentRuntimePool);
    outputChannel.appendLine('Agent runtime pool initialized');

    await performAgentHealthCheck(services, agentRuntimePool);

    agentScheduler = new AgentScheduler(services, events, agentRuntimePool, outputChannel);
    agentScheduler.start(context);
    context.subscriptions.push(agentScheduler);
    outputChannel.appendLine('Agent scheduler started');

    sentinelService = new SentinelService(services, events, workflowKernel, outputChannel);
    sentinelService.start(context);
    context.subscriptions.push(sentinelService);
    outputChannel.appendLine('Sentinel service initialized');

    integrationBridge = new IntegrationBridge(workspaceRoot, events, outputChannel);
    integrationBridge.start(context);
    integrationBridge.setTemplateTargets(workflowTemplateService?.getActiveIntegrationTargets() ?? []);
    outputChannel.appendLine('Integration bridge initialized');

    context.subscriptions.push(vscode.commands.registerCommand('arranger.workflow.switchTemplate', async () => {
      if (!workflowTemplateService) {
        vscode.window.showWarningMessage('Workflow 模板服务尚未准备就绪');
        return;
      }
      const templates = workflowTemplateService.listTemplates();
      const pick = await vscode.window.showQuickPick(
        templates.map(template => ({
          label: template.name,
          description: template.description,
          detail: template.tags?.join(', ') || undefined,
          templateId: template.id
        })),
        { placeHolder: '选择 Workflow 模板' }
      );
      if (!pick) {
        return;
      }
      try {
        workflowTemplateService.applyTemplate(pick.templateId);
        workflowOrchestrator?.setDefaultWorkflowId(pick.templateId);
        await startWorkflowPlugins(pick.templateId);
        vscode.window.showInformationMessage(`Workflow 模板已切换为 ${pick.label}`);
      } catch (error: any) {
        vscode.window.showErrorMessage(error?.message ?? '切换模板失败');
      }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('arranger.integration.openConfig', () => {
      integrationBridge?.openConfig();
    }));

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

        if (agentRuntimePool?.isEngineActive(agentRecord.id)) {
          vscode.window.showInformationMessage(`Agent ${agentRecord.display_name || agentRecord.id} 已由自动调度运行，无需手动启动。`);
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
        const pendingVotes = services.vote.getAllTopics({ status: 'pending' });
        const pendingApprovals = services.approval.getAllApprovals({ decision: 'pending' });
        const unreadNotifications = services.notification.getAllNotifications({ read: false });
        outputChannel.appendLine('--- Arranger Performance Snapshot ---');
        outputChannel.appendLine(`Tasks: total=${metrics.total}, running=${metrics.running}, queued=${metrics.queued}, blocked=${metrics.blocked}, failed=${metrics.failed}`);
        if (metrics.sweep_duration_ms !== undefined) {
          outputChannel.appendLine(`Last maintenance sweep: ${metrics.sweep_duration_ms} ms`);
        }
        if (metrics.last_timeout) {
          outputChannel.appendLine(`Last timeout: ${metrics.last_timeout.message}`);
        }
        outputChannel.appendLine(`Pending votes: ${pendingVotes.length}, pending approvals: ${pendingApprovals.length}`);
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

    // 启动投票超时检查定时器（每分钟检查一次）
    voteTimeoutChecker = setInterval(() => {
      try {
        services.vote.checkTimeouts();
      } catch (error: any) {
        outputChannel.appendLine(`Vote timeout check error: ${error.message}`);
      }
    }, 60000); // 60秒 = 1分钟
    context.subscriptions.push({
      dispose: () => {
        if (voteTimeoutChecker) {
          clearInterval(voteTimeoutChecker);
          voteTimeoutChecker = undefined;
        }
      }
    });
    outputChannel.appendLine('Vote timeout checker started (interval: 60s)');

    approvalTimeoutChecker = setInterval(() => {
      try {
        services.approval.checkTimeouts();
      } catch (error: any) {
        outputChannel.appendLine(`Approval timeout check error: ${error.message}`);
      }
    }, 60000);
    context.subscriptions.push({
      dispose: () => {
        if (approvalTimeoutChecker) {
          clearInterval(approvalTimeoutChecker);
          approvalTimeoutChecker = undefined;
        }
      }
    });
    outputChannel.appendLine('Approval timeout checker started (interval: 60s)');

    outputChannel.appendLine('=== Arranger Extension Activated Successfully ===');
  } catch (error: any) {
    outputChannel.appendLine(`=== ACTIVATION ERROR: ${error.message} ===`);
    outputChannel.appendLine(error.stack || '');
    vscode.window.showErrorMessage(`Arranger activation failed: ${error.message}`);
    throw error;
  }
}

export function deactivate() {
  // 清理定时器
  if (voteTimeoutChecker) {
    clearInterval(voteTimeoutChecker);
    voteTimeoutChecker = undefined;
  }
  if (approvalTimeoutChecker) {
    clearInterval(approvalTimeoutChecker);
    approvalTimeoutChecker = undefined;
  }
  governanceMonitor?.dispose();
  services?.mcp?.dispose();

  if (events) {
    events.removeAllListeners();
  }
  outputChannel?.appendLine('=== Arranger Extension Deactivated ===');
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
