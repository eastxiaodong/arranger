/**
 * LLM 客户端基础接口
 */

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface LLMResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface LLMConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMStreamChunk {
  type: 'content' | 'done' | 'error';
  content?: string;
  response?: LLMResponse;
  error?: string;
}

export abstract class BaseLLMClient {
  protected config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * 发送消息并获取响应
   */
  abstract chat(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): Promise<LLMResponse>;

  /**
   * 流式响应（可选实现）
   */
  async *stream(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): AsyncGenerator<LLMStreamChunk> {
    // 默认实现：调用 chat 并一次性返回
    const response = await this.chat(messages, tools, options);
    if (response.content) {
      yield {
        type: 'content',
        content: response.content
      };
    }
    yield {
      type: 'done',
      response
    };
  }
}
