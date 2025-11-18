import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Services } from '../../application/services';
import type { TypedEventEmitter } from '../../core/events/emitter';
import type { MCPServer, BlackboardReferenceType } from '../../core/types';
import { createLLMClient, type LLMProvider } from '../../infrastructure/llm';

type MCPServerInput = Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>;

export class MinimalPanelProvider {
  constructor(
    private readonly services: Services,
    private readonly events: TypedEventEmitter
  ) {}

  private setupEventListeners(webview: vscode.Webview) {
    // 监听 Agents 更新
    this.events.on('agents_update', (agents) => {
      console.log('[MinimalPanel] Agents update:', agents);
      webview.postMessage({ type: 'agents_update', data: agents });
    });

    // 监听 Tasks 更新
    this.events.on('tasks_update', (tasks) => {
      console.log('[MinimalPanel] Tasks update:', tasks);
      webview.postMessage({ type: 'tasks_update', data: tasks });
    });

    // 监听 Messages 更新
    this.events.on('messages_update', (messages) => {
      console.log('[MinimalPanel] Messages update:', messages);
      webview.postMessage({ type: 'messages_update', data: messages });
    });

    // 监听 Notifications 更新
    this.events.on('notifications_update', (notifications) => {
      console.log('[MinimalPanel] Notifications update:', notifications);
      webview.postMessage({ type: 'notifications_update', data: notifications });
    });

    // 监听 File Changes 更新
    this.events.on('file_changes_update', (changes) => {
      console.log('[MinimalPanel] File changes update:', changes.length);
      webview.postMessage({ type: 'file_changes_update', data: changes });
    });

    // 监听 MCP Servers 更新
    this.events.on('mcp_servers_update', (servers) => {
      console.log('[MinimalPanel] MCP servers update:', servers.length);
      webview.postMessage({ type: 'mcp_servers_update', data: servers });
    });

    this.events.on('mcp_server_status', (status) => {
      webview.postMessage({ type: 'mcp_server_status', data: status });
    });

    this.events.on('sessions_update', (sessions) => {
      console.log('[MinimalPanel] Sessions update:', sessions.length);
      webview.postMessage({ type: 'sessions_update', data: sessions });
    });

    this.events.on('thinking_logs_update', (logs) => {
      console.log('[MinimalPanel] Thinking logs update:', logs.length);
      webview.postMessage({ type: 'thinking_logs_update', data: logs });
    });

    this.events.on('task_metrics_update', (metrics) => {
      webview.postMessage({ type: 'task_metrics_update', data: metrics });
    });

    this.events.on('task_backlog_update', (summaries) => {
      webview.postMessage({ type: 'task_backlog_update', data: summaries });
    });

    this.events.on('llm_stream_update', (payload) => {
      webview.postMessage({ type: 'llm_stream_update', data: payload });
    });

    this.events.on('tool_runs_update', (runs) => {
      webview.postMessage({ type: 'tool_runs_update', data: runs });
    });

    this.events.on('state:ace_state_updated', (state) => {
      webview.postMessage({ type: 'ace_state_update', data: state });
    });

    this.events.on('manager_llm_config_updated', (config) => {
      webview.postMessage({ type: 'manager_llm_config', data: config });
    });

    this.events.on('state:assist_created', (assist) => {
      webview.postMessage({ type: 'assist_update', data: { type: 'created', assist } });
    });
    this.events.on('state:assist_updated', (assist) => {
      webview.postMessage({ type: 'assist_update', data: { type: 'updated', assist } });
    });
    this.events.on('state:assist_deleted', (id) => {
      webview.postMessage({ type: 'assist_update', data: { type: 'deleted', id } });
    });

    console.log('[MinimalPanel] Event listeners setup complete');
  }

