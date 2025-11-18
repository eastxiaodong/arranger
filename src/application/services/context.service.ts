import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs, Dirent } from 'fs';
import { MCPService } from '../../infrastructure/mcp';
import type { MCPServer } from '../../core/types';

const DEFAULT_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.arranger/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**'
];

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
const MAX_MATCHES_PER_FILE = 5;
const DEFAULT_MAX_FILES = 5000;

export interface ContextSearchMatch {
  file_path: string;
  line: number;
  line_text: string;
  preview: string;
  score: number;
}

export interface ContextSearchResult {
  query: string;
  matches: ContextSearchMatch[];
  stats: {
    scanned_files: number;
    scanned_bytes: number;
    took_ms: number;
    limit_hit: boolean;
  };
  source: 'local' | 'mcp';
  metadata?: Record<string, any>;
}

export interface ContextSearchOptions {
  query: string;
  include_globs?: string[];
  exclude_globs?: string[];
  case_sensitive?: boolean;
  max_results?: number;
  context_lines?: number;
  max_files?: number;
  use_mcp?: boolean;
  mcp_server?: string;
  fallback_on_failure?: boolean;
}

export class ContextService {
  constructor(
    private readonly outputChannel?: vscode.OutputChannel,
    private readonly mcpService?: MCPService
  ) {}

  async search(options: ContextSearchOptions): Promise<ContextSearchResult> {
    const query = (options.query || '').trim();
    if (!query) {
      throw new Error('query is required');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder is open');
    }

    const root = workspaceFolder.uri.fsPath;
    const fallbackOnFailure = options.fallback_on_failure !== false;

    if (options.use_mcp && this.mcpService) {
      const payload = {
        query,
        include_globs: options.include_globs,
        exclude_globs: options.exclude_globs,
        case_sensitive: options.case_sensitive ?? false,
        max_results: options.max_results,
        context_lines: options.context_lines,
        max_files: options.max_files
      };
      try {
        const remoteResponse = await this.mcpService.searchContext({
          serverName: options.mcp_server,
          payload
        });
        return this.normalizeRemoteResult(remoteResponse.payload, query, remoteResponse.server);
      } catch (error) {
        this.log(`[ContextService] MCP search failed: ${error instanceof Error ? error.message : error}`);
        if (!fallbackOnFailure) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        this.log('[ContextService] Falling back to local search');
      }
    }

    return this.runLocalSearch({
      include_globs: options.include_globs,
      exclude_globs: options.exclude_globs,
      max_results: options.max_results,
      context_lines: options.context_lines,
      case_sensitive: options.case_sensitive,
      max_files: options.max_files,
      root,
      query
    });
  }

  private matchesInclude(target: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => pattern.test(target));
  }

  private matchesExclude(target: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => pattern.test(target));
  }

  private log(message: string) {
    if (this.outputChannel) {
      this.outputChannel.appendLine(`[ContextService] ${message}`);
    }
  }

  private normalizeRemoteResult(result: any, query: string, server?: MCPServer): ContextSearchResult {
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid MCP search result');
    }
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const stats = result.stats && typeof result.stats === 'object'
      ? {
          scanned_files: Number(result.stats.scanned_files) || 0,
          scanned_bytes: Number(result.stats.scanned_bytes) || 0,
          took_ms: Number(result.stats.took_ms) || 0,
          limit_hit: Boolean(result.stats.limit_hit)
        }
      : { scanned_files: 0, scanned_bytes: 0, took_ms: 0, limit_hit: false };
    return {
      query,
      matches,
      stats,
      source: 'mcp',
      metadata: {
        server: server ? { id: server.id, name: server.name } : null,
        raw: result.metadata || null
      }
    };
  }

  private async runLocalSearch(params: {
    include_globs?: string[];
    exclude_globs?: string[];
    max_results?: number;
    context_lines?: number;
    case_sensitive?: boolean;
    max_files?: number;
    root: string;
    query: string;
  }): Promise<ContextSearchResult> {
    const includePatterns = (params.include_globs && params.include_globs.length > 0)
      ? params.include_globs
      : ['**/*'];
    const excludePatterns = [...DEFAULT_EXCLUDE_GLOBS, ...(params.exclude_globs ?? [])];
    const includeRegs = includePatterns.map(globToRegExp);
    const excludeRegs = excludePatterns.map(globToRegExp);

    const maxResults = clamp(params.max_results ?? 20, 1, 200);
    const contextLines = clamp(params.context_lines ?? 2, 0, 8);
    const caseSensitive = !!params.case_sensitive;
    const maxFiles = clamp(params.max_files ?? DEFAULT_MAX_FILES, 100, 20000);
    const needle = caseSensitive ? params.query : params.query.toLowerCase();

    const matches: ContextSearchMatch[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    const start = Date.now();

    const stack: string[] = [params.root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error) {
        this.log(`Failed to read directory ${current}: ${error instanceof Error ? error.message : error}`);
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const relativePath = path.relative(params.root, fullPath);
        if (!relativePath) {
          continue;
        }
        const relPosix = relativePath.split(path.sep).join('/');

        if (entry.isDirectory()) {
          if (this.matchesExclude(`${relPosix}/`, excludeRegs)) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }

        if (!this.matchesInclude(relPosix, includeRegs) || this.matchesExclude(relPosix, excludeRegs)) {
          continue;
        }

        scannedFiles++;
        if (scannedFiles > maxFiles) {
          break;
        }

        let fileContent: string | null = null;
        let fileSize = 0;
        try {
          const stat = await fs.stat(fullPath);
          fileSize = stat.size;
          if (stat.size > MAX_FILE_SIZE_BYTES) {
            continue;
          }
          fileContent = await fs.readFile(fullPath, 'utf8');
        } catch (error) {
          this.log(`Failed to read file ${fullPath}: ${error instanceof Error ? error.message : error}`);
          continue;
        }

        scannedBytes += fileSize;
        if (fileContent === null) {
          continue;
        }

        const lines = fileContent.split(/\r?\n/);
        let matchesInFile = 0;
        for (let i = 0; i < lines.length; i++) {
          const sourceLine = lines[i];
          const haystack = caseSensitive ? sourceLine : sourceLine.toLowerCase();
          if (!haystack.includes(needle)) {
            continue;
          }

          matchesInFile++;
          const snippetStart = Math.max(0, i - contextLines);
          const snippetEnd = Math.min(lines.length, i + contextLines + 1);
          const snippet = lines.slice(snippetStart, snippetEnd).join('\n');

          matches.push({
            file_path: relPosix,
            line: i + 1,
            line_text: sourceLine.trim(),
            preview: snippet,
            score: haystack.indexOf(needle)
          });

          if (matches.length >= maxResults) {
            break;
          }
          if (matchesInFile >= MAX_MATCHES_PER_FILE) {
            break;
          }
        }

        if (matches.length >= maxResults || scannedFiles >= maxFiles) {
          break;
        }
      }

      if (matches.length >= maxResults || scannedFiles >= maxFiles) {
        break;
      }
    }

    return {
      query: params.query,
      matches,
      stats: {
        scanned_files: scannedFiles,
        scanned_bytes: scannedBytes,
        took_ms: Date.now() - start,
        limit_hit: matches.length >= maxResults
      },
      source: 'local'
    };
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let regex = '';
  for (let i = 0; i < escaped.length; i++) {
    const char = escaped[i];
    if (char === '*') {
      const nextChar = escaped[i + 1];
      if (nextChar === '*') {
        regex += '.*';
        i++;
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '.';
    } else {
      regex += char;
    }
  }
  return new RegExp(`^${regex}$`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
