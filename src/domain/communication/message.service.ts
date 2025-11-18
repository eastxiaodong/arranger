// Message 服务 (Blackboard)

import { DatabaseManager } from '../../core/database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { BlackboardEntry } from '../../core/types';
import { extractMentionsFromContent } from '../../utils/mentions';

type SendMessageInput = Omit<BlackboardEntry, 'created_at' | 'category' | 'visibility' | 'payload'> & {
  category?: BlackboardEntry['category'];
  visibility?: BlackboardEntry['visibility'];
  payload?: Record<string, any> | null;
};

export class MessageService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter
  ) {}

  // 获取所有消息
  getAllMessages(filters?: { session_id?: string; agent_id?: string }): BlackboardEntry[] {
    return this.db.getBlackboardEntries(filters);
  }

  // 获取单个消息
  getMessage(id: string): BlackboardEntry | null {
    return this.db.getBlackboardEntry(id);
  }

  // 发送消息
  sendMessage(message: SendMessageInput): BlackboardEntry {
    const mentions = message.mentions && message.mentions.length > 0
      ? Array.from(new Set(message.mentions))
      : extractMentionsFromContent(message.content);
    const category = message.category ?? this.resolveCategory(message);
    const visibility = message.visibility ?? this.resolveVisibility(message, category);
    const created = this.db.createBlackboardEntry({
      ...message,
      category,
      visibility,
      mentions: mentions.length > 0 ? mentions : null,
      reference_type: message.reference_type || null,
      reference_id: message.reference_type ? message.reference_id : null,
      payload: message.payload ?? null
    });
    this.events.emit('messages_update', this.db.getBlackboardEntries({}));
    this.events.emit('message_posted', created);
    return created;
  }

  // 回复消息
  replyToMessage(messageId: string, content: string, senderId: string, sessionId: string): BlackboardEntry {
    return this.sendMessage({
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      session_id: sessionId,
      agent_id: senderId,
      content,
      priority: 'medium',
      tags: null,
      reply_to: messageId,
      references: null,
      reference_type: null,
      reference_id: null,
      mentions: null,
      expires_at: null,
      category: senderId === 'user' ? 'user' : 'agent_summary',
      visibility: 'blackboard',
      payload: null
    });
  }

  updateMessage(
    messageId: string,
    updates: Partial<Pick<BlackboardEntry, 'content' | 'priority' | 'tags' | 'references' | 'reference_type' | 'reference_id' | 'payload'>>
  ): BlackboardEntry | null {
    const updated = this.db.updateBlackboardEntry(messageId, updates);
    if (updated) {
      this.events.emit('messages_update', this.db.getBlackboardEntries({}));
    }
    return updated;
  }

  // 删除过期消息
  deleteExpiredMessages(): void {
    const now = Date.now();
    const allMessages = this.db.getBlackboardEntries({});
    const expiredIds = allMessages
      .filter(msg => msg.expires_at && msg.expires_at < now)
      .map(msg => msg.id);
    
    expiredIds.forEach(id => this.db.deleteBlackboardEntry(id));
    
    if (expiredIds.length > 0) {
      this.events.emit('messages_update', this.db.getBlackboardEntries({}));
    }
  }

  private resolveCategory(message: SendMessageInput): BlackboardEntry['category'] {
    const agentId = (message.agent_id || '').toLowerCase();
    if (agentId === 'user' || agentId.startsWith('human')) {
      return 'user';
    }
    if (agentId === 'manager_llm' || agentId === 'workflow_orchestrator' || message.category === 'system_event') {
      return 'system_event';
    }
    return 'agent_summary';
  }

  private resolveVisibility(
    message: SendMessageInput,
    category: BlackboardEntry['category']
  ): BlackboardEntry['visibility'] {
    if (category === 'system_event') {
      return 'event_log';
    }
    return 'blackboard';
  }
}
