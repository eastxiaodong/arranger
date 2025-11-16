import * as fs from 'fs';
import * as path from 'path';
import { SqlJsDb } from './sql-js-db';
import type { Agent, AgentRole, AutomationPolicy, MCPServer } from '../types';

export class GlobalConfigDatabase {
  private constructor(
    private readonly db: SqlJsDb
  ) {}

  static async create(dbPath: string): Promise<GlobalConfigDatabase> {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const sqlDb = await SqlJsDb.create(dbPath);
    const instance = new GlobalConfigDatabase(sqlDb);
    instance.initialize();
    return instance;
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        roles TEXT NOT NULL,
        status TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        capabilities TEXT NOT NULL,
        tool_permissions TEXT,
        metrics TEXT,
        notes TEXT,
        last_heartbeat_at INTEGER NOT NULL,
        status_detail TEXT,
        status_eta INTEGER,
        active_task_id TEXT,
        status_updated_at INTEGER,
        created_at INTEGER NOT NULL,
        llm_provider TEXT,
        llm_model TEXT,
        llm_api_key TEXT,
        llm_base_url TEXT
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);');
    try {
      this.db.exec('ALTER TABLE agents ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1');
    } catch (error: any) {
      if (!error?.message?.includes('duplicate column')) {
        console.error('[Migration] Failed to add agents.is_enabled:', error);
      }
    }
    try {
      this.db.exec('ALTER TABLE agents ADD COLUMN tool_permissions TEXT');
    } catch (error: any) {
      if (!error?.message?.includes('duplicate column')) {
        console.error('[Migration] Failed to add agents.tool_permissions:', error);
      }
    }
    try {
      this.db.exec('ALTER TABLE agents ADD COLUMN metrics TEXT');
    } catch (error: any) {
      if (!error?.message?.includes('duplicate column')) {
        console.error('[Migration] Failed to add agents.metrics:', error);
      }
    }
    try {
      this.db.exec('ALTER TABLE agents ADD COLUMN notes TEXT');
    } catch (error: any) {
      if (!error?.message?.includes('duplicate column')) {
        console.error('[Migration] Failed to add agents.notes:', error);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        conditions TEXT NOT NULL,
        actions TEXT NOT NULL,
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        env TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);');
    this.ensureDefaultMcpServers();
  }

  close() {
    this.db.close();
  }

