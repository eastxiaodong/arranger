import { GlobalConfigDatabase } from '../../core/database/global-config.database';
import { TypedEventEmitter } from '../../core/events/emitter';
import type { ManagerLLMConfig } from '../../core/types';

export class ManagerLLMService {
  constructor(
    private readonly globalDb: GlobalConfigDatabase,
    private readonly events: TypedEventEmitter
  ) {}

  getConfig(): ManagerLLMConfig {
    return this.globalDb.getManagerLLMConfig();
  }

  updateConfig(updates: Partial<ManagerLLMConfig>): ManagerLLMConfig {
    const updated = this.globalDb.updateManagerLLMConfig(updates);
    this.events.emit('manager_llm_config_updated', updated);
    return updated;
  }
}
