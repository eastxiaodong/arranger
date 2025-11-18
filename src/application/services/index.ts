// 服务层导出

// Domain 层服务
export { AgentService } from '../../domain/agent/agent.service';
export { TaskService } from '../../domain/task/task.service';
export { AssistService } from '../../domain/assist/assist.service';
export { TaskContextService } from '../../domain/task/task-context.service';
export { MessageService } from '../../domain/communication/message.service';
export { NotificationService } from '../../domain/communication/notification.service';
export { SessionService } from '../../domain/session/session.service';
export { ToolExecutionService } from '../../domain/execution/tool-execution.service';
export { StateStore } from '../../domain/state';

// Application 层服务
export { PolicyService } from './policy.service';
export { ThinkingService } from './thinking.service';
export { FileChangeService } from './file-change.service';
export { ContextService } from './context.service';
export { AceContextService } from './ace-context.service';
export { ManagerLLMService } from './manager-llm.service';
export { ManagerOrchestratorService } from './manager-orchestrator.service';
export { SchedulerService } from './scheduler.service';
export { FailoverService } from './failover.service';

// Infrastructure 层服务
export { MCPServerService, MCPService } from '../../infrastructure/mcp';

import type { OutputChannel } from 'vscode';
import type { DatabaseManager } from '../../core/database';
import type { GlobalConfigDatabase } from '../../core/database/global-config.database';
import type { TypedEventEmitter } from '../../core/events/emitter';
import { AgentService } from '../../domain/agent/agent.service';
import { TaskService } from '../../domain/task/task.service';
import { AssistService } from '../../domain/assist/assist.service';
import { TaskContextService } from '../../domain/task/task-context.service';
import { MessageService } from '../../domain/communication/message.service';
import { NotificationService } from '../../domain/communication/notification.service';
import { SessionService } from '../../domain/session/session.service';
import { ToolExecutionService } from '../../domain/execution/tool-execution.service';
import { StateStore } from '../../domain/state';
import { PolicyService } from './policy.service';
import { ThinkingService } from './thinking.service';
import { FileChangeService } from './file-change.service';
import { ContextService } from './context.service';
import { AceContextService } from './ace-context.service';
import { ManagerLLMService } from './manager-llm.service';
import { ManagerOrchestratorService } from './manager-orchestrator.service';
import { SchedulerService } from './scheduler.service';
import { FailoverService } from './failover.service';
import { AutomationService } from './automation.service';
import { MCPServerService, MCPService } from '../../infrastructure/mcp';

// 服务集合类型
export interface Services {
  agent: AgentService;
  task: TaskService;
  message: MessageService;
  assist: AssistService;
  taskContext: TaskContextService;
  policy: PolicyService;
  notification: NotificationService;
  session: SessionService;
  thinking: ThinkingService;
  fileChange: FileChangeService;
  context: ContextService;
  aceContext: AceContextService;
  automation: AutomationService;
  mcpServer: MCPServerService;
  mcp: MCPService;
  toolExecution: ToolExecutionService;
  state: StateStore;
  managerLLM: ManagerLLMService;
  managerOrchestrator: ManagerOrchestratorService;
  scheduler: SchedulerService;
  failover: FailoverService;
}

export interface ServiceFactoryOptions {
  db: DatabaseManager;
  globalConfigDb: GlobalConfigDatabase;
  events: TypedEventEmitter;
  workspaceRoot: string;
  outputChannel: OutputChannel;
}

export interface ServiceFactoryResult {
  services: Services;
  toolExecution: ToolExecutionService;
}

