// 服务层导出

export { AgentService } from './agent.service';
export { TaskService } from './task.service';
export { TaskContextService } from './task-context.service';
export { MessageService } from './message.service';
export { VoteService } from './vote.service';
export { ApprovalService } from './approval.service';
export { PolicyService } from './policy.service';
export { NotificationService } from './notification.service';
export { SessionService } from './session.service';
export { ThinkingService } from './thinking.service';
export { FileChangeService } from './file-change.service';
export { ContextService } from './context.service';
export { MCPServerService } from './mcp-server.service';
export { MCPService } from './mcp.service';
export { LockService } from './lock.service';
export { GovernanceHistoryService } from './governance-history.service';
export { ProofService } from './proof.service';
export { ToolExecutionService } from './tool-execution.service';

import { AgentService } from './agent.service';
import { TaskService } from './task.service';
import { TaskContextService } from './task-context.service';
import { MessageService } from './message.service';
import { VoteService } from './vote.service';
import { ApprovalService } from './approval.service';
import { PolicyService } from './policy.service';
import { NotificationService } from './notification.service';
import { SessionService } from './session.service';
import { ThinkingService } from './thinking.service';
import { FileChangeService } from './file-change.service';
import { ContextService } from './context.service';
import { MCPServerService } from './mcp-server.service';
import { MCPService } from './mcp.service';
import { LockService } from './lock.service';
import { GovernanceHistoryService } from './governance-history.service';
import { ProofService } from './proof.service';
import { ToolExecutionService } from './tool-execution.service';

// 服务集合类型
export interface Services {
  agent: AgentService;
  task: TaskService;
  message: MessageService;
  taskContext: TaskContextService;
  vote: VoteService;
  approval: ApprovalService;
  policy: PolicyService;
  notification: NotificationService;
  session: SessionService;
  thinking: ThinkingService;
  fileChange: FileChangeService;
  context: ContextService;
  mcpServer: MCPServerService;
  mcp: MCPService;
  lock: LockService;
  governanceHistory: GovernanceHistoryService;
  proof: ProofService;
  toolExecution: ToolExecutionService;
}
