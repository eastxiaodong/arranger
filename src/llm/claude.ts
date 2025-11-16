/**
 * Claude (Anthropic) LLM 客户端
 */

import Anthropic from '@anthropic-ai/sdk';
import { TextDecoder } from 'util';
import { BaseLLMClient, LLMMessage, LLMTool, LLMResponse, LLMConfig, LLMStreamChunk, LLMToolCall } from './base';

export class ClaudeLLMClient extends BaseLLMClient {
  private client: Anthropic;
  private baseURL: string;
  private decoder = new TextDecoder();

  constructor(config: LLMConfig) {
    super(config);
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL
    });
    this.baseURL = (config.baseURL && config.baseURL.length > 0)
      ? config.baseURL.replace(/\/+$/, '')
      : 'https://api.anthropic.com';
  }

  private buildAnthropicPayload(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ) {
    const anthropicMessages: Anthropic.MessageParam[] = messages.map(msg => ({
      role: msg.role === 'system' ? 'user' : msg.role,
      content: msg.content
    }));

    const anthropicTools = tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema
    }));

    return {
      model: this.config.model,
      max_tokens: options?.maxTokens || this.config.maxTokens || 4096,
      temperature: options?.temperature ?? this.config.temperature,
      system: options?.systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools
    };
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
    const payload = this.buildAnthropicPayload(messages, tools, options);

    const response = await this.client.messages.create(payload as any);

    // 解析响应
    let content = '';
    const tool_calls: any[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        const toolUseBlock = block as any;
        tool_calls.push({
          id: toolUseBlock.id,
          name: toolUseBlock.name,
          input: toolUseBlock.input
        });
      }
    }

    return {
      content,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      stop_reason: response.stop_reason as any,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      }
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
    const payload = {
      ...this.buildAnthropicPayload(messages, tools, options),
      stream: true
    };

    const response = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Claude stream response body is empty');
    }

    const reader = response.body.getReader();
    let buffer = '';

    const aggregate: LLMResponse = {
      content: '',
      stop_reason: 'end_turn'
    };
    const toolCallMap = new Map<number, { id?: string; name?: string; arguments?: string }>();
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
        const { events, done: chunkDone } = this.consumeAnthropicChunk(rawEvent, aggregate, toolCallMap);
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

  private consumeAnthropicChunk(
    chunk: string,
    aggregate: LLMResponse,
    toolCallMap: Map<number, { id?: string; name?: string; arguments?: string }>
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
        const parsed = JSON.parse(payload);
        switch (parsed.type) {
          case 'content_block_delta':
            if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
              aggregate.content += parsed.delta.text;
              events.push({ type: 'content', content: parsed.delta.text });
            }
            break;
          case 'content_block_start':
            if (parsed.content_block?.type === 'tool_use') {
              toolCallMap.set(parsed.index ?? toolCallMap.size, {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                arguments: JSON.stringify(parsed.content_block.input ?? {})
              });
            }
            break;
          case 'message_delta':
            if (parsed.delta?.stop_reason) {
              aggregate.stop_reason = parsed.delta.stop_reason;
            }
            if (parsed.usage) {
              aggregate.usage = {
                input_tokens: parsed.usage.input_tokens ?? aggregate.usage?.input_tokens ?? 0,
                output_tokens: parsed.usage.output_tokens ?? aggregate.usage?.output_tokens ?? 0
              };
            }
            break;
          case 'message_stop':
            aggregate.tool_calls = this.assembleToolCalls(toolCallMap);
            events.push({ type: 'done', response: aggregate });
            isDone = true;
            break;
          default:
            break;
        }
      } catch (error) {
        events.push({
          type: 'error',
          error: error instanceof Error ? error.message : 'Claude stream parse error'
        });
      }
    }

    return { events, done: isDone };
  }

  private assembleToolCalls(
    map: Map<number, { id?: string; name?: string; arguments?: string }>
  ): LLMToolCall[] | undefined {
    if (map.size === 0) {
      return undefined;
    }
    const calls: LLMToolCall[] = [];
    for (const entry of map.values()) {
      let input: Record<string, any> = {};
      if (entry.arguments) {
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
}