export function createServices(options: ServiceFactoryOptions): ServiceFactoryResult {
  const { db, globalConfigDb, events, workspaceRoot, outputChannel } = options;

  const stateStore = new StateStore(db, events);
  stateStore.initialize();
  const agentService = new AgentService(globalConfigDb, db, events, stateStore);
  const notificationService = new NotificationService(db, events);
  const messageService = new MessageService(db, events);
  const taskContextService = new TaskContextService(messageService);
  const mcpServerService = new MCPServerService(globalConfigDb, events);
  const mcpService = new MCPService(mcpServerService, events, outputChannel);
  const managerLLMService = new ManagerLLMService(globalConfigDb, events);
  const services: Services = {
    agent: agentService,
    task: {} as TaskService,
    assist: {} as AssistService,
    message: messageService,
    policy: new PolicyService(globalConfigDb, events),
    notification: notificationService,
    session: new SessionService(db, events),
    thinking: new ThinkingService(db, events),
    fileChange: new FileChangeService(db, events),
    context: new ContextService(outputChannel, mcpService),
    aceContext: {} as AceContextService,
    automation: {} as AutomationService,
    mcpServer: mcpServerService,
    mcp: mcpService,
    taskContext: taskContextService,
    toolExecution: {} as ToolExecutionService,
    state: stateStore,
    managerLLM: managerLLMService,
    managerOrchestrator: {} as ManagerOrchestratorService,
    scheduler: {} as SchedulerService,
    failover: {} as FailoverService
  };

  const toolExecutionService = new ToolExecutionService(events, services, workspaceRoot, outputChannel);
  services.toolExecution = toolExecutionService;
  services.mcp.setToolRunRecorder(toolExecutionService);
  const recordAceRun = createAceRunRecorder(toolExecutionService, stateStore, workspaceRoot);
  services.aceContext = new AceContextService(globalConfigDb, workspaceRoot, outputChannel, recordAceRun);

  const taskService = new TaskService(db, events, stateStore, agentService, services.aceContext, notificationService, messageService);
  services.task = taskService;
  const assistService = new AssistService(stateStore, messageService, taskService, notificationService);
  services.assist = assistService;

  const automationService = new AutomationService({
    ace: services.aceContext,
    tools: toolExecutionService,
    state: stateStore,
    events,
    output: outputChannel,
    notifications: notificationService,
    messages: messageService
  });
  services.automation = automationService;
  events.emit('manager_llm_config_updated', managerLLMService.getConfig());
  const managerOrchestrator = new ManagerOrchestratorService({
    managerLLM: managerLLMService,
    messageService,
    assistService: assistService,
    taskService: taskService,
    toolService: toolExecutionService,
    automationService,
    notificationService: notificationService,
    state: stateStore,
    events,
    output: outputChannel,
    agentService
  });
  services.managerOrchestrator = managerOrchestrator;

  const schedulerService = new SchedulerService(agentService, taskService, stateStore, events, outputChannel);
  services.scheduler = schedulerService;

  const failoverService = new FailoverService(
    agentService,
    taskService,
    stateStore,
    events,
    outputChannel,
    notificationService,
    messageService
  );
  services.failover = failoverService;
  failoverService.start();

  return {
    services,
    toolExecution: toolExecutionService
  };
}

function createAceRunRecorder(
  toolExecutionService: ToolExecutionService,
  stateStore: StateStore,
  workspaceRoot: string
) {
  return async (run: {
    runId: string;
    type: 'index' | 'search' | 'test';
    stage: 'start' | 'end';
    status: 'running' | 'succeeded' | 'failed';
    query?: string;
    message?: string;
    metadata?: Record<string, any>;
  }) => {
    const basePayload: Record<string, any> = {};
    if (run.metadata?.projectRoot) {
      basePayload.projectRoot = run.metadata.projectRoot;
    }
    if (run.query) {
      basePayload.query = run.query;
    }
    basePayload.type = run.type;
    if (run.metadata) {
      basePayload.metadata = run.metadata;
    }

    stateStore.updateAceState(workspaceRoot, run);

    if (run.stage === 'start') {
      toolExecutionService.recordExternalRunStart({
        id: run.runId,
        agent_id: 'ace',
        tool_name: `ace:${run.type}`,
        runner: 'ace',
        source: 'ace',
        command: run.type === 'search' && run.query ? `search ${run.query}` : run.type,
        input: basePayload,
        created_by: 'ace'
      });
      return;
    }

    const outputPayload: Record<string, any> = { ...basePayload };
    if (run.metadata?.stats) {
      outputPayload.stats = run.metadata.stats;
    }
    if (run.metadata) {
      outputPayload.metadata = run.metadata;
    }
    if (run.message) {
      outputPayload.message = run.message;
    }

    toolExecutionService.recordExternalRunResult(run.runId, {
      status: run.status === 'succeeded' ? 'succeeded' : 'failed',
      output: outputPayload,
      error: run.status === 'failed' ? run.message || 'ACE 操作失败' : undefined
    });
  };
}
