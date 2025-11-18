// Notification 服务

import { DatabaseManager } from '../../core/database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { Notification, NotificationLevel } from '../../core/types';

export class NotificationService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

  // 获取所有通知
  getAllNotifications(filters?: { session_id?: string; read?: boolean }): Notification[] {
    return this.db.getNotifications(filters);
  }

  // 获取单个通知
  getNotification(id: number): Notification | null {
    return this.db.getNotification(id);
  }

  // 发送通知
  sendNotification(notification: Omit<Notification, 'id' | 'created_at' | 'read'>): Notification {
    const created = this.db.createNotification({
      ...notification,
      metadata: notification.metadata ?? null,
      read: false
    });
    this.events.emit('notifications_update', this.db.getNotifications({}));
    return created;
  }

  // 标记为已读
  markAsRead(id: number): void {
    this.db.updateNotification(id, { read: true });
    this.events.emit('notifications_update', this.db.getNotifications({}));
  }

  // 标记所有为已读
  markAllAsRead(sessionId: string): void {
    const notifications = this.db.getNotifications({ session_id: sessionId, read: false });
    notifications.forEach(n => {
      this.db.updateNotification(n.id, { read: true });
    });
    if (notifications.length > 0) {
      this.events.emit('notifications_update', this.db.getNotifications({ session_id: sessionId }));
    }
  }

  // 删除通知
  deleteNotification(id: number): void {
    this.db.deleteNotification(id);
    this.events.emit('notifications_update', this.db.getNotifications({}));
  }
}
