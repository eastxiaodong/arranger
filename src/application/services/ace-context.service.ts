import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GlobalConfigDatabase } from '../../core/database/global-config.database';
import type { AceSettings } from '../../core/types';
import { IndexManager } from '../../infrastructure/ace/index-manager';

const DEFAULT_TEXT_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.java',
  '.go',
  '.rs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.sh',
  '.bash'
]);

interface AceRunEvent {
  runId: string;
  type: 'index' | 'search' | 'test';
  stage: 'start' | 'end';
  status: 'running' | 'succeeded' | 'failed';
  query?: string;
  message?: string;
  metadata?: Record<string, any>;
}

export class AceContextService {
  private indexManager: IndexManager | null = null;
  private readonly storagePath: string;
  private readonly defaultProjectRoot: string;

  constructor(
    private readonly globalConfigDb: GlobalConfigDatabase,
    workspaceRoot: string | undefined,
    private readonly output: vscode.OutputChannel,
    private readonly recordRun: (event: AceRunEvent) => Promise<void> | void = async () => { }
  ) {
    this.defaultProjectRoot = workspaceRoot || os.homedir();
    this.storagePath = path.join(this.defaultProjectRoot, '.arranger', 'ace-data');
    this.ensureStorageDir();
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    const hasBaseUrl = Boolean(config.baseUrl && config.baseUrl.trim().length > 0);
    const hasToken = Boolean(config.token && config.token.trim().length > 0);
    return hasBaseUrl && hasToken;
  }

  getConfig(): AceSettings {
    const settings = this.globalConfigDb.getAceSettings();
    
    // 提供默认配置值
    const config: AceSettings = {
      baseUrl: settings.baseUrl || '',
      token: settings.token || '',
      projectRoot: this.defaultProjectRoot,
      batchSize: settings.batchSize || 10,
      maxLinesPerBlob: settings.maxLinesPerBlob || 800,
      excludePatterns: settings.excludePatterns || [
        'node_modules', '.git', '.svn', 'dist', 'build', 'target', 'out',
        '.DS_Store', 'Thumbs.db', '*.pyc', '*.pyo', '*.so', '*.dll'
      ]
    };
    
    return config;
  }

  updateConfig(partial: Partial<AceSettings>): AceSettings {
    const normalized: Partial<AceSettings> = {
      ...partial,
      projectRoot: this.defaultProjectRoot
    };
    const updated = this.globalConfigDb.updateAceSettings(normalized);
    this.indexManager = null;
    return {
      ...updated,
      projectRoot: this.defaultProjectRoot
    };
  }

  async search(query: string): Promise<string> {
    if (!query || query.trim().length === 0) {
      throw new Error('Search query cannot be empty');
    }
    
    if (!this.isConfigured()) {
      throw new Error('ACE is not configured. Please set base URL and token first.\n' +
        'Configuration steps:\n' +
        '1. Open VSCode Settings\n' +
        '2. Search for "Arranger"\n' +
        '3. Configure ACE settings:\n' +
        '   - Base URL: Your ACE server endpoint\n' +
        '   - Token: Your access token\n' +
        '   - Batch Size: 10 (recommended)\n' +
        '   - Max Lines Per Blob: 800 (recommended)');
    }
    
    const config = this.getConfig();
    const manager = this.ensureIndexManager(config);
    const runId = this.generateRunId('search');
    
    await this.recordRun({
      runId,
      type: 'search',
      stage: 'start',
      status: 'running',
      query,
      metadata: { projectRoot: config.projectRoot }
    });
    
    try {
      this.output.appendLine(`[ACE] Starting search: "${query}" in ${config.projectRoot}`);
      const result = await manager.searchContext(config.projectRoot, query);
      
      await this.recordRun({
        runId,
        type: 'search',
        stage: 'end',
        query,
        status: 'succeeded',
        metadata: { projectRoot: config.projectRoot }
      });
      
      this.output.appendLine(`[ACE] Search completed successfully`);
      return result;
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error occurred';
      this.output.appendLine(`[ACE][error] Search failed: ${errorMessage}`);
      
      await this.recordRun({
        runId,
        type: 'search',
        stage: 'end',
        query,
        status: 'failed',
        message: errorMessage,
        metadata: { projectRoot: config.projectRoot }
      });
      
      // 提供更友好的错误信息
      if (errorMessage.includes('ECONNREFUSED')) {
        throw new Error('ACE server connection refused. Please check:\n' +
          '1. Server is running and accessible\n' +
          '2. Base URL is correct\n' +
          '3. Network connectivity is working\n' +
          '4. Firewall is not blocking the connection');
      } else if (errorMessage.includes('ETIMEDOUT')) {
        throw new Error('ACE server connection timeout. Please check:\n' +
          '1. Server response time\n' +
          '2. Network latency\n' +
          '3. Server load');
      } else if (errorMessage.includes('ENOTFOUND')) {
        throw new Error('ACE server not found. Please verify the base URL is correct and the server is accessible.');
      } else {
        throw new Error(`ACE search failed: ${errorMessage}`);
      }
    }
  }

