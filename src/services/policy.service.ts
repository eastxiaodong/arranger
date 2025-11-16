// Policy 服务

import { GlobalConfigDatabase } from '../database/global-config.database';
import { TypedEventEmitter } from '../events/emitter';
import type { AutomationPolicy } from '../types';

export class PolicyService {
  constructor(
    private globalDb: GlobalConfigDatabase,
    private events: TypedEventEmitter
  ) {}

  // 获取所有策略
  getAllPolicies(filters?: { type?: string; enabled?: boolean }): AutomationPolicy[] {
    return this.globalDb.getPolicies(filters);
  }

  // 获取单个策略
  getPolicy(id: number): AutomationPolicy | null {
    return this.globalDb.getPolicy(id);
  }

  // 创建策略
  createPolicy(policy: Omit<AutomationPolicy, 'id' | 'created_at' | 'updated_at'>): AutomationPolicy {
    const created = this.globalDb.createPolicy(policy);
    this.events.emit('policies_update', this.globalDb.getPolicies({}));
    return created;
  }

  // 更新策略
  updatePolicy(id: number, updates: Partial<AutomationPolicy>): void {
    this.globalDb.updatePolicy(id, updates);
    this.events.emit('policies_update', this.globalDb.getPolicies({}));
  }

  // 删除策略
  deletePolicy(id: number): void {
    this.globalDb.deletePolicy(id);
    this.events.emit('policies_update', this.globalDb.getPolicies({}));
  }

  // 启用策略
  enablePolicy(id: number): void {
    this.globalDb.updatePolicy(id, { enabled: true });
    this.events.emit('policies_update', this.globalDb.getPolicies({}));
  }

  // 禁用策略
  disablePolicy(id: number): void {
    this.globalDb.updatePolicy(id, { enabled: false });
    this.events.emit('policies_update', this.globalDb.getPolicies({}));
  }
}
