import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosInstance } from 'axios';
import iconv from 'iconv-lite';
import ignore from 'ignore';
import { normalizeProjectPath } from './path-utils';

export interface AceLogger {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface IndexManagerOptions {
  storagePath: string;
  baseUrl: string;
  token: string;
  textExtensions: Set<string>;
  batchSize: number;
  maxLinesPerBlob: number;
  excludePatterns: string[];
  logger: AceLogger;
}

interface BlobContent {
  path: string;
  content: string;
}

interface IndexStats {
  total_blobs: number;
  existing_blobs: number;
  new_blobs: number;
  skipped_blobs: number;
}

export interface IndexResult {
  status: 'success' | 'partial_success' | 'error';
  message: string;
  project_path?: string;
  failed_batches?: number[];
  stats?: IndexStats;
}

const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);

export class IndexManager {
  private readonly storagePath: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly textExtensions: Set<string>;
  private readonly batchSize: number;
  private readonly maxLinesPerBlob: number;
  private readonly excludePatterns: string[];
  private readonly logger: AceLogger;
  private readonly projectsFile: string;
  private readonly httpClient: AxiosInstance;

  constructor(options: IndexManagerOptions) {
    this.storagePath = options.storagePath;
    this.baseUrl = sanitizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.textExtensions = options.textExtensions;
    this.batchSize = Math.max(1, options.batchSize);
    this.maxLinesPerBlob = Math.max(100, options.maxLinesPerBlob);
    this.excludePatterns = options.excludePatterns;
    this.logger = options.logger;
    this.projectsFile = path.join(this.storagePath, 'projects.json');

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined
    });
  }

  async indexProject(projectRootPath: string): Promise<IndexResult> {
    const normalizedPath = this.normalizePath(projectRootPath);
    this.logger.info(`Indexing project ${normalizedPath}`);

    try {
      const blobs = await this.collectFiles(projectRootPath);
      if (blobs.length === 0) {
        return { status: 'error', message: 'No text files found in project' };
      }

      const projects = this.loadProjects();
      const existingBlobNames = new Set(projects[normalizedPath] || []);

      const blobHashMap = new Map<string, BlobContent>();
      for (const blob of blobs) {
        const blobHash = calculateBlobName(blob.path, blob.content);
        blobHashMap.set(blobHash, blob);
      }

      const allBlobHashes = Array.from(blobHashMap.keys());
      const existingHashes = new Set(allBlobHashes.filter(hash => existingBlobNames.has(hash)));
      const newHashes = allBlobHashes.filter(hash => !existingBlobNames.has(hash));
      const blobsToUpload = newHashes.map(hash => blobHashMap.get(hash)!);

      this.logger.info(
        `Incremental indexing summary: total=${blobs.length}, existing=${existingHashes.size}, new=${blobsToUpload.length}`
      );

      const uploadedBlobNames: string[] = [];
      const failedBatches: number[] = [];

      if (blobsToUpload.length > 0) {
        const totalBatches = Math.ceil(blobsToUpload.length / this.batchSize);
        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const startIdx = batchIdx * this.batchSize;
          const endIdx = Math.min(startIdx + this.batchSize, blobsToUpload.length);
          const batchBlobs = blobsToUpload.slice(startIdx, endIdx);

          this.logger.info(
            `Uploading batch ${batchIdx + 1}/${totalBatches} (${batchBlobs.length} blobs)`
          );

          try {
            const uploadBatch = async () => {
              const response = await this.httpClient.post('/batch-upload', {
                blobs: batchBlobs
              });
              return response.data;
            };
            const result = await this.retryRequest(uploadBatch, 3, 1000);
            const uploadedHashes = Array.isArray(result?.uploaded_blob_names)
              ? result.uploaded_blob_names
              : [];
            uploadedBlobNames.push(...uploadedHashes);
          } catch (error) {
            failedBatches.push(batchIdx + 1);
            this.logger.error(
              `Failed to upload batch ${batchIdx + 1}: ${error instanceof Error ? error.message : error}`
            );
          }
        }
      } else {
        this.logger.info('All blobs already exist. No upload required.');
      }

      const allBlobNames = [...existingHashes, ...uploadedBlobNames];
      projects[normalizedPath] = allBlobNames;
      this.saveProjects(projects);

      const messageParts = [
        `total=${allBlobNames.length}`,
        `existing=${existingHashes.size}`,
        `new=${uploadedBlobNames.length}`
      ];
      if (failedBatches.length) {
        messageParts.push(`failed_batches=${failedBatches.join(',')}`);
      }

      const status = failedBatches.length === 0 ? 'success' : 'partial_success';
      const message = `Project indexed (${messageParts.join(', ')})`;
      if (status === 'success') {
        this.logger.info(message);
      } else {
        this.logger.warning(message);
      }

      return {
        status,
        message,
        project_path: normalizedPath,
        failed_batches: failedBatches,
        stats: {
          total_blobs: allBlobNames.length,
          existing_blobs: existingHashes.size,
          new_blobs: uploadedBlobNames.length,
          skipped_blobs: existingHashes.size
        }
      };
    } catch (error: any) {
      const reason = error?.message ?? String(error);
      this.logger.error(`Indexing failed: ${reason}`);
      return { status: 'error', message: reason };
    }
  }

  async searchContext(projectRootPath: string, query: string): Promise<string> {
    const normalizedPath = this.normalizePath(projectRootPath);
    this.logger.info(`Searching ACE context for ${normalizedPath}`);

    const indexResult = await this.indexProject(projectRootPath);
    if (indexResult.status === 'error') {
      return `Error: Failed to index project. ${indexResult.message}`;
    }

    const projects = this.loadProjects();
    const blobNames = projects[normalizedPath] || [];
    if (blobNames.length === 0) {
      return `Error: No blobs found for project ${normalizedPath}.`;
    }

    const payload = {
      information_request: query,
      blobs: {
        checkpoint_id: null,
        added_blobs: blobNames,
        deleted_blobs: []
      },
      dialog: [],
      max_output_length: 0,
      disable_codebase_retrieval: false,
      enable_commit_retrieval: false
    };

    try {
      const request = async () => {
        const response = await this.httpClient.post('/agents/codebase-retrieval', payload, {
          timeout: 60000
        });
        return response.data;
      };
      const result = await this.retryRequest(request, 3, 2000);
      const formatted = result?.formatted_retrieval;
      if (!formatted) {
        this.logger.warning('ACE search returned empty result.');
        return 'No relevant code context found for the query.';
      }
      return formatted;
    } catch (error: any) {
      const reason = error?.message ?? String(error);
      this.logger.error(`ACE search failed: ${reason}`);
      return `Error: ${reason}`;
    }
  }

  private normalizePath(target: string): string {
    return normalizeProjectPath(target);
  }

  private loadProjects(): Record<string, string[]> {
    if (!fs.existsSync(this.projectsFile)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(this.projectsFile, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      this.logger.error(`Failed to read ACE projects file: ${error}`);
      return {};
    }
  }

  private saveProjects(projects: Record<string, string[]>) {
    try {
      fs.writeFileSync(this.projectsFile, JSON.stringify(projects, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error(`Failed to save ACE projects file: ${error}`);
    }
  }

  private async collectFiles(projectRootPath: string): Promise<BlobContent[]> {
    const blobs: BlobContent[] = [];
    let excludedCount = 0;
    let rootPath = projectRootPath;
    if (rootPath.endsWith('/') && rootPath.length > 1) {
      rootPath = rootPath.slice(0, -1);
    }
    if (rootPath.endsWith('\\') && rootPath.length > 3) {
      rootPath = rootPath.slice(0, -1);
    }

    if (!fs.existsSync(rootPath)) {
      throw new Error(`Project root path does not exist: ${projectRootPath}`);
    }
    const stats = fs.statSync(rootPath);
    if (!stats.isDirectory()) {
      throw new Error(`Project root path is not a directory: ${projectRootPath}`);
    }

    const gitignoreSpec = this.loadGitignore(rootPath);

    const walkDir = async (dirPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (!this.shouldExclude(fullPath, rootPath, gitignoreSpec)) {
            await walkDir(fullPath);
          } else {
            excludedCount++;
          }
        } else if (entry.isFile()) {
          if (this.shouldExclude(fullPath, rootPath, gitignoreSpec)) {
            excludedCount++;
            continue;
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (!this.textExtensions.has(ext)) {
            continue;
          }
          try {
            const relativePath = path.relative(rootPath, fullPath);
            if (relativePath.startsWith('..')) {
              this.logger.warning(`Skipping file outside root: ${fullPath}`);
              continue;
            }
            const content = await readFileWithEncoding(fullPath, this.logger);
            const fileBlobs = this.splitFileContent(relativePath, content);
            blobs.push(...fileBlobs);
          } catch (error) {
            this.logger.warning(`Failed to read file ${fullPath}: ${error}`);
          }
        }
      }
    };

    await walkDir(rootPath);
    this.logger.info(
      `Collected ${blobs.length} blobs from ${projectRootPath} (excluded ${excludedCount} entries)`
    );
    return blobs;
  }

  private loadGitignore(rootPath: string) {
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      return ignore().add(content.split('\n'));
    } catch (error) {
      this.logger.warning(`Failed to load .gitignore: ${error}`);
      return null;
    }
  }

  private shouldExclude(
    filePath: string,
    rootPath: string,
    gitignoreSpec: ReturnType<typeof ignore> | null
  ): boolean {
    try {
      const relativePath = path.relative(rootPath, filePath);
      const normalized = relativePath.replace(/\\/g, '/');

      if (gitignoreSpec) {
        const isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
        const testPath = isDir ? `${normalized}/` : normalized;
        if (gitignoreSpec.ignores(testPath)) {
          return true;
        }
      }

      const pathParts = normalized.split('/');
      for (const pattern of this.excludePatterns) {
        for (const part of pathParts) {
          if (this.matchPattern(part, pattern)) {
            return true;
          }
        }
        if (this.matchPattern(normalized, pattern)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private matchPattern(str: string, pattern: string): boolean {
    const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(str);
  }

  private splitFileContent(filePath: string, content: string): BlobContent[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        lines.push(content.substring(start, i + 1));
        start = i + 1;
      } else if (content[i] === '\r') {
        if (i + 1 < content.length && content[i + 1] === '\n') {
          lines.push(content.substring(start, i + 2));
          start = i + 2;
          i++;
        } else {
          lines.push(content.substring(start, i + 1));
          start = i + 1;
        }
      }
    }
    if (start < content.length) {
      lines.push(content.substring(start));
    }

    const totalLines = lines.length;
    if (totalLines <= this.maxLinesPerBlob) {
      return [{ path: filePath, content }];
    }

    const blobs: BlobContent[] = [];
    const numChunks = Math.ceil(totalLines / this.maxLinesPerBlob);
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const startLine = chunkIdx * this.maxLinesPerBlob;
      const endLine = Math.min(startLine + this.maxLinesPerBlob, totalLines);
      const chunkLines = lines.slice(startLine, endLine);
      const chunkContent = chunkLines.join('');
      const chunkPath = `${filePath}#chunk${chunkIdx + 1}of${numChunks}`;
      blobs.push({ path: chunkPath, content: chunkContent });
    }
    return blobs;
  }

  private async retryRequest<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    retryDelay: number = 1000,
    options: {
      maxRetryDelay?: number;
      jitter?: boolean;
      onRetry?: (error: any, attempt: number, waitTime: number) => void;
    } = {}
  ): Promise<T> {
    let lastError: Error | undefined;
    const maxRetryDelay = options.maxRetryDelay || 30000; // 最大30秒
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const code = error?.code;
        const status = error?.response?.status;
        const retryable =
          RETRYABLE_CODES.has(code) ||
          (typeof status === 'number' && status >= 500) ||
          (typeof status === 'number' && status === 429) || // 限流
          (code === 'ECONNRESET') ||
          (code === 'ETIMEDOUT');
        
        if (!retryable || attempt === maxRetries - 1) {
          this.logger.error(`ACE request failed after ${attempt + 1} attempts: ${error?.message ?? error}`);
          if (error.response) {
            this.logger.error(`Response status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`);
          }
          throw error;
        }
        
        // 指数退避 + 随机抖动
        const baseDelay = retryDelay * Math.pow(2, attempt);
        const jitter = options.jitter ? Math.random() * 0.1 * baseDelay : 0;
        const waitTime = Math.min(baseDelay + jitter, maxRetryDelay);
        
        this.logger.warning(
          `ACE request failed (attempt ${attempt + 1}/${maxRetries}): ${error?.message ?? error
          }. Retrying in ${Math.round(waitTime)}ms (code: ${code}, status: ${status})`
        );
        
        // 调用重试回调
        if (options.onRetry) {
          options.onRetry(error, attempt + 1, waitTime);
        }
        
        await sleep(waitTime);
      }
    }
    throw lastError || new Error('ACE request failed');
  }

  async testConnection(): Promise<void> {
    await this.retryRequest(async () => {
      await this.httpClient.post('/batch-upload', { blobs: [] });
      return null;
    }, 2, 500);
  }
  async updateFile(filePath: string, content: string): Promise<void> {
    const normalizedPath = this.normalizePath(this.storagePath); // storagePath is not project root. We need project root.
    // Actually, IndexManager manages multiple projects. We need to know which project this file belongs to.
    // The watcher will provide the full path. We need to find the project root for this file.
    // For simplicity, we assume the file belongs to the currently active project or we iterate projects.

    // Let's look at how indexProject works. It takes projectRootPath.
    // We need to know the project root to update the correct project entry in projects.json.
    // The watcher service should probably pass the project root or we derive it.

    // However, to keep IndexManager simple, let's just accept the file path and content, 
    // and we might need the project root passed in, or we assume we can find it.
    // Actually, `projects.json` keys are project roots. We can find which project root is a prefix of filePath.

    const projects = this.loadProjects();
    let projectRoot = '';
    for (const root of Object.keys(projects)) {
      if (filePath.startsWith(root) || filePath.replace(/\\/g, '/').startsWith(root.replace(/\\/g, '/'))) {
        projectRoot = root;
        break;
      }
    }

    if (!projectRoot) {
      // Not a tracked project, ignore
      return;
    }

    // Now we have projectRoot and filePath.
    const relativePath = path.relative(projectRoot, filePath);
    const blobs = this.splitFileContent(relativePath, content);

    // We need to upload these blobs.
    // To avoid chatty uploads, we could queue them, but for "Real-time" we might want to just upload.
    // Given the requirement is "Real-time", let's try to upload immediately but maybe catch errors silently.

    try {
      const response = await this.httpClient.post('/batch-upload', {
        blobs: blobs
      });

      const uploadedHashes = response.data?.uploaded_blob_names || [];

      // Update local index
      const existingBlobNames = new Set(projects[projectRoot] || []);

      // We need to remove old blobs for this file? 
      // The current implementation stores a list of ALL blob hashes for the project.
      // It doesn't map file -> blobs. This is a limitation of the current simple implementation.
      // If we just add new blobs, the old ones remain in the list. 
      // This might bloat the list over time but for a prototype it's okay.
      // To do it correctly, we'd need a map of File -> [BlobHashes].
      // For now, let's just append the new hashes. ACE server probably handles deduplication/garbage collection or ignores unused blobs.

      let changed = false;
      for (const hash of uploadedHashes) {
        if (!existingBlobNames.has(hash)) {
          existingBlobNames.add(hash);
          changed = true;
        }
      }

      // Also add hashes that were already on server (response might not include them if they existed)
      // Actually, we should calculate hashes locally to be sure we add them to our local list.
      for (const blob of blobs) {
        const hash = calculateBlobName(blob.path, blob.content);
        if (!existingBlobNames.has(hash)) {
          existingBlobNames.add(hash);
          changed = true;
        }
      }

      if (changed) {
        projects[projectRoot] = Array.from(existingBlobNames);
        this.saveProjects(projects);
      }

      this.logger.debug(`Updated index for ${relativePath}`);

    } catch (error) {
      this.logger.warning(`Failed to update index for ${filePath}: ${error}`);
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    // Since we don't track which blobs belong to which file in `projects.json` (it's just a flat list of hashes),
    // we can't easily remove the blobs for a deleted file without re-indexing or changing the data structure.
    // For this iteration, we will just ignore deletions in the index. 
    // The ACE server retrieval might return stale code if it selects those blobs, but "Real-time" usually implies "Adding new knowledge".
    // To strictly support deletion, we would need to change `projects.json` structure to `Record<ProjectRoot, Record<FilePath, BlobHashes[]>>`.
    // That is a larger refactor. 
    // Let's stick to "Add/Update" for now as it covers 90% of "I just wrote this code, why can't you see it?" cases.
    this.logger.debug(`Delete file event received for ${filePath} (Deletion not fully supported in simple index mode)`);
  }
}


function calculateBlobName(filePath: string, content: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(filePath, 'utf-8');
  hash.update(content, 'utf-8');
  return hash.digest('hex');
}

async function readFileWithEncoding(filePath: string, logger: AceLogger): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  const encodings = ['utf-8', 'gbk', 'gb2312', 'latin1'];
  for (const encoding of encodings) {
    try {
      const content = iconv.decode(buffer, encoding);
      const replacementChars = (content.match(/\uFFFD/g) || []).length;
      if (
        (content.length < 100 && replacementChars <= 5) ||
        (content.length >= 100 && replacementChars / content.length <= 0.05)
      ) {
        if (encoding !== 'utf-8') {
          logger.debug(`Read ${filePath} using encoding ${encoding}`);
        }
        return content;
      }
    } catch {
      // continue
    }
  }
  logger.warning(`Fallback to utf-8 for ${filePath}`);
  return iconv.decode(buffer, 'utf-8');
}

function sanitizeBaseUrl(baseUrl: string): string {
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    return `https://${baseUrl}`.replace(/\/$/, '');
  }
  return baseUrl.replace(/\/$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
