// The LLM seam. WllamaChatModel (src/llm/shim.ts) implements this over the
// wllama worker; tests use FakeChatModel. Shapes mirror OpenAI chat completions.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatChunkDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatChunk {
  choices: Array<{ delta: ChatChunkDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: 'auto' | 'none';
  stream: true;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  max_tokens?: number;
}

export interface ChatModel {
  createChatCompletionStream(
    params: ChatCompletionParams,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ChatChunk>>;
}