  // Agents
  createAgent(agent: Omit<Agent, 'created_at'>): Agent {
    const now = Date.now();
    const primaryRole = agent.roles?.[0] || 'developer';
    const stmt = this.db.prepare(`
      INSERT INTO agents (
        id, display_name, role, roles, status, is_enabled, capabilities, tool_permissions, metrics, notes,
        last_heartbeat_at, status_detail, status_eta, active_task_id, status_updated_at, created_at,
        llm_provider, llm_model, llm_api_key, llm_base_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      agent.id,
      agent.display_name,
      primaryRole,
      JSON.stringify(agent.roles || [primaryRole]),
      agent.status,
      agent.is_enabled === false ? 0 : 1,
      JSON.stringify(agent.capabilities || []),
      agent.tool_permissions ? JSON.stringify(agent.tool_permissions) : null,
      agent.metrics ? JSON.stringify(agent.metrics) : null,
      agent.notes || null,
      agent.last_heartbeat_at,
      agent.status_detail || null,
      agent.status_eta || null,
      agent.active_task_id || null,
      agent.status_updated_at || null,
      now,
      agent.llm_provider || null,
      agent.llm_model || null,
      agent.llm_api_key || null,
      agent.llm_base_url || null
    );
    return { ...agent, created_at: now };
  }

  getAgent(id: string): Agent | null {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) {
      return null;
    }
    return this.mapAgentRow(row);
  }

  getAllAgents(): Agent[] {
    const stmt = this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapAgentRow(row));
  }

  updateAgent(id: string, updates: Partial<Agent>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.display_name !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.display_name);
    }

    if (updates.roles !== undefined) {
      const primaryRole = updates.roles[0] || 'developer';
      fields.push('role = ?');
      values.push(primaryRole);
      fields.push('roles = ?');
      values.push(JSON.stringify(updates.roles));
    }

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }

    if (updates.is_enabled !== undefined) {
      fields.push('is_enabled = ?');
      values.push(updates.is_enabled ? 1 : 0);
    }

    if (updates.capabilities !== undefined) {
      fields.push('capabilities = ?');
      values.push(JSON.stringify(updates.capabilities));
    }

    if (updates.tool_permissions !== undefined) {
      fields.push('tool_permissions = ?');
      values.push(updates.tool_permissions ? JSON.stringify(updates.tool_permissions) : null);
    }

    if (updates.metrics !== undefined) {
      fields.push('metrics = ?');
      values.push(updates.metrics ? JSON.stringify(updates.metrics) : null);
    }

    if (updates.notes !== undefined) {
      fields.push('notes = ?');
      values.push(updates.notes || null);
    }

    if (updates.last_heartbeat_at !== undefined) {
      fields.push('last_heartbeat_at = ?');
      values.push(updates.last_heartbeat_at);
    }

    if (updates.status_detail !== undefined) {
      fields.push('status_detail = ?');
      values.push(updates.status_detail);
    }

    if (updates.status_eta !== undefined) {
      fields.push('status_eta = ?');
      values.push(updates.status_eta);
    }

    if (updates.active_task_id !== undefined) {
      fields.push('active_task_id = ?');
      values.push(updates.active_task_id);
    }

    if (updates.status_updated_at !== undefined) {
      fields.push('status_updated_at = ?');
      values.push(updates.status_updated_at);
    }

    if (updates.llm_provider !== undefined) {
      fields.push('llm_provider = ?');
      values.push(updates.llm_provider);
    }

    if (updates.llm_model !== undefined) {
      fields.push('llm_model = ?');
      values.push(updates.llm_model);
    }

    if (updates.llm_api_key !== undefined) {
      fields.push('llm_api_key = ?');
      values.push(updates.llm_api_key);
    }

    if (updates.llm_base_url !== undefined) {
      fields.push('llm_base_url = ?');
      values.push(updates.llm_base_url);
    }

    if (fields.length === 0) {
      return;
    }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deleteAgent(id: string): void {
    const stmt = this.db.prepare('DELETE FROM agents WHERE id = ?');
    stmt.run(id);
  }

  private mapAgentRow(row: any): Agent {
    let roles: AgentRole[] = [];
    if (row.roles) {
      try {
        roles = JSON.parse(row.roles);
      } catch {
        roles = [];
      }
    }
    if ((!roles || roles.length === 0) && row.role) {
      roles = [row.role];
    }

    let capabilities: string[] = [];
    if (row.capabilities) {
      try {
        capabilities = JSON.parse(row.capabilities);
      } catch {
        capabilities = [];
      }
    }

    return {
      id: row.id,
      display_name: row.display_name,
      roles,
      status: row.status,
      is_enabled: row.is_enabled !== 0,
      capabilities,
      tool_permissions: row.tool_permissions ? JSON.parse(row.tool_permissions) : [],
      metrics: row.metrics ? JSON.parse(row.metrics) : null,
      notes: row.notes || null,
      last_heartbeat_at: row.last_heartbeat_at,
      status_detail: row.status_detail,
      status_eta: row.status_eta,
      active_task_id: row.active_task_id,
      status_updated_at: row.status_updated_at,
      created_at: row.created_at,
      llm_provider: row.llm_provider || undefined,
      llm_model: row.llm_model || undefined,
      llm_api_key: row.llm_api_key || undefined,
      llm_base_url: row.llm_base_url || undefined
    };
  }

  // Policies
  createPolicy(policy: Omit<AutomationPolicy, 'id' | 'created_at' | 'updated_at'>): AutomationPolicy {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO automation_policies (
        name, type, scope, conditions, actions, priority, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      policy.name,
      policy.type,
      policy.scope,
      JSON.stringify(policy.conditions),
      JSON.stringify(policy.actions),
      policy.priority,
      policy.enabled ? 1 : 0,
      now,
      now
    );
    return {
      id: Number(result.lastInsertRowid),
      ...policy,
      created_at: now,
      updated_at: now
    };
  }

  getPolicies(filters?: { type?: string; enabled?: boolean }): AutomationPolicy[] {
    let query = 'SELECT * FROM automation_policies WHERE 1=1';
    const params: any[] = [];
    if (filters?.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters?.enabled !== undefined) {
      query += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }
    query += ' ORDER BY priority DESC, created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      ...row,
      conditions: row.conditions ? JSON.parse(row.conditions) : {},
      actions: row.actions ? JSON.parse(row.actions) : {},
      enabled: row.enabled === 1
    }));
  }

  getPolicy(id: number): AutomationPolicy | null {
    const stmt = this.db.prepare('SELECT * FROM automation_policies WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) {
      return null;
    }
    return {
      ...row,
      conditions: row.conditions ? JSON.parse(row.conditions) : {},
      actions: row.actions ? JSON.parse(row.actions) : {},
      enabled: row.enabled === 1
    };
  }

  updatePolicy(id: number, updates: Partial<AutomationPolicy>): void {
    const fields: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }
    if (updates.scope !== undefined) {
      fields.push('scope = ?');
      values.push(updates.scope);
    }
    if (updates.conditions !== undefined) {
      fields.push('conditions = ?');
      values.push(JSON.stringify(updates.conditions));
    }
    if (updates.actions !== undefined) {
      fields.push('actions = ?');
      values.push(JSON.stringify(updates.actions));
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (fields.length === 1) {
      return;
    }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE automation_policies SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deletePolicy(id: number): void {
    const stmt = this.db.prepare('DELETE FROM automation_policies WHERE id = ?');
    stmt.run(id);
  }

  // MCP Servers
  getMcpServers(filters?: { enabled?: boolean }): MCPServer[] {
    let query = 'SELECT * FROM mcp_servers WHERE 1=1';
    const params: any[] = [];
    if (filters?.enabled !== undefined) {
      query += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }
    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.mapMcpServer(row));
  }

  getMcpServerById(id: number): MCPServer | null {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapMcpServer(row) : null;
  }

  getMcpServerByName(name: string): MCPServer | null {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers WHERE name = ?');
    const row = stmt.get(name) as any;
    return row ? this.mapMcpServer(row) : null;
  }

  createMcpServer(server: Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>): MCPServer {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO mcp_servers (name, description, command, args, env, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      server.name,
      server.description || null,
      server.command,
      JSON.stringify(server.args || []),
      server.env ? JSON.stringify(server.env) : null,
      server.enabled ? 1 : 0,
      server.is_default ? 1 : 0,
      now,
      now
    );
    const createdId = Number(result.lastInsertRowid);
    if (server.is_default) {
      this.setMcpDefault(createdId);
    }
    return this.getMcpServerById(createdId)!;
  }

  updateMcpServer(id: number, updates: Partial<Omit<MCPServer, 'id' | 'created_at' | 'updated_at'>>): MCPServer | null {
    const fields: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.command !== undefined) {
      fields.push('command = ?');
      values.push(updates.command);
    }
    if (updates.args !== undefined) {
      fields.push('args = ?');
      values.push(JSON.stringify(updates.args));
    }
    if (updates.env !== undefined) {
      fields.push('env = ?');
      values.push(updates.env ? JSON.stringify(updates.env) : null);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.is_default !== undefined) {
      fields.push('is_default = ?');
      values.push(updates.is_default ? 1 : 0);
    }

    if (fields.length === 1) {
      return this.getMcpServerById(id);
    }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    if (updates.is_default) {
      this.setMcpDefault(id);
    }

    return this.getMcpServerById(id);
  }

  deleteMcpServer(id: number): void {
    const stmt = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?');
    stmt.run(id);
  }

  setMcpServerEnabled(id: number, enabled: boolean): void {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?');
    stmt.run(enabled ? 1 : 0, now, id);
  }

  setMcpDefault(id: number): void {
    const now = Date.now();
    this.db.prepare('UPDATE mcp_servers SET is_default = 0').run();
    this.db.prepare('UPDATE mcp_servers SET is_default = 1, updated_at = ? WHERE id = ?').run(now, id);
  }

  private mapMcpServer(row: any): MCPServer {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      command: row.command,
      args: row.args ? JSON.parse(row.args) : [],
      env: row.env ? JSON.parse(row.env) : null,
      enabled: row.enabled === 1,
      is_default: row.is_default === 1,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private ensureDefaultMcpServers() {
    const defaults: Array<{ name: string; description: string; command: string; args: string[] }> = [
      {
        name: 'ace',
        description: 'ACE（系统预置）占位，后续版本将自动启用',
        command: 'ace-mcp',
        args: []
      },
      {
        name: 'thinking',
        description: 'thinking MCP 工具占位，供后续集成启用',
        command: 'thinking-mcp',
        args: []
      },
      {
        name: 'context7',
        description: 'context7 MCP 工具占位，供后续集成启用',
        command: 'context7-mcp',
        args: []
      }
    ];

    let serverCount = this.getMcpServerCount();
    for (const def of defaults) {
      const existing = this.getMcpServerByName(def.name);
      if (existing) {
        continue;
      }
      const shouldSetDefault = serverCount === 0;
      this.createMcpServer({
        name: def.name,
        description: def.description,
        command: def.command,
        args: def.args,
        env: null,
        enabled: false,
        is_default: shouldSetDefault
      });
      serverCount += 1;
    }
  }

  private getMcpServerCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM mcp_servers');
    const row = stmt.get() as { count: number };
    return typeof row?.count === 'number' ? Number(row.count) : 0;
  }
}
