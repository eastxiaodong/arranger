/**
 * OpenAI 兼容的 LLM 客户端
 * 支持：OpenAI、GLM、Gemini、以及任何兼容 OpenAI API 格式的 LLM
 */

import { TextDecoder } from 'util';
import { BaseLLMClient, LLMMessage, LLMTool, LLMResponse, LLMConfig, LLMStreamChunk, LLMToolCall } from './base';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamResponse {
  choices: Array<{
    delta: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string; value?: string }>;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export class OpenAILLMClient extends BaseLLMClient {
  private baseURL: string;
  private decoder = new TextDecoder();

  constructor(config: LLMConfig) {
    super(config);
    // 确保 Base URL 末尾没有斜杠，避免双斜杠问题
    let baseURL = config.baseURL || 'https://api.openai.com/v1';
    this.baseURL = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
  }

  private buildRequestPayload(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ) {
    const openaiMessages: OpenAIMessage[] = [];

    if (options?.systemPrompt) {
      openaiMessages.push({
        role: 'system',
        content: options.systemPrompt
      });
    }

    openaiMessages.push(...messages.map(msg => ({
      role: msg.role,
      content: msg.content
    })));

    const openaiTools: OpenAITool[] | undefined = tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }));

    const requestBody: any = {
      model: this.config.model,
      messages: openaiMessages,
      max_tokens: options?.maxTokens || this.config.maxTokens || 4096,
      temperature: options?.temperature ?? this.config.temperature ?? 0.7
    };

    if (openaiTools && openaiTools.length > 0) {
      requestBody.tools = openaiTools;
      requestBody.tool_choice = 'auto';
    }

    return requestBody;
  }

  async chat(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): Promise<LLMResponse> {
    const requestBody = this.buildRequestPayload(messages, tools, options);

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = await response.json() as OpenAIResponse;
    const choice = data.choices[0];

    // 解析响应
    // GLM 模型使用 reasoning_content 字段（推理模式）
    // Gemini 可能返回空的 content 字段
    const message = choice.message as any;
    let content = message.reasoning_content || message.content || '';

    // Gemini 特殊处理：如果 content 为空但有 parts，提取 text
    if (!content && message.parts) {
      content = message.parts.map((p: any) => p.text || '').join('');
    }

    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments)
    }));

    return {
      content,
      tool_calls,
      stop_reason: this.mapFinishReason(choice.finish_reason),
      usage: data.usage ? {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens
      } : undefined
    };
  }

  async *stream(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): AsyncGenerator<LLMStreamChunk> {
    const requestBody = this.buildRequestPayload(messages, tools, options);
    requestBody.stream = true;

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error('OpenAI stream response body is empty');
    }

    const reader = response.body.getReader();
    let buffer = '';

    const aggregate: LLMResponse = {
      content: '',
      stop_reason: 'end_turn'
    };
    const toolCallMap = new Map<number, { id?: string; name?: string; arguments: string }>();

    let streamCompleted = false;
    while (!streamCompleted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += this.decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        const { events, done: chunkDone } = this.consumeSseChunk(rawEvent, aggregate, toolCallMap);
        for (const event of events) {
          yield event;
        }
        if (chunkDone) {
          streamCompleted = true;
          break;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (!streamCompleted) {
      aggregate.tool_calls = this.assembleToolCalls(toolCallMap);
      yield { type: 'done', response: aggregate };
    }
  }

  private consumeSseChunk(
    chunk: string,
    aggregate: LLMResponse,
    toolCallMap: Map<number, { id?: string; name?: string; arguments: string }>
  ): { events: LLMStreamChunk[]; done: boolean } {
    const events: LLMStreamChunk[] = [];
    let isDone = false;
    if (!chunk) {
      return { events, done: isDone };
    }
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (!payload) {
        continue;
      }
      if (payload === '[DONE]') {
        aggregate.tool_calls = this.assembleToolCalls(toolCallMap);
        events.push({ type: 'done', response: aggregate });
        isDone = true;
        continue;
      }
      try {
        const parsed = JSON.parse(payload) as OpenAIStreamResponse;
        const choice = parsed.choices?.[0];
        if (parsed.usage) {
          aggregate.usage = {
            input_tokens: parsed.usage.prompt_tokens,
            output_tokens: parsed.usage.completion_tokens
          };
        }
        if (!choice) {
          continue;
        }
        const delta = choice.delta as any;
        // GLM 模型使用 reasoning_content 字段（推理模式）
        const contentField = delta?.reasoning_content || delta?.content;
        if (contentField) {
          const text = this.extractContent(contentField);
          if (text) {
            aggregate.content += text;
            events.push({
              type: 'content',
              content: text
            });
          }
        }
        if (delta?.tool_calls) {
          this.applyToolCallDelta(toolCallMap, delta.tool_calls);
        }
        if (choice.finish_reason) {
          aggregate.stop_reason = this.mapFinishReason(choice.finish_reason);
        }
      } catch (error) {
        events.push({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown stream parsing error'
        });
      }
    }
    return { events, done: isDone };
  }

  private extractContent(content: any): string {
    if (!content) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map(item => {
          if (typeof item === 'string') {
            return item;
          }
          if (item?.text) {
            return typeof item.text === 'string' ? item.text : item.text.value || '';
          }
          if (item?.value) {
            return item.value;
          }
          return '';
        })
        .join('');
    }
    if (typeof content === 'object' && content.text) {
      return typeof content.text === 'string' ? content.text : content.text.value || '';
    }
    return '';
  }

  private applyToolCallDelta(
    map: Map<number, { id?: string; name?: string; arguments: string }>,
    deltas: Array<{
      index: number;
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>
  ) {
    for (const delta of deltas) {
      const target = map.get(delta.index) || { arguments: '' };
      if (delta.id) {
        target.id = delta.id;
      }
      if (delta.function?.name) {
        target.name = delta.function.name;
      }
      if (delta.function?.arguments) {
        target.arguments = (target.arguments || '') + delta.function.arguments;
      }
      map.set(delta.index, target);
    }
  }

  private assembleToolCalls(
    map: Map<number, { id?: string; name?: string; arguments: string }>
  ): LLMToolCall[] | undefined {
    if (map.size === 0) {
      return undefined;
    }
    const calls: LLMToolCall[] = [];
    for (const entry of map.values()) {
      let input: Record<string, any> = {};
      if (entry.arguments && entry.arguments.trim().length > 0) {
        try {
          input = JSON.parse(entry.arguments);
        } catch {
          input = { raw: entry.arguments };
        }
      }
      calls.push({
        id: entry.id || `tool_${entry.name || 'function'}_${Date.now()}`,
        name: entry.name || 'unknown_function',
        input
      });
    }
    return calls;
  }

  private mapFinishReason(reason: string): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
      case 'function_call':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

}
