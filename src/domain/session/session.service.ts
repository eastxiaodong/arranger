import { DatabaseManager } from '../../core/database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { Session as SessionRecord } from '../../core/types';

export class SessionService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

  getAllSessions(): SessionRecord[] {
    return this.db.getAllSessions();
  }

  getSession(id: string): SessionRecord | null {
    return this.db.getSession(id);
  }

  createSession(id: string): SessionRecord {
    const session = this.db.createSession(id);
    this.broadcastSessions();
    return session;
  }

  getOrCreateSession(id: string): SessionRecord {
    const existing = this.db.getSession(id);
    if (existing) {
      return existing;
    }
    return this.createSession(id);
  }

  deleteSession(id: string): void {
    this.db.deleteSessionCascade(id);
    this.broadcastSessions();
  }

  private broadcastSessions() {
    this.events.emit('sessions_update', this.getAllSessions());
  }

  // 兼容接口：记录消息
  addMessage(message: any): void {
    if (!message?.session_id) {
      return;
    }
    if (!this.db.getSession(message.session_id)) {
      this.createSession(message.session_id);
    }
  }

  // 兼容接口：获取会话消息（简单回传 DB 黑板消息）
  getMessages(sessionId: string): any[] {
    return this.db.getBlackboardEntries({ session_id: sessionId });
  }
}
