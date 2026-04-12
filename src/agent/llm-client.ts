import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { AgentConfig } from '../types';

export type { ChatCompletionTool, ChatCompletionMessageToolCall };

export interface ToolCallResult {
  /** Tool calls requested by the model (may be empty). */
  toolCalls: ChatCompletionMessageToolCall[];
  /** Raw text content (present when model replies in text instead of calling tools). */
  text: string;
}

export class LLMClient {
  private readonly client: OpenAI;
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.lmStudioUrl,
      apiKey: config.apiKey,
    });
  }

  // ── Tool-calling chat ──────────────────────────────────────────────────────
  /**
   * Sends a chat request with optional tool definitions.
   * Returns both any tool_calls the model made AND any raw text content.
   *
   * When `tools` is provided and the model decides to call a tool,
   * `toolCalls` will be non-empty and `text` may be empty.
   * When the model responds normally, `text` will be non-empty.
   */
  async chatWithTools(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    forceTool?: string,
  ): Promise<ToolCallResult> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model:      this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens:  this.config.maxTokens,
      stream:      false,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      // Some OpenAI-compatible backends (including certain LM Studio builds)
      // only accept string tool_choice values: none | auto | required.
      // When a caller asks to force a tool, use "required" to guarantee a
      // tool call without sending the object form.
      params.tool_choice = forceTool ? 'required' : 'auto';
    }

    const completion = await this.client.chat.completions.create(params);
    const choice = completion.choices[0];

    return {
      toolCalls: choice?.message?.tool_calls ?? [],
      text: choice?.message?.content?.trim() ?? '',
    };
  }

  // ── Simple text-only chat (backwards compat) ───────────────────────────────
  async chat(messages: ChatCompletionMessageParam[]): Promise<string> {
    const { text } = await this.chatWithTools(messages);
    if (!text) {
      throw new Error(
        'LM Studio returned an empty response. Ensure the model is loaded and the server is running.',
      );
    }
    return text;
  }

  /** Quick single-turn completion. */
  async complete(prompt: string): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }]);
  }

  /** Health-check: verifies LM Studio is reachable and has a model loaded. */
  async ping(): Promise<boolean> {
    try {
      const models = await this.client.models.list();
      return models.data.length > 0;
    } catch {
      return false;
    }
  }
}