  public getHtmlForWebview(webview: vscode.Webview): string {
    this.setupEventListeners(webview);

    const distHtmlPath = path.join(__dirname, 'minimal-panel.html');
    const srcHtmlPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'presentation',
      'webview',
      'minimal-panel.html'
    );
    const resolvedPath = fs.existsSync(distHtmlPath) ? distHtmlPath : srcHtmlPath;
    return fs.readFileSync(resolvedPath, 'utf8');
  }

  public async handleMessage(message: any, webview: vscode.Webview) {
    try {
      console.log('[MinimalPanel] Handling message:', message.type);

      switch (message.type) {
        case 'test':
          console.log('[MinimalPanel] Test message received:', message.data);
          vscode.window.showInformationMessage(`Test: ${message.data}`);
          break;

        case 'show_info':
          console.log('[MinimalPanel] Show info:', message.message);
          vscode.window.showInformationMessage(message.message);
          break;

        case 'get_agents':
          console.log('[MinimalPanel] Fetching agents...');
          const agents = this.services.agent.getAllAgents();
          console.log('[MinimalPanel] Agents fetched:', agents.length);
          webview.postMessage({ type: 'agents_data', data: agents });
          break;

        case 'get_tasks': {
          const sessionId = this.getRequestedSessionId(message);
          console.log('[MinimalPanel] Fetching tasks...', sessionId ? `session=${sessionId}` : '(all)');
          const tasks = this.services.task.getAllTasks(sessionId ? { session_id: sessionId } : {});
          console.log('[MinimalPanel] Tasks fetched:', tasks.length);
          webview.postMessage({ type: 'tasks_data', data: tasks });
          break;
        }
        case 'get_task_backlogs': {
          const sessionId = this.getRequestedSessionId(message);
          const summaries = this.services.task.getBacklogSummaries(sessionId ?? undefined);
          webview.postMessage({ type: 'task_backlog_update', data: summaries });
          break;
        }

        case 'get_messages': {
          const sessionId = this.getRequestedSessionId(message);
          console.log('[MinimalPanel] Fetching messages...', sessionId ? `session=${sessionId}` : '(all)');
          const messages = this.services.message.getAllMessages(sessionId ? { session_id: sessionId } : {});
          console.log('[MinimalPanel] Messages fetched:', messages.length);
          webview.postMessage({ type: 'messages_data', data: messages });
          break;
        }

        case 'get_sessions':
          console.log('[MinimalPanel] Fetching sessions...');
          const sessions = this.services.session.getAllSessions();
          console.log('[MinimalPanel] Sessions fetched:', sessions.length);
          webview.postMessage({ type: 'sessions_data', data: sessions });
          break;
        case 'get_ace_state': {
          const state = this.services.state.getAceState();
          webview.postMessage({ type: 'ace_state_update', data: state });
          break;
        }
        case 'get_ace_config': {
          try {
            const config = this.services.aceContext.getConfig();
            webview.postMessage({ type: 'ace_config', data: config });
          } catch (error: any) {
            webview.postMessage({
              type: 'ace_config_error',
              data: { message: error?.message ?? '无法读取 ACE 配置' }
            });
          }
          break;
        }
        case 'get_manager_llm_config': {
          try {
            const config = this.services.managerLLM.getConfig();
            webview.postMessage({ type: 'manager_llm_config', data: config });
          } catch (error: any) {
            webview.postMessage({
              type: 'manager_llm_config_error',
              data: { message: error?.message ?? '无法读取经理 LLM 配置' }
            });
          }
          break;
        }
        case 'update_manager_llm_config': {
          try {
            const updated = this.services.managerLLM.updateConfig(message.data || {});
            vscode.window.showInformationMessage('团队经理 LLM 配置已更新');
            webview.postMessage({ type: 'manager_llm_config', data: updated });
          } catch (error: any) {
            const errMsg = error?.message ?? '更新经理 LLM 配置失败';
            vscode.window.showErrorMessage(errMsg);
            webview.postMessage({
              type: 'manager_llm_config_error',
              data: { message: errMsg }
            });
          }
          break;
        }
        case 'test_manager_llm': {
          try {
            const cfg = this.services.managerLLM.getConfig();
            const provider = (cfg.provider || 'claude') as LLMProvider;
            const client = createLLMClient({
              provider,
              apiKey: cfg.api_key || '',
              model: cfg.model || '',
              baseURL: cfg.base_url || undefined,
              temperature: cfg.temperature ?? 0.4,
              maxTokens: cfg.max_output_tokens || 512
            });
            const prompt = '你是团队经理，请用一句话回复“连接正常”。';
            const res = await client.chat([
              { role: 'system', content: cfg.system_prompt || 'You are a system connectivity tester.' },
              { role: 'user', content: prompt }
            ], undefined, { systemPrompt: cfg.system_prompt || undefined, maxTokens: 128, temperature: cfg.temperature ?? 0.4 });
            const content = res.content?.trim() || '';
            webview.postMessage({
              type: 'manager_llm_test_result',
              data: { success: true, message: content || '调用成功，无返回内容' }
            });
          } catch (error: any) {
            webview.postMessage({
              type: 'manager_llm_test_result',
              data: { success: false, message: error?.message || '测试调用失败' }
            });
            vscode.window.showErrorMessage(error?.message || '经理 LLM 测试失败');
          }
          break;
        }
        case 'update_ace_config': {
          try {
            const updated = this.services.aceContext.updateConfig(message.data || {});
            vscode.window.showInformationMessage('ACE 配置已更新');
            webview.postMessage({ type: 'ace_config', data: updated });
          } catch (error: any) {
            const messageText = error?.message ?? '更新 ACE 配置失败';
            vscode.window.showErrorMessage(messageText);
            webview.postMessage({
              type: 'ace_config_error',
              data: { message: messageText }
            });
          }
          break;
        }
        case 'ace_refresh_index': {
          if (!this.services.aceContext.isConfigured()) {
            vscode.window.showWarningMessage('请先配置 ACE 后再刷新索引');
            webview.postMessage({
              type: 'ace_refresh_status',
              data: { success: false, message: 'ACE 未配置' }
            });
            break;
          }
          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: 'ACE 索引刷新中...'
              },
              async () => {
                await this.services.aceContext.refreshIndex();
              }
            );
            webview.postMessage({
              type: 'ace_refresh_status',
              data: { success: true, message: '索引刷新完成' }
            });
          } catch (error: any) {
            const messageText = error?.message ?? '刷新失败';
            vscode.window.showErrorMessage(messageText);
            webview.postMessage({
              type: 'ace_refresh_status',
              data: { success: false, message: messageText }
            });
          }
          break;
        }
        case 'ace_search': {
          const query = typeof message.data?.query === 'string' ? message.data.query.trim() : '';
          if (!query) {
            webview.postMessage({
              type: 'ace_search_result',
              data: { success: false, message: '请输入搜索关键词', query: '' }
            });
            break;
          }
          if (!this.services.aceContext.isConfigured()) {
            vscode.window.showWarningMessage('ACE 尚未配置，无法搜索。');
            webview.postMessage({
              type: 'ace_search_result',
              data: { success: false, message: 'ACE 未配置', query }
            });
            break;
          }
          try {
            const result = await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: 'ACE 搜索中...'
              },
              async () => {
                return await this.services.aceContext.search(query);
              }
            );
            webview.postMessage({
              type: 'ace_search_result',
              data: { success: true, query, result }
            });
          } catch (error: any) {
            const messageText = error?.message ?? '搜索失败';
            vscode.window.showErrorMessage(messageText);
            webview.postMessage({
              type: 'ace_search_result',
              data: { success: false, query, message: messageText }
            });
          }
          break;
        }
        case 'ace_test_connection': {
          if (!this.services.aceContext.isConfigured()) {
            webview.postMessage({
              type: 'ace_test_connection_result',
              data: { success: false, message: 'ACE 尚未配置' }
            });
            break;
          }
          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: '正在测试 ACE 连接...'
              },
              async () => {
                await this.services.aceContext.testConnection();
              }
            );
            webview.postMessage({
              type: 'ace_test_connection_result',
              data: { success: true, message: 'ACE 连接正常' }
            });
          } catch (error: any) {
            const errMsg = error?.message ?? '连接测试失败';
            vscode.window.showErrorMessage(errMsg);
            webview.postMessage({
              type: 'ace_test_connection_result',
              data: { success: false, message: errMsg }
            });
          }
          break;
        }
        case 'create_session': {
          const requestedId = typeof message.data?.id === 'string' ? message.data.id.trim() : '';
          const sessionId = requestedId || `session-${Date.now()}`;
          try {
            this.services.session.createSession(sessionId);
            vscode.window.showInformationMessage(`会话 ${sessionId} 已创建`);
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? `创建会话失败`);
          }
          break;
        }
        case 'delete_session': {
          const targetId = typeof message.data?.id === 'string' ? message.data.id.trim() : '';
          if (!targetId) {
            vscode.window.showWarningMessage('未指定需要删除的会话');
            break;
          }
          try {
            this.services.session.deleteSession(targetId);
            vscode.window.showInformationMessage(`会话 ${targetId} 已删除`);
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? `删除会话失败`);
          }
          break;
        }

        case 'get_notifications': {
          const sessionId = this.getRequestedSessionId(message);
          console.log('[MinimalPanel] Fetching notifications...', sessionId ? `session=${sessionId}` : '(all)');
          const notifications = this.services.notification.getAllNotifications(sessionId ? { session_id: sessionId } : {});
          console.log('[MinimalPanel] Notifications fetched:', notifications.length);
          webview.postMessage({ type: 'notifications_data', data: notifications });
          break;
        }

        case 'get_assists': {
          const sessionId = this.getRequestedSessionId(message);
          const assists = this.services.assist.getAssistRequests(
            sessionId ? { sessionId } : {}
          );
          webview.postMessage({ type: 'assists_data', data: assists });
          break;
        }

        case 'get_tool_runs': {
          const sessionId = this.getRequestedSessionId(message);
          const runs = this.services.toolExecution.getRuns(sessionId ?? undefined);
          webview.postMessage({ type: 'tool_runs_data', data: runs });
          break;
        }
        case 'run_tool_command': {
          const sessionId = this.getRequestedSessionId(message);
          const command = typeof message.data?.command === 'string' ? message.data.command.trim() : '';
          if (!command) {
            vscode.window.showWarningMessage('请输入要执行的命令');
            break;
          }
          try {
            await this.services.toolExecution.executeExternalCommand({
              session_id: sessionId ?? null,
              task_id: typeof message.data?.task_id === 'string' ? message.data.task_id : null,
              tool_name: 'manual_command',
              command,
              runner: 'manual',
              source: 'webview',
              created_by: 'user',
              confirmed: message.data?.confirmed === true
            });
            vscode.window.showInformationMessage('命令已执行');
            const runs = this.services.toolExecution.getRuns(sessionId ?? undefined);
            webview.postMessage({ type: 'tool_runs_data', data: runs });
          } catch (error: any) {
            // 检查是否需要用户确认
            if (error.requiresConfirmation && error.sensitiveData) {
              // 发送确认请求到前端
              webview.postMessage({
                type: 'sensitive_command_confirmation_required',
                data: error.sensitiveData
              });
            } else {
              // 其他错误，显示错误消息
              vscode.window.showErrorMessage(error?.message ?? '命令执行失败');
            }
          }
          break;
        }
        case 'run_mcp_ping': {
          const serverId = typeof message.data?.server_id === 'number' ? message.data.server_id : null;
          if (serverId === null) {
            vscode.window.showWarningMessage('请选择要测试的 MCP Server');
            break;
          }
          try {
            await this.services.mcp.pingServerById(serverId);
            vscode.window.showInformationMessage(`MCP Server ${serverId} 连接正常`);
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? 'MCP Ping 失败');
          }
          break;
        }
        case 'run_mcp_tool': {
          const serverId = typeof message.data?.server_id === 'number' ? message.data.server_id : null;
          const toolName = typeof message.data?.tool === 'string' ? message.data.tool.trim() : '';
          const args = message.data?.args && typeof message.data.args === 'object' ? message.data.args : {};
          if (serverId === null || !toolName) {
            vscode.window.showWarningMessage('请选择 MCP Server 且填入工具名');
            break;
          }
          try {
            const sessionId = this.getRequestedSessionId(message) ?? this.resolveSessionId(undefined, null);
            const taskId = typeof message.data?.task_id === 'string' ? message.data.task_id.trim() : null;
            const result = await this.services.mcp.callToolById(serverId, toolName, args, {
              session_id: sessionId,
              task_id: taskId,
              created_by: 'user'
            });
            vscode.window.showInformationMessage(`MCP 工具 ${toolName} 执行完成`);
            webview.postMessage({ type: 'mcp_tool_result', data: { serverId, tool: toolName, result } });
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? 'MCP 工具执行失败');
            webview.postMessage({ type: 'mcp_tool_result', data: { serverId, tool: toolName, error: error?.message ?? '执行失败' } });
          }
          break;
        }
        case 'list_mcp_tools': {
          const serverId = typeof message.data?.server_id === 'number' ? message.data.server_id : null;
          if (serverId === null) {
            vscode.window.showWarningMessage('请选择要刷新工具列表的 MCP Server');
            break;
          }
          try {
            const { tools } = await this.services.mcp.listToolsById(serverId);
            webview.postMessage({ type: 'mcp_tools_data', data: { serverId, tools } });
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? '获取 MCP 工具列表失败');
            webview.postMessage({ type: 'mcp_tool_result', data: { serverId, error: error?.message ?? '获取工具列表失败' } });
          }
          break;
        }

        case 'rerun_tool': {
          const runId = typeof message.data?.run_id === 'string' ? message.data.run_id.trim() : '';
          if (!runId) {
            vscode.window.showWarningMessage('未提供需要重试的运行 ID');
            break;
          }
          try {
            await this.services.toolExecution.rerunAutomationFromRun(runId);
            vscode.window.showInformationMessage('已触发工具重新执行');
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? '工具重新执行失败');
          }
          break;
        }



        case 'get_thinking_logs': {
          console.log('[MinimalPanel] Fetching thinking logs...');
          const filters = message.data?.filters || {};
          const sessionId = this.getRequestedSessionId(message);
          const logs = this.services.thinking.getThinkingLogs({
            session_id: sessionId,
            agent_id: typeof filters.agent_id === 'string' && filters.agent_id.trim().length > 0
              ? filters.agent_id.trim()
              : undefined,
            task_id: typeof filters.task_id === 'string' && filters.task_id.trim().length > 0
              ? filters.task_id.trim()
              : undefined
          });
          console.log('[MinimalPanel] Thinking logs fetched:', logs.length);
          webview.postMessage({ type: 'thinking_logs_data', data: logs });
          break;
        }

        case 'get_file_changes': {
          const sessionId = this.getRequestedSessionId(message);
          console.log('[MinimalPanel] Fetching file changes...', sessionId ? `session=${sessionId}` : '(all)');
          const filters = sessionId ? { session_id: sessionId } : undefined;
          const changes = this.services.fileChange.getFileChanges(filters);
          webview.postMessage({ type: 'file_changes_data', data: changes });
          break;
        }
        case 'get_task_metrics': {
          const sessionId = this.getRequestedSessionId(message);
          const metrics = this.services.task.getTaskMetrics(sessionId);
          webview.postMessage({ type: 'task_metrics_update', data: metrics });
          break;
        }
        case 'get_mcp_servers':
          console.log('[MinimalPanel] Fetching MCP servers...');
          const servers = this.services.mcpServer.getAllServers();
          webview.postMessage({
            type: 'mcp_servers_data',
            data: servers
          });
          servers.forEach(server => {
            this.refreshMcpServerStatus(server.id, webview);
          });
          break;
        case 'refresh_mcp_server_status': {
          const refreshId = Number(message.data?.id);
          if (Number.isNaN(refreshId)) {
            vscode.window.showErrorMessage('无效的 MCP Server ID');
            break;
          }
          await this.refreshMcpServerStatus(refreshId, webview);
          break;
        }
        case 'rollback_file_change':
          console.log('[MinimalPanel] Rolling back file change:', message.data);
          await this.handleRollbackFileChange(message.data?.changeId);
          break;
        case 'create_mcp_server':
          try {
            const config = this.sanitizeMcpConfigInput(message.data?.config);
            const server = this.services.mcpServer.createServer(config);
            vscode.window.showInformationMessage(`已创建 MCP Server：${server.name}`);
          await this.refreshMcpServerStatus(server.id, webview);
          } catch (error: any) {
            vscode.window.showErrorMessage(`创建 MCP Server 失败：${error?.message ?? error}`);
          }
          break;
        case 'update_mcp_server': {
          const updateId = Number(message.data?.id);
          if (Number.isNaN(updateId)) {
            vscode.window.showErrorMessage('无效的 MCP Server ID');
            break;
          }
          try {
            const config = this.sanitizeMcpConfigInput(message.data?.config);
            const server = this.services.mcpServer.updateServer(updateId, config);
            if (server) {
              vscode.window.showInformationMessage(`已更新 MCP Server：${server.name}`);
              await this.refreshMcpServerStatus(server.id, webview);
            }
          } catch (error: any) {
            vscode.window.showErrorMessage(`更新 MCP Server 失败：${error?.message ?? error}`);
          }
          break;
        }
        case 'open_file_change': {
          const changeId = Number(message.data?.changeId);
          if (Number.isNaN(changeId)) {
            vscode.window.showErrorMessage('无效的文件变更 ID');
            break;
          }
          try {
            await this.openFileChange(changeId);
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? '打开文件失败');
          }
          break;
        }
        case 'delete_mcp_server': {
          const id = Number(message.data?.id);
          if (Number.isNaN(id)) {
            vscode.window.showErrorMessage('无效的 MCP Server ID');
            break;
          }
          this.services.mcpServer.deleteServer(id);
          vscode.window.showInformationMessage('已删除 MCP Server');
          webview.postMessage({
            type: 'mcp_server_status',
            data: { serverId: id, available: false, error: '已删除' }
          });
          break;
        }
        case 'toggle_mcp_server': {
          const serverId = Number(message.data?.id);
          if (Number.isNaN(serverId)) {
            vscode.window.showErrorMessage('无效的 MCP Server ID');
            break;
          }
          const enabled = message.data?.enabled !== false;
          const record = this.services.mcpServer.getServerById(serverId);
          if (!record) {
            vscode.window.showErrorMessage(`未找到 MCP Server：${serverId}`);
            break;
          }
          this.services.mcpServer.setServerEnabled(serverId, enabled);
          const actionText = enabled ? '启用' : '停用';
          vscode.window.showInformationMessage(`MCP Server "${record.name}" 已${actionText}`);
          break;
        }
        case 'update_task_dependencies': {
          const taskId = typeof message.data?.task_id === 'string' ? message.data.task_id : '';
          const dependencies = Array.isArray(message.data?.dependencies) ? message.data.dependencies : [];
          if (!taskId) {
            vscode.window.showErrorMessage('缺少任务 ID');
            break;
          }
          try {
            this.services.task.updateTaskDependencies(taskId, dependencies);
            vscode.window.showInformationMessage('任务依赖已更新');
          } catch (error: any) {
            vscode.window.showErrorMessage(`更新任务依赖失败：${error?.message ?? error}`);
          }
          break;
        }
        case 'get_locks': {
          // Lock service removed - no longer supported
          webview.postMessage({ type: 'locks_data', data: [] });
          break;
        }
        case 'release_lock': {
          // Lock service removed - no longer supported
          vscode.window.showInformationMessage('锁管理功能已移除');
          break;
        }
        case 'release_lock_holder': {
          // Lock service removed - no longer supported
          vscode.window.showInformationMessage('锁管理功能已移除');
          break;
        }
        case 'release_session_locks': {
          // Lock service removed - no longer supported
          vscode.window.showInformationMessage('锁管理功能已移除');
          break;
        }
        case 'cleanup_expired_locks': {
          // Lock service removed - no longer supported
          vscode.window.showInformationMessage('锁管理功能已移除');
          break;
        }
        case 'open_integration_config':
          void vscode.commands.executeCommand('arranger.integration.openConfig');
          break;
        case 'send_message':
          console.log('[MinimalPanel] Sending message:', message.data);

          const requestedSessionId = this.getRequestedSessionId(message);
          const resolvedSessionId = this.resolveSessionId(
            typeof message.data?.task_id === 'string' ? message.data.task_id : undefined,
            requestedSessionId ?? null
          );

          // 分别处理 reply_to 和 references
          let replyTo: string | null = null;
          let references: string[] | null = null;
          const allowedReferenceTypes = new Set(['task', 'file', 'proof', 'message', 'notification', 'custom']);
          const referenceType = typeof message.data?.reference_type === 'string' && allowedReferenceTypes.has(message.data.reference_type)
            ? message.data.reference_type as BlackboardReferenceType
            : null;
          const referenceId = typeof message.data?.reference_id === 'string'
            ? message.data.reference_id as string
            : null;

          if (message.data.reply_to) {
            replyTo = message.data.reply_to;
          }

          if (message.data.references) {
            references = JSON.parse(message.data.references);
          }

          const rawMentions = message.data?.mentions;
          const mentions = Array.isArray(rawMentions)
            ? rawMentions.filter((m: any) => typeof m === 'string' && m.trim().length > 0).map((m: string) => m.trim())
            : null;

          const visibility = typeof message.data?.visibility === 'string'
            ? message.data.visibility
            : 'blackboard';

          // 补充所有必需字段
          const sentMessage = this.services.message.sendMessage({
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            session_id: resolvedSessionId,
            agent_id: 'user',
            content: message.data.content,
            priority: message.data.priority || 'normal',
            tags: null,
            reply_to: replyTo,
            references: references,
            reference_type: referenceType,
            reference_id: referenceType ? referenceId : null,
            mentions: mentions,
            expires_at: null,
            category: 'user',
            visibility,
            payload: null
          });
          console.log('[MinimalPanel] Message sent:', sentMessage);
          // 事件会自动触发更新，无需手动刷新
          break;

        case 'approve_request':
          vscode.window.showInformationMessage('审批功能已移除');
          break;

        case 'mark_notification_read':
          console.log('[MinimalPanel] Marking notification as read:', message.data);
          this.services.notification.markAsRead(message.data.notificationId);
          console.log('[MinimalPanel] Notification marked as read');
          // 事件会自动触发更新
          break;

        case 'pause_task': {
          const taskId = typeof message.data?.id === 'string' ? message.data.id : '';
          if (!taskId) {
            vscode.window.showWarningMessage('缺少任务 ID');
            break;
          }
          try {
            this.services.task.pauseTask(taskId);
            vscode.window.showInformationMessage(`任务 ${taskId} 已暂停`);
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? '暂停任务失败');
          }
          break;
        }

        case 'resume_task': {
          const taskId = typeof message.data?.id === 'string' ? message.data.id : '';
          if (!taskId) {
            vscode.window.showWarningMessage('缺少任务 ID');
            break;
          }
          try {
            this.services.task.resumeTask(taskId);
            vscode.window.showInformationMessage(`任务 ${taskId} 已重新启动`);
          } catch (error: any) {
            vscode.window.showErrorMessage(error?.message ?? '任务恢复失败');
          }
          break;
        }

        case 'create_agent':
          console.log('[MinimalPanel] Creating agent:', message.data);
          const newAgent = this.services.agent.createAgent({
            id: message.data.id,
            display_name: message.data.display_name,
            capability_tags: message.data.capability_tags || message.data.capabilities || [],
            capabilities: message.data.capabilities || [],
            reasoning_tier: typeof message.data.reasoning_tier === 'number' ? message.data.reasoning_tier : 5,
            cost_factor: typeof message.data.cost_factor === 'number'
              ? message.data.cost_factor
              : (typeof message.data.cost_factor === 'string' ? Number(message.data.cost_factor) || 1 : 1),
            is_enabled: true,
            status: 'offline',
            status_detail: null,
            status_eta: null,
            active_task_id: null,
            status_updated_at: Date.now(),
            last_heartbeat_at: Date.now(),
            // LLM 配置
            llm_provider: message.data.llm_provider,
            llm_model: message.data.llm_model,
            llm_api_key: message.data.llm_api_key,
            llm_base_url: message.data.llm_base_url
          });
          console.log('[MinimalPanel] Agent created:', newAgent);

          vscode.window.showInformationMessage(`Agent "${message.data.display_name}" 创建成功！`);
          // 事件会自动触发更新
          break;

        case 'update_agent':
          console.log('[MinimalPanel] Updating agent:', message.data.id);
          this.services.agent.updateAgent(message.data.id, {
            display_name: message.data.display_name,
            capability_tags: message.data.capability_tags || message.data.capabilities,
            capabilities: message.data.capabilities,
            reasoning_tier: message.data.reasoning_tier,
            cost_factor: message.data.cost_factor,
            // LLM 配置
            llm_provider: message.data.llm_provider,
            llm_model: message.data.llm_model,
            llm_api_key: message.data.llm_api_key,
            llm_base_url: message.data.llm_base_url
          });
          vscode.window.showInformationMessage(`Agent "${message.data.display_name}" 已更新`);
          // 事件会自动触发更新
          break;

        case 'delete_agent':
          console.log('[MinimalPanel] Deleting agent:', message.data.id);
          // 显示确认对话框
          const deleteConfirm = await vscode.window.showWarningMessage(
            '确定要删除这个 Agent 吗？',
            { modal: true },
            '删除'
          );
          if (deleteConfirm === '删除') {
            this.services.agent.deleteAgent(message.data.id);
            vscode.window.showInformationMessage(`Agent 已删除`);
          }
          // 事件会自动触发更新
          break;

        case 'refresh_agent_llm': {
          const agentId = typeof message.data?.id === 'string' ? message.data.id : '';
          if (!agentId) {
            console.warn('[MinimalPanel] Missing agent id for refresh');
            webview.postMessage({
              type: 'agent_refresh_status',
              data: { id: agentId, success: false, error: '缺少 Agent ID' }
            });
            break;
          }
          const agent = this.services.agent.getAgent(agentId);
          if (!agent) {
            vscode.window.showErrorMessage(`未找到 Agent ${agentId}`);
            webview.postMessage({
              type: 'agent_refresh_status',
              data: { id: agentId, success: false, error: 'Agent 不存在' }
            });
            break;
          }
          try {
            if (!agent.llm_provider || !agent.llm_model || !agent.llm_api_key) {
              throw new Error('LLM 配置不完整，请先补全信息');
            }
            await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: `正在刷新 ${agent.display_name || agent.id}`
            }, async () => {
              const llmClient = createLLMClient({
                provider: agent.llm_provider as LLMProvider,
                apiKey: agent.llm_api_key || '',
                model: agent.llm_model || '',
                baseURL: agent.llm_base_url || undefined
              });
              await llmClient.chat([
                { role: 'system', content: 'You are a health-check assistant. Reply with a short confirmation.' },
                { role: 'user', content: 'ping' }
              ], undefined, { maxTokens: 16, temperature: 0.1 });
            });
            this.services.agent.updateAgentStatus(agentId, {
              status: 'online',
              status_detail: 'LLM 连接正常',
              active_task_id: null
            });
            this.services.agent.updateHeartbeat(agentId);
            webview.postMessage({
              type: 'agent_refresh_status',
              data: { id: agentId, success: true }
            });
            vscode.window.showInformationMessage(`Agent ${agent.display_name || agent.id} LLM 连接正常`);
          } catch (error: any) {
            const messageText = error?.message ?? 'LLM 刷新失败';
            this.services.agent.updateAgentStatus(agentId, {
              status: 'offline',
              status_detail: messageText
            });
            webview.postMessage({
              type: 'agent_refresh_status',
              data: { id: agentId, success: false, error: messageText }
            });
            vscode.window.showErrorMessage(`Agent ${agent.display_name || agent.id} 刷新失败：${messageText}`);
          }
          break;
        }
        case 'toggle_agent_enabled': {
          const agentId = typeof message.data?.id === 'string' ? message.data.id : '';
          if (!agentId) {
            vscode.window.showWarningMessage('缺少 Agent ID，无法切换状态');
            break;
          }
          const enabled = message.data?.enabled !== false;
          const agent = this.services.agent.getAgent(agentId);
          if (!agent) {
            vscode.window.showErrorMessage(`未找到 Agent：${agentId}`);
            break;
          }
          this.services.agent.setAgentEnabled(agentId, enabled);
          const actionText = enabled ? '启用' : '停用';
          vscode.window.showInformationMessage(`Agent "${agent.display_name || agent.id}" 已${actionText}`);
          break;
        }

        case 'subscribe_blackboard':
          // v3.0 架构中不需要订阅，EventEmitter 会自动推送更新
          console.log('[MinimalPanel] Blackboard subscription not needed in v3.0 architecture');
          break;

        default:
          console.log('[MinimalPanel] Unknown message type:', message.type);
      }
    } catch (error: any) {
      console.error('[MinimalPanel] Error:', error);
      vscode.window.showErrorMessage(`Error: ${error?.message ?? error}`);
    }
  }

  private async handleRollbackFileChange(changeId?: number) {
    if (typeof changeId !== 'number' || Number.isNaN(changeId)) {
      vscode.window.showWarningMessage('无效的变更 ID');
      return;
    }

    const change = this.services.fileChange.getFileChange(changeId);
    if (!change) {
      vscode.window.showWarningMessage(`未找到变更 ${changeId}`);
      return;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      vscode.window.showErrorMessage('未打开工作区，无法执行回滚');
      return;
    }

    const absolutePath = path.join(workspace, change.file_path);
    let previousContent: string | null = null;
    let fileExists = false;

    try {
      const stat = await fs.promises.stat(absolutePath);
      if (stat.isFile()) {
        fileExists = true;
        previousContent = await fs.promises.readFile(absolutePath, 'utf8');
      }
    } catch (error) {
      fileExists = false;
    }

    const reason = `Rollback to change ${changeId}`;
    let newContent: string | null = null;
    let changeType: 'create' | 'modify' | 'delete' = 'modify';

    try {
      if (change.change_type === 'create') {
        if (fileExists) {
          await fs.promises.unlink(absolutePath);
        }
        newContent = null;
        changeType = 'delete';
      } else {
        newContent = change.old_content ?? '';
        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, newContent, 'utf8');
        changeType = change.change_type === 'delete' ? 'create' : 'modify';
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`回滚文件失败: ${error?.message ?? error}`);
      return;
    }

    this.services.fileChange.recordChange({
      session_id: change.session_id,
      task_id: change.task_id,
      agent_id: 'user',
      file_path: change.file_path,
      change_type: changeType,
      old_content: previousContent,
      new_content: newContent,
      diff: reason,
      line_changes: computeLineChanges(previousContent, newContent),
      reason
    });

    vscode.window.showInformationMessage(`文件 ${change.file_path} 已回滚到变更 ${changeId}`);
  }

  private async openFileChange(changeId: number) {
    const change = this.services.fileChange.getFileChange(changeId);
    if (!change) {
      throw new Error(`未找到文件变更 ${changeId}`);
    }
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      throw new Error('未打开工作区，无法定位文件');
    }
    const absolutePath = path.isAbsolute(change.file_path)
      ? change.file_path
      : path.join(workspace, change.file_path);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const targetLine = this.extractDiffTargetLine(change.diff);
    if (targetLine !== null) {
      const safeLine = Math.max(0, Math.min(targetLine, Math.max(document.lineCount - 1, 0)));
      const position = new vscode.Position(safeLine, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  private extractDiffTargetLine(diffText?: string | null): number | null {
    if (!diffText) {
      return null;
    }
    const lines = diffText.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (match) {
        const lineNumber = parseInt(match[1], 10);
        if (!Number.isNaN(lineNumber)) {
          return lineNumber - 1;
        }
      }
    }
    return 0;
  }

  private normalizeSessionId(value: any): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private getRequestedSessionId(message: any): string | undefined {
    if (!message) {
      return undefined;
    }
    const candidates = [
      message.session_id,
      message?.data?.session_id,
      message?.data?.filters?.session_id
    ];
    for (const candidate of candidates) {
      const normalized = this.normalizeSessionId(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }



  private resolveSessionId(taskId?: string, requestedSessionId?: string | null): string {
    if (requestedSessionId) {
      return this.services.session.getOrCreateSession(requestedSessionId).id;
    }
    if (taskId) {
      const task = this.services.task.getTask(taskId);
      if (task?.session_id) {
        this.services.session.getOrCreateSession(task.session_id);
        return task.session_id;
      }
    }
    const sessions = this.services.session.getAllSessions();
    if (sessions.length > 0) {
      return sessions[sessions.length - 1].id;
    }
    const fallbackId = `session-${Date.now()}`;
    const session = this.services.session.createSession(fallbackId);
    return session.id;
  }

  private async refreshMcpServerStatus(serverId: number, webview: vscode.Webview) {
    const server = this.services.mcpServer.getServerById(serverId);
    if (!server || !server.enabled) {
      webview.postMessage({
        type: 'mcp_server_status',
        data: { serverId, available: false, error: server ? '已禁用' : '未找到 Server' }
      });
      return;
    }
    try {
      const result = await this.services.mcp.pingServer(server);
      if (result.tools) {
        webview.postMessage({
          type: 'mcp_tools_data',
          data: { serverId: server.id, tools: result.tools }
        });
      }
      webview.postMessage({
        type: 'mcp_server_status',
        data: {
          serverId: server.id,
          available: result.available,
          error: result.error ?? null,
          toolCount: result.tools ? result.tools.length : null
        }
      });
    } catch (error: any) {
      webview.postMessage({
        type: 'mcp_server_status',
        data: {
          serverId,
          available: false,
          error: error?.message ?? String(error),
          toolCount: null
        }
      });
    }
  }

  private sanitizeMcpConfigInput(config: any): MCPServerInput {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('配置必须是对象');
    }
    const name = typeof config.name === 'string' ? config.name.trim() : '';
    const command = typeof config.command === 'string' ? config.command.trim() : '';
    if (!name || !command) {
      throw new Error('name 与 command 为必填项');
    }
    const args = Array.isArray(config.args)
      ? config.args.map((arg: any) => String(arg))
      : [];
    let env: Record<string, string> | undefined;
    if (config.env !== undefined) {
      if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
        throw new Error('env 必须是对象');
      }
      env = {};
      Object.entries(config.env).forEach(([key, value]) => {
        env![String(key)] = String(value);
      });
    }
    return {
      name,
      description: config.description ? String(config.description) : undefined,
      command,
      args,
      env,
      enabled: config.enabled !== false,
      is_default: !!config.is_default
    };
  }
}

function computeLineChanges(oldContent: string | null, newContent: string | null) {
  const oldLines = (oldContent ?? '').split(/\r?\n/);
  const newLines = (newContent ?? '').split(/\r?\n/);
  return {
    added: Math.max(newLines.length - oldLines.length, 0),
    removed: Math.max(oldLines.length - newLines.length, 0)
  };
}
