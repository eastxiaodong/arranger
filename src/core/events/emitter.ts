import { EventEmitter } from 'events';
import type { EventMap } from './events.types';

/** 默认的最大监听器数量，防止潜在的内存泄漏。 */
const DEFAULT_MAX_LISTENERS = 50;

// 类型安全的事件发射器
export class TypedEventEmitter {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(DEFAULT_MAX_LISTENERS);
  }

  // 发射事件
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  // 监听事件
  on<K extends keyof EventMap>(event: K, listener: (payload: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  // 监听一次
  once<K extends keyof EventMap>(event: K, listener: (payload: EventMap[K]) => void): void {
    this.emitter.once(event, listener);
  }

  // 移除监听器
  off<K extends keyof EventMap>(event: K, listener: (payload: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  // 移除所有监听器
  removeAllListeners(event?: keyof EventMap): void {
    this.emitter.removeAllListeners(event);
  }
}
