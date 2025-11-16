import * as vscode from 'vscode';
import { MCPServerService } from '../services/mcp-server.service';
import { MCPService } from '../services/mcp.service';
import { TypedEventEmitter } from '../events/emitter';

interface MCPMonitorOptions {
  intervalMs?: number;
}

export class MCPMonitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly intervalMs: number;

  constructor(
    private readonly serverService: MCPServerService,
    private readonly mcpService: MCPService,
    private readonly events: TypedEventEmitter,
    private readonly logger: vscode.OutputChannel,
    options?: MCPMonitorOptions
  ) {
    this.intervalMs = options?.intervalMs ?? 45000;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.logger.appendLine('[MCPMonitor] Starting MCP monitor');
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.appendLine('[MCPMonitor] MCP monitor stopped');
    }
  }

  private async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const servers = this.serverService.getAllServers();
      for (const server of servers) {
        if (!server) {
          continue;
        }
        try {
          const result = await this.mcpService.pingServer(server);
          this.events.emit('mcp_server_status', {
            serverId: server.id,
            available: result.available,
            error: result.error ?? null,
            toolCount: Array.isArray(result.tools) ? result.tools.length : null
          });
        } catch (error: any) {
          const message = error?.message ?? String(error);
          this.logger.appendLine(`[MCPMonitor] Failed to ping ${server.name}: ${message}`);
          this.events.emit('mcp_server_status', {
            serverId: server.id,
            available: false,
            error: message
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
