import type { Agent, ExtensionConfig } from '../../core/types';

export function buildConfigFromAgent(agent: Agent): ExtensionConfig {
  if (!agent.llm_provider || !agent.llm_model) {
    throw new Error(`Agent ${agent.display_name || agent.id} 缺少 LLM 配置`);
  }

  if (!agent.llm_api_key) {
    throw new Error(`Agent ${agent.display_name || agent.id} 缺少 LLM API Key`);
  }

  return {
    backendUrl: '',
    llm: {
      provider: agent.llm_provider as ExtensionConfig['llm']['provider'],
      apiKey: agent.llm_api_key || '',
      model: agent.llm_model,
      baseURL: agent.llm_base_url || undefined
    },
    agent: {
      id: agent.id,
      roles: agent.capability_tags || agent.capabilities || [],
      displayName: agent.display_name || agent.id
    }
  };
}
