// Session 服务

import { DatabaseManager } from '../../core/database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { Session } from '../../core/types';

export class SessionService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

  // 获取所有会话
  getAllSessions(): Session[] {
    return this.db.getAllSessions();
  }

  // 获取单个会话
  getSession(id: string): Session | null {
    return this.db.getSession(id);
  }

  // 创建会话
  createSession(id: string, metadata?: Record<string, any> | null): Session {
    const session = this.db.createSession(id, metadata ?? null);
    this.broadcastSessions();
    return session;
  }

  // 获取或创建会话
  getOrCreateSession(id: string, metadata?: Record<string, any> | null): Session {
    const existing = this.db.getSession(id);
    if (existing) {
      if (metadata && Object.keys(metadata).length > 0) {
        return this.mergeMetadata(id, metadata) ?? existing;
      }
      return existing;
    }
    return this.createSession(id, metadata ?? null);
  }

  mergeMetadata(id: string, patch: Record<string, any> | null): Session | null {
    if (!patch || Object.keys(patch).length === 0) {
      return this.db.getSession(id);
    }
    const current = this.db.getSession(id);
    if (!current) {
      return null;
    }
    const nextMetadata = {
      ...(current.metadata || {}),
      ...patch
    };
    const updated = this.db.updateSessionMetadata(id, nextMetadata);
    if (updated) {
      this.broadcastSessions();
    }
    return updated;
  }

  deleteSession(id: string): void {
    this.db.deleteSessionCascade(id);
    this.broadcastSessions();
  }

  private broadcastSessions() {
    if (this.events) {
      this.events.emit('sessions_update', this.getAllSessions());
    }
  }
}
