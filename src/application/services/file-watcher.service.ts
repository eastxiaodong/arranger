import * as vscode from 'vscode';
import { AceContextService } from './ace-context.service';

export class FileWatcherService {
    private watchers: vscode.FileSystemWatcher[] = [];
    private pendingUpdates = new Map<string, NodeJS.Timeout>();
    private readonly DEBOUNCE_MS = 500;

    constructor(
        private readonly aceContext: AceContextService,
        private readonly output: vscode.OutputChannel
    ) { }

    startWatching() {
        // Watch for changes in the workspace
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');

        watcher.onDidChange(uri => this.handleFileChange(uri));
        watcher.onDidCreate(uri => this.handleFileChange(uri));
        watcher.onDidDelete(uri => this.handleFileDelete(uri));

        this.watchers.push(watcher);
        this.output.appendLine('[FileWatcher] Started watching for file changes');
    }

    dispose() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
        this.pendingUpdates.forEach(timer => clearTimeout(timer));
        this.pendingUpdates.clear();
    }

    private handleFileChange(uri: vscode.Uri) {
        if (this.shouldIgnore(uri)) {
            return;
        }

        // Debounce updates
        const key = uri.fsPath;
        if (this.pendingUpdates.has(key)) {
            clearTimeout(this.pendingUpdates.get(key)!);
        }

        this.pendingUpdates.set(key, setTimeout(async () => {
            this.pendingUpdates.delete(key);
            try {
                // Read file content
                const document = await vscode.workspace.openTextDocument(uri);
                const content = document.getText();
                await this.aceContext.handleFileChange(uri.fsPath, content);
            } catch (error) {
                // File might be deleted or not readable, ignore
            }
        }, this.DEBOUNCE_MS));
    }

    private handleFileDelete(uri: vscode.Uri) {
        if (this.shouldIgnore(uri)) {
            return;
        }
        // Immediate delete (or debounced if needed, but delete is usually final)
        void this.aceContext.handleFileDelete(uri.fsPath);
    }

    private shouldIgnore(uri: vscode.Uri): boolean {
        // Ignore .git, node_modules, etc.
        // This is a basic check. Ideally we use .gitignore but that's heavy for a watcher.
        // We rely on IndexManager to do deeper checks, but we filter obvious noise here.
        const path = uri.fsPath;
        return path.includes('/.git/') ||
            path.includes('/node_modules/') ||
            path.includes('/dist/') ||
            path.includes('/out/') ||
            path.includes('/.arranger/');
    }
}
