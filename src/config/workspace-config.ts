import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceConfig {
  workflowTemplateId: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  workflowTemplateId: 'universal_flow_v1'
};

export class WorkspaceConfigManager {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.configDir = path.join(workspaceRoot, '.arranger');
    this.configPath = path.join(this.configDir, 'workflow-config.json');
    this.ensureDir();
  }

  read(): WorkspaceConfig {
    try {
      if (!fs.existsSync(this.configPath)) {
        return { ...DEFAULT_CONFIG };
      }
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WorkspaceConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...parsed
      };
    } catch (error) {
      console.warn('[WorkspaceConfig] Failed to read config, fallback to defaults:', error);
      return { ...DEFAULT_CONFIG };
    }
  }

  update(partial: Partial<WorkspaceConfig>): WorkspaceConfig {
    const current = this.read();
    const next = {
      ...current,
      ...partial
    };
    this.write(next);
    return next;
  }

  private ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  private write(config: WorkspaceConfig) {
    try {
      this.ensureDir();
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      console.error('[WorkspaceConfig] Failed to persist config:', error);
    }
  }
}
