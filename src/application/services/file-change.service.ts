import { DatabaseManager } from '../../core/database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { FileChange } from '../../core/types';

interface FileChangeFilters {
  session_id?: string;
  task_id?: string;
  agent_id?: string;
  file_path?: string;
}

export class FileChangeService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

  recordChange(change: Omit<FileChange, 'id' | 'created_at'>): FileChange {
    const created = this.db.createFileChange(change);
    this.emitUpdates(change.session_id);
    return created;
  }

  getFileChange(id: number): FileChange | null {
    return this.db.getFileChange(id);
  }

  getFileChanges(filters?: FileChangeFilters): FileChange[] {
    return this.db.getFileChanges(filters);
  }

  getTaskFileChanges(taskId: string): FileChange[] {
    return this.db.getFileChanges({ task_id: taskId });
  }

  deleteFileChange(id: number): void {
    const change = this.db.getFileChange(id);
    if (!change) {
      return;
    }
    this.db.deleteFileChange(id);
    this.emitUpdates(change.session_id);
  }

  private emitUpdates(sessionId?: string) {
    if (sessionId) {
      const changes = this.db.getFileChanges({ session_id: sessionId });
      this.events.emit('file_changes_update', changes);
    } else {
      this.events.emit('file_changes_update', this.db.getFileChanges({}));
    }
  }
}
