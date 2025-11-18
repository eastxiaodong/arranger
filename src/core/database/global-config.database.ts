import * as fs from 'fs';
import * as path from 'path';
import { SqlJsDb } from './sql-js-db';
import type { Agent, AgentRole, AutomationPolicy, MCPServer, AceSettings, ManagerLLMConfig } from '../types';

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
    this.initializeTables();
    this.ensureAllColumns();
    this.createIndexes();
  }

  /**
   * 初始化所有表（只创建核心字段和主外键约束）
   */
  private initializeTables() {
    // Agents - Agent 配置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Automation Policies - 自动化策略表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // MCP Servers - MCP 服务器配置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        command TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ace_settings (
        id TEXT PRIMARY KEY,
        base_url TEXT,
        token TEXT,
        project_root TEXT,
        batch_size INTEGER NOT NULL DEFAULT 10,
        max_lines_per_blob INTEGER NOT NULL DEFAULT 800,
        exclude_patterns TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manager_llm_config (
        id TEXT PRIMARY KEY,
        provider TEXT,
        model TEXT,
        api_key TEXT,
        base_url TEXT,
        temperature REAL NOT NULL DEFAULT 0.4,
        max_output_tokens INTEGER NOT NULL DEFAULT 2048,
        system_prompt TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * 确保所有字段都存在（迁移逻辑）
   */
  private ensureAllColumns() {
    const ensureColumn = (tableName: string, columnName: string, sql: string) => {
      const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(col => col.name));

      if (!columnNames.has(columnName)) {
        try {
          this.db.exec(sql);
          console.log(`[GlobalConfig Migration] Added column ${tableName}.${columnName}`);
        } catch (error: any) {
          if (!error?.message?.includes('duplicate column')) {
            console.error(`[GlobalConfig Migration] Error adding column ${tableName}.${columnName}:`, error);
          }
        }
      }
    };

    // ==================== Agents 表字段 ====================
    ensureColumn('agents', 'role', 'ALTER TABLE agents ADD COLUMN role TEXT');
    ensureColumn('agents', 'roles', 'ALTER TABLE agents ADD COLUMN roles TEXT');
    ensureColumn('agents', 'is_enabled', 'ALTER TABLE agents ADD COLUMN is_enabled INTEGER DEFAULT 1');
    ensureColumn('agents', 'capabilities', 'ALTER TABLE agents ADD COLUMN capabilities TEXT');
    ensureColumn('agents', 'tool_permissions', 'ALTER TABLE agents ADD COLUMN tool_permissions TEXT');
    ensureColumn('agents', 'metrics', 'ALTER TABLE agents ADD COLUMN metrics TEXT');
    ensureColumn('agents', 'notes', 'ALTER TABLE agents ADD COLUMN notes TEXT');
    ensureColumn('agents', 'status_detail', 'ALTER TABLE agents ADD COLUMN status_detail TEXT');
    ensureColumn('agents', 'status_eta', 'ALTER TABLE agents ADD COLUMN status_eta INTEGER');
    ensureColumn('agents', 'active_task_id', 'ALTER TABLE agents ADD COLUMN active_task_id TEXT');
    ensureColumn('agents', 'status_updated_at', 'ALTER TABLE agents ADD COLUMN status_updated_at INTEGER');
    ensureColumn('agents', 'llm_provider', 'ALTER TABLE agents ADD COLUMN llm_provider TEXT');
    ensureColumn('agents', 'llm_model', 'ALTER TABLE agents ADD COLUMN llm_model TEXT');
    ensureColumn('agents', 'llm_api_key', 'ALTER TABLE agents ADD COLUMN llm_api_key TEXT');
    ensureColumn('agents', 'llm_base_url', 'ALTER TABLE agents ADD COLUMN llm_base_url TEXT');
    ensureColumn('agents', 'capability_tags', 'ALTER TABLE agents ADD COLUMN capability_tags TEXT');
    ensureColumn('agents', 'reasoning_tier', 'ALTER TABLE agents ADD COLUMN reasoning_tier REAL');
    ensureColumn('agents', 'cost_factor', 'ALTER TABLE agents ADD COLUMN cost_factor REAL');

    // ==================== Automation Policies 表字段 ====================
    ensureColumn('automation_policies', 'scope', 'ALTER TABLE automation_policies ADD COLUMN scope TEXT');
    ensureColumn('automation_policies', 'conditions', 'ALTER TABLE automation_policies ADD COLUMN conditions TEXT');
    ensureColumn('automation_policies', 'actions', 'ALTER TABLE automation_policies ADD COLUMN actions TEXT');
    ensureColumn('automation_policies', 'priority', 'ALTER TABLE automation_policies ADD COLUMN priority INTEGER');
    ensureColumn('automation_policies', 'enabled', 'ALTER TABLE automation_policies ADD COLUMN enabled INTEGER DEFAULT 1');

    // ==================== MCP Servers 表字段 ====================
    ensureColumn('mcp_servers', 'description', 'ALTER TABLE mcp_servers ADD COLUMN description TEXT');
    ensureColumn('mcp_servers', 'args', 'ALTER TABLE mcp_servers ADD COLUMN args TEXT');
    ensureColumn('mcp_servers', 'env', 'ALTER TABLE mcp_servers ADD COLUMN env TEXT');
    ensureColumn('mcp_servers', 'enabled', 'ALTER TABLE mcp_servers ADD COLUMN enabled INTEGER DEFAULT 1');
    ensureColumn('mcp_servers', 'is_default', 'ALTER TABLE mcp_servers ADD COLUMN is_default INTEGER DEFAULT 0');

    this.ensureAceSettingsRow();
    this.ensureManagerLLMConfigRow();
  }

  /**
   * 创建索引
   */
  private createIndexes() {
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);');
  }

  private ensureAceSettingsRow() {
    const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM ace_settings WHERE id = 'default'");
    const result = countStmt.get() as any;
    if (!result || Number(result.count) === 0) {
      const defaults = this.getDefaultAceSettings();
      this.db.prepare(`
        INSERT INTO ace_settings (
          id, base_url, token, project_root, batch_size, max_lines_per_blob, exclude_patterns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'default',
        defaults.baseUrl,
        defaults.token,
        defaults.projectRoot,
        defaults.batchSize,
        defaults.maxLinesPerBlob,
        JSON.stringify(defaults.excludePatterns)
      );
    }
  }

  private ensureManagerLLMConfigRow() {
    const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM manager_llm_config WHERE id = 'default'");
    const result = countStmt.get() as any;
    if (!result || Number(result.count) === 0) {
      const defaults = this.getDefaultManagerLLMConfig();
      this.db.prepare(`
        INSERT INTO manager_llm_config (id, provider, model, api_key, base_url, temperature, max_output_tokens, system_prompt, updated_at)
        VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        defaults.provider,
        defaults.model,
        defaults.api_key,
        defaults.base_url,
        defaults.temperature,
        defaults.max_output_tokens,
        defaults.system_prompt,
        defaults.updated_at
      );
    }
  }

  close() {
    this.db.close();
  }

  getAceSettings(): AceSettings {
    const row = this.db.prepare('SELECT * FROM ace_settings WHERE id = ?').get('default') as any;
    if (!row) {
      return this.getDefaultAceSettings();
    }
    return {
      baseUrl: row.base_url || '',
      token: row.token || '',
      projectRoot: row.project_root || '',
      batchSize: row.batch_size ?? 10,
      maxLinesPerBlob: row.max_lines_per_blob ?? 800,
      excludePatterns: row.exclude_patterns ? JSON.parse(row.exclude_patterns) : []
    };
  }

  updateAceSettings(updates: Partial<AceSettings>): AceSettings {
    const current = this.getAceSettings();
    const next: AceSettings = {
      baseUrl: updates.baseUrl ?? current.baseUrl,
      token: updates.token ?? current.token,
      projectRoot: updates.projectRoot ?? current.projectRoot,
      batchSize: updates.batchSize ?? current.batchSize,
      maxLinesPerBlob: updates.maxLinesPerBlob ?? current.maxLinesPerBlob,
      excludePatterns: updates.excludePatterns ?? current.excludePatterns
    };

    this.db.prepare(`
      INSERT INTO ace_settings (id, base_url, token, project_root, batch_size, max_lines_per_blob, exclude_patterns)
      VALUES ('default', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        token = excluded.token,
        project_root = excluded.project_root,
        batch_size = excluded.batch_size,
        max_lines_per_blob = excluded.max_lines_per_blob,
        exclude_patterns = excluded.exclude_patterns
    `).run(
      next.baseUrl,
      next.token,
      next.projectRoot,
      next.batchSize,
      next.maxLinesPerBlob,
      JSON.stringify(next.excludePatterns ?? [])
    );

    return next;
  }

  private getDefaultAceSettings(): AceSettings {
    return {
      baseUrl: '',
      token: '',
      projectRoot: '',
      batchSize: 10,
      maxLinesPerBlob: 800,
      excludePatterns: [
        '.venv',
        'venv',
        '.env',
        'env',
        'node_modules',
        '.git',
        '.svn',
        '.hg',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.tox',
        '.eggs',
        '*.egg-info',
        'dist',
        'build',
        '.idea',
        '.vscode',
        '.DS_Store',
        '*.pyc',
        '*.pyo',
        '*.pyd',
        '.coverage',
        'htmlcov',
        'target',
        'bin',
        'obj'
      ]
    };
  }

  getManagerLLMConfig(): ManagerLLMConfig {
    const row = this.db.prepare('SELECT * FROM manager_llm_config WHERE id = ?').get('default') as any;
    if (!row) {
      return this.getDefaultManagerLLMConfig();
    }
    return {
      provider: row.provider || 'claude',
      model: row.model || 'claude-3.5-sonnet',
      api_key: row.api_key || '',
      base_url: row.base_url || '',
      temperature: typeof row.temperature === 'number' ? row.temperature : 0.4,
      max_output_tokens: typeof row.max_output_tokens === 'number' ? row.max_output_tokens : 2048,
      system_prompt: row.system_prompt || '',
      updated_at: row.updated_at || Date.now()
    };
  }

  updateManagerLLMConfig(updates: Partial<ManagerLLMConfig>): ManagerLLMConfig {
    const current = this.getManagerLLMConfig();
    const next: ManagerLLMConfig = {
      provider: updates.provider ?? current.provider,
      model: updates.model ?? current.model,
      api_key: updates.api_key ?? current.api_key,
      base_url: updates.base_url ?? current.base_url,
      temperature: typeof updates.temperature === 'number' ? updates.temperature : current.temperature,
      max_output_tokens: typeof updates.max_output_tokens === 'number' ? updates.max_output_tokens : current.max_output_tokens,
      system_prompt: updates.system_prompt ?? current.system_prompt,
      updated_at: Date.now()
    };

    this.db.prepare(`
      INSERT INTO manager_llm_config (id, provider, model, api_key, base_url, temperature, max_output_tokens, system_prompt, updated_at)
      VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        api_key = excluded.api_key,
        base_url = excluded.base_url,
        temperature = excluded.temperature,
        max_output_tokens = excluded.max_output_tokens,
        system_prompt = excluded.system_prompt,
        updated_at = excluded.updated_at
    `).run(
      next.provider,
      next.model,
      next.api_key,
      next.base_url,
      next.temperature,
      next.max_output_tokens,
      next.system_prompt,
      next.updated_at
    );

    return next;
  }

  private getDefaultManagerLLMConfig(): ManagerLLMConfig {
    return {
      provider: 'claude',
      model: 'claude-3.5-sonnet',
      api_key: '',
      base_url: '',
      temperature: 0.4,
      max_output_tokens: 2048,
      system_prompt: 'You are the team manager coordinating multiple AI specialists. Focus on planning, delegating work, and summarizing results.',
      updated_at: Date.now()
    };
  }

  // Agents
  createAgent(agent: Omit<Agent, 'created_at'>): Agent {
    const now = Date.now();
    const primaryRole = agent.roles?.[0] || 'general';
    const stmt = this.db.prepare(`
      INSERT INTO agents (
        id, display_name, role, roles, status, is_enabled, capabilities, tool_permissions, metrics, notes,
        last_heartbeat_at, status_detail, status_eta, active_task_id, status_updated_at, created_at,
        llm_provider, llm_model, llm_api_key, llm_base_url, capability_tags, reasoning_tier, cost_factor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      agent.llm_base_url || null,
      agent.capability_tags ? JSON.stringify(agent.capability_tags) : JSON.stringify(agent.capabilities || []),
      agent.reasoning_tier ?? 5,
      agent.cost_factor ?? 1
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
      const rolesArr = updates.roles ?? [];
      const primaryRole = rolesArr[0] || 'general';
      fields.push('role = ?');
      values.push(primaryRole);
      fields.push('roles = ?');
      values.push(JSON.stringify(rolesArr));
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

    if (updates.capability_tags !== undefined) {
      fields.push('capability_tags = ?');
      values.push(JSON.stringify(updates.capability_tags));
    }

    if (updates.reasoning_tier !== undefined) {
      fields.push('reasoning_tier = ?');
      values.push(updates.reasoning_tier);
    }

    if (updates.cost_factor !== undefined) {
      fields.push('cost_factor = ?');
      values.push(updates.cost_factor);
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
      capability_tags: row.capability_tags ? JSON.parse(row.capability_tags) : capabilities,
      reasoning_tier: row.reasoning_tier !== undefined && row.reasoning_tier !== null ? Number(row.reasoning_tier) : 5,
      cost_factor: row.cost_factor !== undefined && row.cost_factor !== null ? Number(row.cost_factor) : 1,
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
}
