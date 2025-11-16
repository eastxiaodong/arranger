/**
 * LLM 预设配置
 */

export interface LLMPreset {
  id: string;
  name: string;
  provider: 'claude' | 'openai' | 'glm' | 'gemini' | 'custom';
  baseURL?: string | null;
  defaultModel: string;
  models: string[];
  requiresApiKey: boolean;
  description: string;
}

export const LLM_PRESETS: Record<string, LLMPreset> = {
  claude: {
    id: 'claude',
    name: 'Claude (Anthropic)',
    provider: 'claude',
    defaultModel: 'claude-4.5-sonnet',
    models: [
      'claude-4.5-sonnet',
      'claude-4.5-haiku',
      'claude-3.5-sonnet',
      'claude-3.5-haiku',
      'claude-3-opus'
    ],
    requiresApiKey: true,
    description: '强大的推理能力，原生支持工具调用',
    baseURL: 'https://api.anthropic.com'
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
    models: [
      'gpt-5',
      'gpt-5-codex',
      'gpt-4o',
      'gpt-4-turbo'
    ],
    requiresApiKey: true,
    description: '广泛使用，Function Calling 成熟'
  },

  glm: {
    id: 'glm',
    name: 'GLM (智谱AI)',
    provider: 'glm',
    baseURL: ' https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModel: 'glm-4.6',
    models: [
      'glm-4.6',
      'glm-4-Long',
      'glm-4-Air'
    ],
    requiresApiKey: true,
    description: '国产大模型，支持中文，兼容 OpenAI 格式'
  },

  gemini: {
    id: 'gemini',
    name: 'Gemini (Google)',
    provider: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-pro',
    models: [
      'gemini-2.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b'
    ],
    requiresApiKey: true,
    description: 'Google 的多模态大模型，兼容 OpenAI 格式'
  },

  custom: {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    provider: 'custom',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    description: '任何兼容 OpenAI API 格式的 LLM'
  }
};

/**
 * 获取预设配置
 */
export function getPreset(id: string): LLMPreset | undefined {
  return LLM_PRESETS[id];
}

/**
 * 获取所有预设
 */
export function getAllPresets(): LLMPreset[] {
  return Object.values(LLM_PRESETS);
}

/**
 * 根据 provider 获取预设
 */
export function getPresetByProvider(provider: string): LLMPreset | undefined {
  return Object.values(LLM_PRESETS).find(p => p.provider === provider);
}
