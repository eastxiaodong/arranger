import type { Agent, AgentRole, ExtensionConfig } from '../types';

export function buildConfigFromAgent(agent: Agent): ExtensionConfig {
  if (!agent.llm_provider || !agent.llm_model) {
    throw new Error(`Agent ${agent.display_name || agent.id} 缺少 LLM 配置`);
  }

  if (!agent.llm_api_key) {
    throw new Error(`Agent ${agent.display_name || agent.id} 缺少 LLM API Key`);
  }

  const roles = (agent.roles && agent.roles.length > 0 ? agent.roles : ['developer' as AgentRole]);

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
      roles,
      displayName: agent.display_name || agent.id
    }
  };
}
