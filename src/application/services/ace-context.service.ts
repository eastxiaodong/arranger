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
    private readonly recordRun: (event: AceRunEvent) => Promise<void> | void = async () => {}
  ) {
    this.defaultProjectRoot = workspaceRoot || os.homedir();
    this.storagePath = path.join(this.defaultProjectRoot, '.arranger', 'ace-data');
    this.ensureStorageDir();
  }

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(config.baseUrl && config.token);
  }

  getConfig(): AceSettings {
    const settings = this.globalConfigDb.getAceSettings();
    return {
      ...settings,
      projectRoot: this.defaultProjectRoot
    };
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
    if (!this.isConfigured()) {
      throw new Error('ACE is not configured. Please set base URL and token first.');
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
      const result = await manager.searchContext(config.projectRoot, query);
      await this.recordRun({
        runId,
        type: 'search',
        stage: 'end',
        query,
        status: 'succeeded',
        metadata: { projectRoot: config.projectRoot }
      });
      return result;
    } catch (error: any) {
      await this.recordRun({
        runId,
        type: 'search',
        stage: 'end',
        query,
        status: 'failed',
        message: error?.message ?? 'search failed',
        metadata: { projectRoot: config.projectRoot }
      });
      throw error;
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
      throw new Error('ACE is not configured.');
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
      await manager.testConnection();
      await this.recordRun({
        runId,
        type: 'test',
        stage: 'end',
        status: 'succeeded',
        metadata: { projectRoot: config.projectRoot }
      });
    } catch (error: any) {
      await this.recordRun({
        runId,
        type: 'test',
        stage: 'end',
        status: 'failed',
        message: error?.message ?? 'test failed',
        metadata: { projectRoot: config.projectRoot }
      });
      throw error;
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
}
