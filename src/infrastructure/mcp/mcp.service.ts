import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { MCPServerService } from './mcp-server.service';
import type { MCPServer } from '../../core/types';
import { TypedEventEmitter } from '../../core/events/emitter';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: NodeJS.Timeout;
}

interface MCPContextSearchOptions {
  serverName?: string;
  payload: Record<string, any>;
}

class MCPError extends Error {
  constructor(message: string, public readonly code?: number, public readonly data?: any) {
    super(message);
    this.name = 'MCPError';
  }
}

class MCPServerConnection {
  private process?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private initializePromise: Promise<void> | null = null;

  constructor(
    private config: MCPServer,
    private readonly workspaceRoot: string,
    private readonly logger: vscode.OutputChannel
  ) {}

  matches(server: MCPServer): boolean {
    return this.config.id === server.id && this.config.updated_at === server.updated_at;
  }

  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    await this.ensureReady();
    
    // 获取可用工具列表，用于工具名称匹配
    let tools: any[] = [];
    try {
      const listResult = await this.listTools();
      tools = Array.isArray(listResult?.tools) ? listResult.tools : (Array.isArray(listResult) ? listResult : []);
    } catch (error) {
      // 如果获取工具列表失败，继续使用原始工具名
    }
    
    // 尝试找到匹配的工具名
    let actualToolName = toolName;
    if (tools.length > 0) {
      // 首先尝试精确匹配
      const exactMatch = tools.find(tool => tool.name === toolName);
      if (exactMatch) {
        actualToolName = exactMatch.name;
      } else {
        // 尝试大小写不敏感匹配
        const caseInsensitiveMatch = tools.find(tool => tool.name.toLowerCase() === toolName.toLowerCase());
        if (caseInsensitiveMatch) {
          actualToolName = caseInsensitiveMatch.name;
        } else {
          // 尝试驼峰命名与小写命名的转换
          const camelCaseName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
          const camelCaseMatch = tools.find(tool => tool.name === camelCaseName);
          if (camelCaseMatch) {
            actualToolName = camelCaseMatch.name;
          } else {
            const snakeCaseName = toolName.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/^_/, '');
            const snakeCaseMatch = tools.find(tool => tool.name === snakeCaseName);
            if (snakeCaseMatch) {
              actualToolName = snakeCaseMatch.name;
            }
          }
        }
      }
    }
    
    try {
      // 首先尝试使用新协议的 tools/call
      const result = await this.sendRequest('tools/call', { name: actualToolName, arguments: args });
      
      // 检查响应是否包含错误信息（某些 MCP 服务器将错误包装在成功的响应中）
      if (result && result.isError && result.content && Array.isArray(result.content)) {
        const errorText = result.content.find((item: any) => item.type === 'text')?.text;
        if (errorText && errorText.includes('Unknown tool')) {
          throw new Error(errorText);
        }
      }
      
      return result;
    } catch (error: any) {
      // 如果是工具名称错误，尝试使用原始名称
      if (error.message && error.message.includes('Unknown tool') && actualToolName !== toolName) {
        try {
          const result = await this.sendRequest('tools/call', { name: toolName, arguments: args });
          
          // 再次检查响应是否包含错误信息
          if (result && result.isError && result.content && Array.isArray(result.content)) {
            const errorText = result.content.find((item: any) => item.type === 'text')?.text;
            if (errorText && errorText.includes('Unknown tool')) {
              throw new Error(errorText);
            }
          }
          
          return result;
        } catch (originalError: any) {
          throw originalError;
        }
      }
      
      if (error instanceof MCPError && error.code === -32601) {
        // 如果 tools/call 不支持，尝试旧协议的 call_tool
        try {
          const result = await this.sendRequest('call_tool', { name: actualToolName, arguments: args });
          
          // 检查响应是否包含错误信息
          if (result && result.isError && result.content && Array.isArray(result.content)) {
            const errorText = result.content.find((item: any) => item.type === 'text')?.text;
            if (errorText && errorText.includes('Unknown tool')) {
              throw new Error(errorText);
            }
          }
          
          return result;
        } catch (fallbackError: any) {
          // 如果 call_tool 也不支持，尝试 tools/call（可能只是工具名称问题）
          if (fallbackError instanceof MCPError && fallbackError.code === -32601) {
            const result = await this.sendRequest('tools/call', { name: actualToolName, arguments: args });
            
            // 检查响应是否包含错误信息
            if (result && result.isError && result.content && Array.isArray(result.content)) {
              const errorText = result.content.find((item: any) => item.type === 'text')?.text;
              if (errorText && errorText.includes('Unknown tool')) {
                throw new Error(errorText);
              }
            }
            
            return result;
          }
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  async listTools() {
    await this.ensureReady();
    try {
      return await this.sendRequest('tools/list', {}, 30000);
    } catch (error: any) {
      if (error instanceof MCPError && error.code === -32601) {
        return this.sendRequest('list_tools', {}, 30000);
      }
      throw error;
    }
  }

  async listResources() {
    await this.ensureReady();
    try {
      return await this.sendRequest('resources/list', {}, 30000);
    } catch (error: any) {
      if (error instanceof MCPError && error.code === -32601) {
        return this.sendRequest('list_resources', {}, 30000);
      }
      throw error;
    }
  }

  async readResource(uri: string) {
    await this.ensureReady();
    const params = { uri };
    try {
      return await this.sendRequest('resources/read', params, 30000);
    } catch (error: any) {
      if (error instanceof MCPError && error.code === -32601) {
        return this.sendRequest('read_resource', params, 30000);
      }
      throw error;
    }
  }

  async listPrompts() {
    await this.ensureReady();
    try {
      return await this.sendRequest('prompts/list', {}, 30000);
    } catch (error: any) {
      if (error instanceof MCPError && error.code === -32601) {
        return this.sendRequest('list_prompts', {}, 30000);
      }
      throw error;
    }
  }

  async getPrompt(name: string) {
    await this.ensureReady();
    const params = { name };
    try {
      return await this.sendRequest('prompts/get', params, 30000);
    } catch (error: any) {
      if (error instanceof MCPError && error.code === -32601) {
        return this.sendRequest('get_prompt', params, 30000);
      }
      throw error;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
    this.pending.forEach(entry => {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP connection disposed'));
    });
    this.pending.clear();
  }

  private async ensureReady() {
    if (this.disposed) {
      throw new Error(`MCP connection (${this.config.name}) has been disposed`);
    }
    if (!this.process) {
      this.startProcess();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize();
    }
    return this.initializePromise;
  }

  private startProcess() {
    const env = {
      ...process.env,
      ...(this.config.env || {})
    };
    this.logger.appendLine(`[MCP] Starting server ${this.config.name}: ${this.config.command} ${this.config.args.join(' ')}`);
    this.process = spawn(this.config.command, this.config.args || [], {
      cwd: this.workspaceRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.logger.appendLine(`[MCP][${this.config.name}] stderr: ${chunk.toString()}`);
    });
    this.process.on('exit', (code, signal) => {
      this.logger.appendLine(`[MCP] Server ${this.config.name} exited (code=${code} signal=${signal})`);
      this.process = undefined;
      this.rejectAll(new Error(`MCP server ${this.config.name} exited`));
    });
    this.process.on('error', (error) => {
      this.logger.appendLine(`[MCP] Failed to start server ${this.config.name}: ${error instanceof Error ? error.message : error}`);
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async initialize() {
    try {
      // 使用最新的 MCP 协议格式 (2024-11-05)
      // 注意：参数名使用驼峰命名，不是下划线
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',  // 使用最新协议版本
        capabilities: {
          roots: {
            listChanged: true
          },
          sampling: {}
        },
        clientInfo: {  // 驼峰命名
          name: 'Arranger Orchestrator',
          version: '0.1.0'
        }
      }, 60000);

      this.logger.appendLine(`[MCP] Server ${this.config.name} initialized with protocol ${initResult?.protocolVersion || 'unknown'}`);

      // 发送 initialized 通知（MCP 协议要求）
      await this.sendNotification('notifications/initialized');
      this.logger.appendLine(`[MCP] Sent initialized notification to ${this.config.name}`);
    } catch (error: any) {
      this.logger.appendLine(`[MCP] initialize failed for ${this.config.name}: ${error?.message || error}`);
      throw error;
    }
  }

  private handleStdout(chunk: Buffer) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    // MCP stdio 传输标准：消息以换行符分隔
    // 参考：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio
    while (true) {
      const text = this.stdoutBuffer.toString('utf8');
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex === -1) {
        return; // 等待完整的一行
      }

      const line = text.substring(0, newlineIndex).trim();
      this.stdoutBuffer = Buffer.from(text.substring(newlineIndex + 1), 'utf8');

      if (line.length === 0) {
        continue; // 跳过空行
      }

      // 尝试解析为 JSON
      try {
        JSON.parse(line); // 验证是否为有效 JSON
        this.handleMessage(line);
      } catch (error) {
        // 不是 JSON，可能是其他输出，记录并继续
        this.logger.appendLine(`[MCP][${this.config.name}] Non-JSON output: ${line}`);
      }
    }
  }

  private handleMessage(message: string) {
    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch (error) {
      this.logger.appendLine(`[MCP] Failed to parse message from ${this.config.name}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (payload.id !== undefined && this.pending.has(payload.id)) {
      const entry = this.pending.get(payload.id)!;
      clearTimeout(entry.timer);
      this.pending.delete(payload.id);
      if (payload.error) {
        entry.reject(new MCPError(payload.error.message || 'MCP error', payload.error.code, payload.error.data));
      } else {
        entry.resolve(payload.result);
      }
    } else if (payload.method) {
      this.logger.appendLine(`[MCP] Notification from ${this.config.name}: ${payload.method}`);
    } else {
      this.logger.appendLine(`[MCP] Unhandled MCP message from ${this.config.name}`);
    }
  }

  private sendRequest(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error(`MCP server ${this.config.name} is not running`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    // MCP stdio 传输标准：消息以换行符分隔
    const message = payload + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(message, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private async sendNotification(method: string, params?: any): Promise<void> {
    if (!this.process || !this.process.stdin) {
      throw new Error(`MCP server ${this.config.name} is not running`);
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    // MCP stdio 传输标准：消息以换行符分隔
    const message = payload + '\n';

    return new Promise((resolve, reject) => {
      this.process!.stdin.write(message, 'utf8', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private rejectAll(error: Error) {
    this.pending.forEach(entry => {
      clearTimeout(entry.timer);
      entry.reject(error);
    });
    this.pending.clear();
    this.initializePromise = null;
  }
}

interface ToolRunRecorder {
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
  }): void;
  recordExternalRunResult(runId: string, result: {
    status: 'succeeded' | 'failed';
    output?: Record<string, any> | null;
    exit_code?: number | null;
    error?: string | null;
  }): void;
}

export class MCPService {
  private connections = new Map<number, MCPServerConnection>();
  private readonly workspaceRoot: string;
  private readonly statusCache = new Map<number, { available: boolean; error?: string | null; toolCount?: number | null; checked_at: number }>();
  private readonly toolCache = new Map<number, any[]>();
  private readonly resourceCache = new Map<number, any[]>();
  private readonly promptCache = new Map<number, any[]>();
  private toolRunRecorder?: ToolRunRecorder;

  constructor(
    private readonly serverService: MCPServerService,
    private readonly events: TypedEventEmitter,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    this.events.on('mcp_servers_update', () => this.pruneConnections());
  }

  async searchContext(options: MCPContextSearchOptions): Promise<{ payload: any; server: MCPServer }> {
    const server = this.resolveServer(options.serverName);
    const connection = await this.getConnection(server);
    const payload = await this.invokeTool(server, connection, 'search_context', options.payload);
    return { payload, server };
  }

  async callTool(
    serverName: string | undefined,
    toolName: string,
    payload: Record<string, any>,
    context?: { session_id?: string | null; task_id?: string | null; created_by?: string | null }
  ) {
    const server = this.resolveServer(serverName);
    const connection = await this.getConnection(server);
    return this.invokeTool(server, connection, toolName, payload, context);
  }

  async listTools(serverName?: string) {
    const server = this.resolveServer(serverName);
    const connection = await this.getConnection(server);
    const result = await connection.listTools();
    const tools = Array.isArray(result?.tools) ? result.tools : (Array.isArray(result) ? result : []);
    this.toolCache.set(server.id, tools);
    return { server, tools };
  }

  async listResources(serverName?: string) {
    const server = this.resolveServer(serverName);
    const connection = await this.getConnection(server);
    const result = await connection.listResources();
    const resources = Array.isArray(result?.resources) ? result.resources : (Array.isArray(result) ? result : []);
    this.resourceCache.set(server.id, resources);
    return { server, resources };
  }

  async readResource(serverName: string | undefined, uri: string) {
    const server = this.resolveServer(serverName);
    const connection = await this.getConnection(server);
    const resource = await connection.readResource(uri);
    return { server, resource };
  }

  async listPrompts(serverName?: string) {
    const server = this.resolveServer(serverName);
    const connection = await this.getConnection(server);
    const result = await connection.listPrompts();
    const prompts = Array.isArray(result?.prompts) ? result.prompts : (Array.isArray(result) ? result : []);
    this.promptCache.set(server.id, prompts);
    return { server, prompts };
  }

  async getPrompt(serverName: string | undefined, name: string) {
    const server = this.resolveServer(serverName);
    const connection = await this.getConnection(server);
    const prompt = await connection.getPrompt(name);
    return { server, prompt };
  }

  async listToolsById(serverId: number) {
    const server = this.serverService.getServerById(serverId);
    if (!server) {
      throw new Error(`未找到 MCP Server：${serverId}`);
    }
    if (!server.enabled) {
      throw new Error(`MCP Server ${server.name} 已停用`);
    }
    const connection = await this.getConnection(server);
    const result = await connection.listTools();
    const tools = Array.isArray(result?.tools) ? result.tools : (Array.isArray(result) ? result : []);
    this.toolCache.set(server.id, tools);
    this.statusCache.set(server.id, {
      available: true,
      error: null,
      toolCount: tools.length,
      checked_at: Date.now()
    });
    return { server, tools };
  }

  async callToolById(
    serverId: number,
    toolName: string,
    payload: Record<string, any>,
    context?: { session_id?: string | null; task_id?: string | null; created_by?: string | null }
  ) {
    const server = this.serverService.getServerById(serverId);
    if (!server) {
      throw new Error(`未找到 MCP Server：${serverId}`);
    }
    if (!server.enabled) {
      throw new Error(`MCP Server ${server.name} 已停用`);
    }
    const connection = await this.getConnection(server);
    return this.invokeTool(server, connection, toolName, payload, context);
  }

  async pingServer(server: MCPServer): Promise<{ available: boolean; error?: string | null; tools?: any[] }> {
    if (!server.enabled) {
      return { available: false, error: '已禁用' };
    }
    try {
      const connection = await this.getConnection(server);
      const result = await connection.listTools();
      const tools = Array.isArray(result?.tools) ? result.tools : (Array.isArray(result) ? result : []);
      this.toolCache.set(server.id, tools);
      const status = { available: true, error: undefined, tools };
      this.statusCache.set(server.id, { available: true, error: null, toolCount: tools.length, checked_at: Date.now() });
      return status;
    } catch (error: any) {
      this.disposeConnection(server.id);
      const message = error?.message ?? String(error);
      this.statusCache.set(server.id, { available: false, error: message, toolCount: null, checked_at: Date.now() });
      return { available: false, error: message };
    }
  }

  async pingServerById(serverId: number): Promise<{ available: boolean; error?: string | null; tools?: any[] }> {
    const server = this.serverService.getServerById(serverId);
    if (!server) {
      throw new Error(`未找到 MCP Server：${serverId}`);
    }
    return this.pingServer(server);
  }

  getCachedStatus(serverId: number) {
    return this.statusCache.get(serverId);
  }

  dispose() {
    for (const connection of this.connections.values()) {
      connection.dispose();
    }
    this.connections.clear();
  }

  setToolRunRecorder(recorder: ToolRunRecorder) {
    this.toolRunRecorder = recorder;
  }

  private resolveServer(name?: string): MCPServer {
    if (name) {
      const server = this.serverService.getServerByName(name);
      if (!server) {
        throw new Error(`MCP server ${name} does not exist`);
      }
      if (!server.enabled) {
        throw new Error(`MCP server ${name} is disabled`);
      }
      return server;
    }
    const server = this.serverService.getDefaultServer();
    if (!server) {
      throw new Error('No MCP server configured');
    }
    if (!server.enabled) {
      throw new Error(`MCP server ${server.name} is disabled`);
    }
    return server;
  }

  private async getConnection(server: MCPServer): Promise<MCPServerConnection> {
    const existing = this.connections.get(server.id);
    if (existing && existing.matches(server)) {
      return existing;
    }
    if (existing) {
      existing.dispose();
      this.connections.delete(server.id);
    }
    const connection = new MCPServerConnection(server, this.workspaceRoot, this.outputChannel);
    this.connections.set(server.id, connection);
    return connection;
  }

  private disposeConnection(serverId: number) {
    const existing = this.connections.get(serverId);
    if (existing) {
      existing.dispose();
      this.connections.delete(serverId);
    }
  }

  private pruneConnections() {
    const servers = this.serverService.getAllServers();
    const serverMap = new Map(servers.map(server => [server.id, server]));
    for (const [id, connection] of this.connections.entries()) {
      const server = serverMap.get(id);
      if (!server || !server.enabled) {
        connection.dispose();
        this.connections.delete(id);
      }
    }
  }

  private async invokeTool(
    server: MCPServer,
    connection: MCPServerConnection,
    toolName: string,
    payload: Record<string, any>,
    context?: { session_id?: string | null; task_id?: string | null; created_by?: string | null }
  ) {
    const runId = `mcp_${server.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    if (this.toolRunRecorder) {
      this.toolRunRecorder.recordExternalRunStart({
        id: runId,
        session_id: context?.session_id ?? null,
        task_id: context?.task_id ?? null,
        workflow_instance_id: null,
        tool_name: `${server.name}:${toolName}`,
        runner: 'mcp',
        source: 'mcp',
        command: toolName,
        input: payload,
        created_by: context?.created_by ?? 'mcp'
      });
    }
    try {
      const result = await connection.callTool(toolName, payload);
      if (this.toolRunRecorder) {
        this.toolRunRecorder.recordExternalRunResult(runId, {
          status: 'succeeded',
          output: result ?? null
        });
      }
      return result;
    } catch (error: any) {
      if (this.toolRunRecorder) {
        this.toolRunRecorder.recordExternalRunResult(runId, {
          status: 'failed',
          error: error?.message ?? String(error)
        });
      }
      throw error;
    }
  }
}
