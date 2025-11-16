// Lock 服务 - 负责并发控制

import { DatabaseManager } from '../database';
import type { Lock } from '../types';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟

export class LockService {
  constructor(private db: DatabaseManager) {}

  /**
   * 获取指定 resource 的锁信息
   */
  getLock(resource: string): Lock | null {
    this.cleanupExpired();
    return this.db.getLock(resource);
  }

  /**
   * 获取锁列表
   */
  getLocks(filters?: { session_id?: string; holder_id?: string }): Lock[] {
    this.cleanupExpired();
    return this.db.getLocks(filters);
  }

  /**
   * 尝试获取锁，失败时返回 false
   */
  acquire(
    resource: string,
    holderId: string,
    sessionId: string,
    ttlMs: number = DEFAULT_TTL_MS
  ): boolean {
    this.cleanupExpired();
    try {
      this.db.createLock({
        resource,
        holder_id: holderId,
        session_id: sessionId,
        expires_at: Date.now() + ttlMs
      });
      return true;
    } catch (error: any) {
      const message = error?.message || '';
      if (message.includes('Resource already locked') || message.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 释放锁
   */
  release(resource: string): void {
    this.db.deleteLock(resource);
  }

  /**
   * 释放某个持有者的所有锁（Agent 停止时调用）
   */
  releaseByHolder(holderId: string): void {
    this.db.deleteAgentLocks(holderId);
  }

  releaseBySession(sessionId: string): void {
    this.db.deleteSessionLocks(sessionId);
  }

  /**
   * 清理过期锁
   */
  cleanupExpired(): void {
    this.db.deleteExpiredLocks();
  }

  /**
   * 在锁内执行函数，失败时抛出
   */
  async withLock<T>(
    resource: string,
    holderId: string,
    sessionId: string,
    callback: () => Promise<T> | T,
    ttlMs: number = DEFAULT_TTL_MS
  ): Promise<T> {
    const acquired = this.acquire(resource, holderId, sessionId, ttlMs);
    if (!acquired) {
      throw new Error(`lock-unavailable:${resource}`);
    }

    try {
      return await callback();
    } finally {
      this.release(resource);
    }
  }

  /**
   * 尝试执行函数，若锁被占用则返回 null
   */
  async tryWithLock<T>(
    resource: string,
    holderId: string,
    sessionId: string,
    callback: () => Promise<T> | T,
    ttlMs: number = DEFAULT_TTL_MS
  ): Promise<T | null> {
    const acquired = this.acquire(resource, holderId, sessionId, ttlMs);
    if (!acquired) {
      return null;
    }

    try {
      return await callback();
    } finally {
      this.release(resource);
    }
  }
}
