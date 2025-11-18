/**
 * LLM 客户端工厂
 */

import { BaseLLMClient, LLMConfig } from './base';
import { ClaudeLLMClient } from './claude';
import { OpenAILLMClient } from './openai';
import { getPreset } from './presets';

export type LLMProvider = 'claude' | 'openai' | 'glm' | 'gemini' | 'custom';

export interface LLMFactoryConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * 创建 LLM 客户端
 */
export function createLLMClient(config: LLMFactoryConfig): BaseLLMClient {
  // 获取预设配置
  const preset = getPreset(config.provider);
  
  // 构建 LLM 配置
  const llmConfig: LLMConfig = {
    apiKey: config.apiKey,
    model: config.model || preset?.defaultModel || '',
    baseURL: config.baseURL ?? (preset?.baseURL ?? undefined),
    maxTokens: config.maxTokens,
    temperature: config.temperature
  };

  // 根据 provider 创建对应的客户端
  switch (config.provider) {
    case 'claude':
      return new ClaudeLLMClient(llmConfig);
    
    case 'openai':
    case 'glm':
    case 'gemini':
    case 'custom':
      return new OpenAILLMClient(llmConfig);
    
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}
