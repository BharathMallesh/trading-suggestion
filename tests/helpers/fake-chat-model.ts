import type { ChatModel, ChatCompletionParams, ChatChunk, ChatChunkDelta } from '@core/chat-model';

export interface FakeChatModelOptions {
  /**
   * When true, each scripted tool call is split across multiple deltas like a
   * real stream: the first delta for an index carries only its `id`; the
   * function name and arguments follow in ≤4-char chunks.
   */
  fragmentToolCalls?: boolean;
}

/** Scriptable model: each call pops one scripted turn. */
export class FakeChatModel implements ChatModel {
  turns: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }> = [];
  received: ChatCompletionParams[] = [];
  private fragmentToolCalls: boolean;

  constructor(options: FakeChatModelOptions = {}) {
    this.fragmentToolCalls = options.fragmentToolCalls ?? false;
  }

  async createChatCompletionStream(params: ChatCompletionParams): Promise<AsyncIterable<ChatChunk>> {
    this.received.push(structuredClone(params));
    const turn = this.turns.shift() ?? { content: '(no scripted turn)' };
    const fragment = this.fragmentToolCalls;
    async function* gen(): AsyncIterable<ChatChunk> {
      if (turn.content) {
        for (const ch of turn.content.match(/.{1,8}/gs) ?? []) {
          yield { choices: [{ delta: { content: ch } }] };
        }
      }
      if (turn.toolCalls) {
        if (fragment) {
          const deltas: ChatChunkDelta[] = [];
          for (const [i, tc] of turn.toolCalls.entries()) {
            deltas.push({ tool_calls: [{ index: i, id: tc.id }] });
            for (const ch of tc.name.match(/.{1,4}/gs) ?? []) {
              deltas.push({ tool_calls: [{ index: i, function: { name: ch } }] });
            }
            for (const ch of tc.arguments.match(/.{1,4}/gs) ?? []) {
              deltas.push({ tool_calls: [{ index: i, function: { arguments: ch } }] });
            }
          }
          for (let d = 0; d < deltas.length; d++) {
            yield {
              choices: [{
                delta: deltas[d],
                ...(d === deltas.length - 1 ? { finish_reason: 'tool_calls' } : {}),
              }],
            };
          }
        } else {
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
        }
      } else {
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      }
    }
    return gen();
  }
}