  async refreshIndex(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('ACE is not configured.');
    }
    const config = this.getConfig();
    const manager = this.ensureIndexManager(config);
    const runId = this.generateRunId('index');
    await this.recordRun({
      runId,
      type: 'index',
      stage: 'start',
      status: 'running',
      metadata: { projectRoot: config.projectRoot }
    });
    try {
      const result = await manager.indexProject(config.projectRoot);
      await this.recordRun({
        runId,
        type: 'index',
        stage: 'end',
        status: result.status === 'success' ? 'succeeded' : 'failed',
        message: result.message,
        metadata: { projectRoot: config.projectRoot, stats: result.stats }
      });
      if (result.status === 'error') {
        throw new Error(result.message);
      }
    } catch (error: any) {
      await this.recordRun({
        runId,
        type: 'index',
        stage: 'end',
        status: 'failed',
        message: error?.message ?? 'index failed',
        metadata: { projectRoot: config.projectRoot }
      });
      throw error;
    }
  }

  async testConnection(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('ACE is not configured. Please configure base URL and token first.');
    }
    
    const config = this.getConfig();
    const manager = this.ensureIndexManager(config);
    const runId = this.generateRunId('test');
    
    await this.recordRun({
      runId,
      type: 'test',
      stage: 'start',
      status: 'running',
      metadata: { projectRoot: config.projectRoot }
    });
    
    try {
      this.output.appendLine(`[ACE] Testing connection to ${config.baseUrl}`);
      await manager.testConnection();
      
      await this.recordRun({
        runId,
        type: 'test',
        stage: 'end',
        status: 'succeeded',
        metadata: { projectRoot: config.projectRoot }
      });
      
      this.output.appendLine(`[ACE] Connection test successful`);
    } catch (error: any) {
      const errorMessage = error?.message || 'Connection test failed';
      this.output.appendLine(`[ACE][error] Connection test failed: ${errorMessage}`);
      
      await this.recordRun({
        runId,
        type: 'test',
        stage: 'end',
        status: 'failed',
        message: errorMessage,
        metadata: { projectRoot: config.projectRoot }
      });
      
      throw new Error(`ACE connection test failed: ${errorMessage}\n` +
        'Please check:\n' +
        '1. Base URL is correct: ' + config.baseUrl + '\n' +
        '2. Token is valid\n' +
        '3. Server is accessible\n' +
        '4. Network connectivity is working');
    }
  }

  getDefaultProjectRoot(): string {
    return this.defaultProjectRoot;
  }

  private ensureIndexManager(config: AceSettings): IndexManager {
    if (this.indexManager) {
      return this.indexManager;
    }
    this.indexManager = new IndexManager({
      storagePath: this.storagePath,
      baseUrl: config.baseUrl,
      token: config.token,
      textExtensions: DEFAULT_TEXT_EXTENSIONS,
      batchSize: config.batchSize,
      maxLinesPerBlob: config.maxLinesPerBlob,
      excludePatterns: config.excludePatterns,
      logger: this.createLogger()
    });
    return this.indexManager;
  }

  private createLogger() {
    return {
      info: (message: string) => this.output.appendLine(`[ACE] ${message}`),
      warning: (message: string) => this.output.appendLine(`[ACE][warn] ${message}`),
      error: (message: string) => this.output.appendLine(`[ACE][error] ${message}`),
      debug: (message: string) => this.output.appendLine(`[ACE][debug] ${message}`)
    };
  }

  private ensureStorageDir() {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }
  private generateRunId(type: string) {
    return `ace_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }
  async handleFileChange(filePath: string, content: string): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }
    const config = this.getConfig();
    const manager = this.ensureIndexManager(config);
    await manager.updateFile(filePath, content);
  }

  async handleFileDelete(filePath: string): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }
    const config = this.getConfig();
    const manager = this.ensureIndexManager(config);
    await manager.deleteFile(filePath);
  }
}
