import { GlobalConfigDatabase } from '../database/global-config.database';
import { TypedEventEmitter } from '../events/emitter';
import type { MCPServer } from '../types';

export class MCPServerService {
  constructor(
    private readonly globalDb: GlobalConfigDatabase,
    private readonly events: TypedEventEmitter
  ) {}

  getAllServers(filters?: { enabled?: boolean }): MCPServer[] {
    return this.globalDb.getMcpServers(filters);
  }

  getServerById(id: number): MCPServer | null {
    return this.globalDb.getMcpServerById(id);
  }

  getServerByName(name: string): MCPServer | null {
    return this.globalDb.getMcpServerByName(name);
  }

  getDefaultServer(): MCPServer | null {
    const all = this.getAllServers();
    if (all.length === 0) {
      return null;
    }
    const enabledDefault = all.find(server => server.is_default && server.enabled);
    if (enabledDefault) {
      return enabledDefault;
    }
    const enabledFallback = all.find(server => server.enabled);
    if (enabledFallback) {
      return enabledFallback;
    }
    const anyDefault = all.find(server => server.is_default);
    return anyDefault ?? all[0];
  }

  createServer(server: Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>): MCPServer {
    const created = this.globalDb.createMcpServer(server);
    this.broadcast();
    return created;
  }

  updateServer(id: number, updates: Partial<Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>>): MCPServer | null {
    const updated = this.globalDb.updateMcpServer(id, updates);
    this.broadcast();
    return updated;
  }

  setServerEnabled(id: number, enabled: boolean): void {
    this.globalDb.setMcpServerEnabled(id, enabled);
    this.broadcast();
  }

  deleteServer(id: number): void {
    this.globalDb.deleteMcpServer(id);
    this.broadcast();
  }

  setDefaultServer(id: number): void {
    this.globalDb.setMcpDefault(id);
    this.broadcast();
  }

  refresh(): void {
    this.broadcast();
  }

  private broadcast() {
    const servers = this.globalDb.getMcpServers();
    this.events.emit('mcp_servers_update', servers);
  }
}
