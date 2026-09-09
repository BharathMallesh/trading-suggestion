import type { ChatModel, ChatCompletionParams, ChatChunk } from '@core/chat-model';

/** Scriptable model: each call pops one scripted turn. */
export class FakeChatModel implements ChatModel {
  turns: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }> = [];
  received: ChatCompletionParams[] = [];

  async createChatCompletionStream(params: ChatCompletionParams): Promise<AsyncIterable<ChatChunk>> {
    this.received.push(structuredClone(params));
    const turn = this.turns.shift() ?? { content: '(no scripted turn)' };
    async function* gen(): AsyncIterable<ChatChunk> {
      if (turn.content) {
        for (const ch of turn.content.match(/.{1,8}/gs) ?? []) {
          yield { choices: [{ delta: { content: ch } }] };
        }
      }
      if (turn.toolCalls) {
        yield {
          choices: [{
            delta: {
              tool_calls: turn.toolCalls.map((tc, i) => ({
                index: i, id: tc.id,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            },
            finish_reason: 'tool_calls',
          }],
        };
      } else {
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      }
    }
    return gen();
  }
}
