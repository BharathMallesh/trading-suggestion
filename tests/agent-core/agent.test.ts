// Ported from upstream src/agent.test.ts (v1.3.7). The OpenAI mock is
// replaced by FakeChatModel, console/stdout assertions by collected
// AgentEvents, and the real tools registry by setToolRegistry fakes.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@core/agent';
import type { AgentEvent } from '@core/events';
import type { ChatCompletionParams } from '@core/chat-model';
import { setToolRegistry, getToolDefinitions, executeToolHandler } from '@core/tools/index';
import type { ToolModule } from '@core/tools/interface';
import { FakeChatModel } from '../helpers/fake-chat-model';
import { FakeStorage } from '../helpers/fake-storage';

const readFileHandler = vi.fn();
const writeFileHandler = vi.fn();

function readFileTool(): ToolModule {
  return {
    name: 'Files',
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
    handler: readFileHandler,
  };
}

function writeFileTool(): ToolModule {
  return {
    name: 'Files',
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      },
    },
    handler: writeFileHandler,
  };
}

/** Endless tool-call turns with the given scripted call. */
function toolLoopTurns(call: { id: string; name: string; arguments: string }, count: number) {
  return Array.from({ length: count }, () => ({ toolCalls: [call] }));
}

describe('Agent.chat', () => {
  let model: FakeChatModel;
  let storage: FakeStorage;
  let events: AgentEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    model = new FakeChatModel();
    storage = new FakeStorage();
    events = [];
    setToolRegistry([readFileTool()]);
  });

  afterEach(() => {
    setToolRegistry([]);
    vi.useRealTimers();
  });

  it('sends user prompt and exits when assistant responds with content only', async () => {
    model.turns = [{ content: 'Hello from assistant' }];

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    const result = await agent.chat('say hello');

    expect(model.received).toHaveLength(1);
    expect(model.received[0]).toEqual(
      expect.objectContaining({
        model: 'test-model',
        tools: getToolDefinitions({}),
        tool_choice: 'auto',
        stream: true,
      }),
    );
    expect(readFileHandler).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.steps).toBe(1);
    expect(result.message).toBe('Hello from assistant');
    // streaming text arrives as token events, reassembled in order
    const tokens = events.filter((e) => e.event === 'token').map((e) => e.text).join('');
    expect(tokens).toBe('Hello from assistant');
    expect(events[0]).toMatchObject({ event: 'run_start', model: 'test-model', task: 'say hello' });
    expect(events[events.length - 1]).toMatchObject({ event: 'run_end', status: 'completed', steps: 1 });
  });

  it('executes tool calls and continues loop until final assistant message', async () => {
    model.turns = [
      { toolCalls: [{ id: 'tool-call-1', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }] },
      { content: 'Done' },
    ];
    readFileHandler.mockResolvedValueOnce('file content');

    const agent = new Agent(model, 'test-model', { autoConfirm: true }, storage, (e) => events.push(e));
    const result = await agent.chat('read the readme');

    expect(model.received).toHaveLength(2);
    expect(readFileHandler).toHaveBeenCalledWith({ path: 'README.md' }, { autoConfirm: true });
    const secondCall = model.received[1];
    expect(secondCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', tool_call_id: 'tool-call-1', content: 'file content' }),
      ]),
    );
    expect(result.status).toBe('completed');
    expect(events.find((e) => e.event === 'tool_call')).toMatchObject({
      step: 1, tool: 'read_file', args: { path: 'README.md' },
    });
    expect(events.find((e) => e.event === 'tool_result')).toMatchObject({
      step: 1, tool: 'read_file', truncated: false, bytes: 12,
    });
  });

  it('handles model request errors and stops processing loop', async () => {
    model.createChatCompletionStream = vi.fn().mockRejectedValueOnce(new Error('API unavailable'));

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    const result = await agent.chat('trigger failure');

    expect(result.status).toBe('error');
    expect(result.error).toBe('API unavailable');
    expect(events[events.length - 1]).toMatchObject({ event: 'run_end', status: 'error' });
  });

  it('retries transient model errors before the stream starts', async () => {
    vi.useFakeTimers();
    const flaky = new FakeChatModel();
    flaky.turns = [{ content: 'Recovered' }];
    const original = flaky.createChatCompletionStream.bind(flaky);
    let failed = false;
    flaky.createChatCompletionStream = async (params: ChatCompletionParams) => {
      if (!failed) {
        failed = true;
        throw Object.assign(new Error('upstream down'), { status: 503 });
      }
      return original(params);
    };

    const agent = new Agent(flaky, 'test-model', {}, storage, (e) => events.push(e));
    const done = agent.chat('flaky api');
    await vi.runAllTimersAsync();
    const result = await done;

    expect(flaky.received).toHaveLength(1);
    expect(result.status).toBe('completed');
    expect(result.message).toBe('Recovered');
  });

  it('stops after reaching the max step limit', async () => {
    model.turns = toolLoopTurns(
      { id: 'call-loop', name: 'read_file', arguments: '{}' }, 10,
    );
    readFileHandler.mockResolvedValue('ok');

    const agent = new Agent(model, 'test-model', { maxSteps: 3 }, storage, (e) => events.push(e));
    const result = await agent.chat('loop forever');

    expect(model.received).toHaveLength(3);
    expect(result.status).toBe('max_steps');
    expect(result.steps).toBe(3);
    expect(events[events.length - 1]).toMatchObject({ event: 'run_end', status: 'max_steps' });
  });

  it('feeds malformed tool arguments back to the model instead of crashing', async () => {
    model.turns = [
      { toolCalls: [{ id: 'call-bad', name: 'read_file', arguments: '{not json' }] },
      { content: 'Recovered' },
    ];

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    await agent.chat('bad args');

    expect(readFileHandler).not.toHaveBeenCalled();
    expect(model.received).toHaveLength(2);
    const secondCall = model.received[1];
    expect(secondCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-bad',
          content: expect.stringContaining('not valid JSON'),
        }),
      ]),
    );
  });

  it('truncates oversized tool results before they enter the model context', async () => {
    model.turns = [
      { toolCalls: [{ id: 'call-huge', name: 'read_file', arguments: JSON.stringify({ path: 'big.log' }) }] },
      { content: 'Done' },
    ];
    const hugeOutput = Array.from({ length: 3000 }, (_, i) => `line-${i}: ${'x'.repeat(10)}`).join('\n');
    readFileHandler.mockResolvedValueOnce(hugeOutput);

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    await agent.chat('read big file');

    expect(agent.lastOutputFile).toBeTruthy();
    const savedContent = await storage.readText(agent.lastOutputFile!);
    expect(savedContent).toBe(hugeOutput);
    const toolResultEvent = events.find((e) => e.event === 'tool_result');
    expect(toolResultEvent).toMatchObject({ truncated: true, output_file: agent.lastOutputFile });
    const toolMessage = model.received[1].messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-huge',
    );
    expect(toolMessage?.content).toContain('[Truncated: showing 2000 of 3000 lines');
    expect(toolMessage?.content?.length).toBeLessThan(hugeOutput.length);
  });

  it('emits the full event stream without touching console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    model.turns = [
      { toolCalls: [{ id: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }] },
      { content: 'All done' },
    ];
    readFileHandler.mockResolvedValueOnce('file content');

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    const result = await agent.chat('read the readme');

    expect(logSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(events.map((e) => e.event)).toEqual(['run_start', 'tool_call', 'tool_result', 'token', 'usage', 'run_end']);
    expect(events[0]).toMatchObject({ event: 'run_start', model: 'test-model', task: 'read the readme' });
    expect(events.find((e) => e.event === 'tool_call')).toMatchObject({
      tool: 'read_file',
      args: { path: 'README.md' },
    });
    expect(events.find((e) => e.event === 'tool_result')).toMatchObject({
      tool: 'read_file',
      truncated: false,
    });
    expect(events.find((e) => e.event === 'run_end')).toMatchObject({
      status: 'completed',
      steps: 2,
      message: 'All done',
    });
  });

  it('collects token usage from stream chunks', async () => {
    model.turns = [{ content: 'counting' }];

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    const result = await agent.chat('count tokens');

    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(events.find((e) => e.event === 'usage')).toMatchObject({
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    });
  });

  it('trims old tool results from history to bound context growth', async () => {
    model.turns = toolLoopTurns(
      { id: 'call-trim', name: 'read_file', arguments: '{}' }, 10,
    );
    readFileHandler.mockResolvedValue('x'.repeat(2000));

    const agent = new Agent(model, 'test-model', { maxSteps: 8 }, storage, (e) => events.push(e));
    const result = await agent.chat('read a lot');

    expect(result.status).toBe('max_steps');
    const calls = model.received;
    const toolMessagesAt = (k: number) => calls[k].messages.filter((m) => m.role === 'tool');
    const last = toolMessagesAt(calls.length - 1);
    expect(last.length).toBeGreaterThanOrEqual(5);
    // early results are replaced by a bounded excerpt
    expect(last[0].content).toContain('older tool output trimmed');
    expect(last[0].content?.length).toBeLessThan(400);
    // the three most recent results keep their full payload
    // (plus any repeat-reminder suffix from identical calls)
    for (const m of last.slice(-3)) {
      expect(m.content).not.toContain('older tool output trimmed');
      expect(m.content?.startsWith('x'.repeat(2000))).toBe(true);
    }
  });

  it('appends a best-effort run record to cache/runs.jsonl', async () => {
    model.turns = [{ content: 'logged' }];

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    const result = await agent.chat('history marker XYZ');

    expect(result.status).toBe('completed');
    const raw = await storage.readText('cache/runs.jsonl');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    const mine = lines.find((l: any) => l.task === 'history marker XYZ');
    expect(mine).toMatchObject({ status: 'completed', model: 'test-model', steps: 1 });
    expect(typeof mine.time).toBe('string');
    expect(typeof mine.durationMs).toBe('number');
  });

  it('stops with timeout status when the wall-clock budget is exceeded', async () => {
    model.turns = toolLoopTurns(
      { id: 'call-slow', name: 'read_file', arguments: '{}' }, 10,
    );
    // one slow tool call is enough to burn the wall-clock budget
    readFileHandler.mockImplementation(
      async () => new Promise((resolve) => setTimeout(() => resolve('x'.repeat(2000)), 120)),
    );

    const agent = new Agent(model, 'test-model', { taskTimeoutMs: 60, maxSteps: 100 }, storage, (e) => events.push(e));
    const result = await agent.chat('slow task');

    expect(result.status).toBe('timeout');
    expect(model.received).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it('appends escalating reminders when the identical tool call repeats', async () => {
    model.turns = toolLoopTurns(
      { id: 'call-repeat', name: 'read_file', arguments: '{"path":"same.txt"}' }, 10,
    );
    readFileHandler.mockResolvedValue('same content');

    // maxSteps 6: the final request (call #6) snapshots tool results 1..5 —
    // upstream sees the same via by-reference mutation of the last call.
    const agent = new Agent(model, 'test-model', { maxSteps: 6 }, storage, (e) => events.push(e));
    await agent.chat('stuck loop');

    const calls = model.received;
    const toolMessagesAtLast = calls[calls.length - 1].messages.filter((m) => m.role === 'tool');
    // turns 1..5 executed; reminders start at the 3rd identical call
    expect(toolMessagesAtLast).toHaveLength(5);
    expect(toolMessagesAtLast[0].content).not.toContain('identical');
    expect(toolMessagesAtLast[2].content).toContain('3th identical read_file call');
    expect(toolMessagesAtLast[4].content).toContain('5 times in a row');
    expect(toolMessagesAtLast[4].content).toContain('"path":"same.txt"');
  });

  it('resets the repeat counter when the tool call changes', async () => {
    setToolRegistry([readFileTool(), writeFileTool()]);
    model.turns = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? { toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: '{"path":"a.txt"}' }] }
        : { toolCalls: [{ id: `c${i}`, name: 'write_file', arguments: '{"path":"b.txt","content":"x"}' }] },
    );
    readFileHandler.mockResolvedValue('ok');
    writeFileHandler.mockResolvedValue('ok');

    const agent = new Agent(model, 'test-model', { maxSteps: 6 }, storage, (e) => events.push(e));
    await agent.chat('alternating calls');

    const calls = model.received;
    const toolMessages = calls[calls.length - 1].messages.filter((m) => m.role === 'tool');
    for (const m of toolMessages) {
      expect(m.content).not.toContain('identical');
    }
  });

  it('returns a tool error from the registry when the tool is unknown', async () => {
    model.turns = [
      { toolCalls: [{ id: 'call-missing', name: 'nope_tool', arguments: '{}' }] },
      { content: 'ok' },
    ];

    const agent = new Agent(model, 'test-model', {}, storage, (e) => events.push(e));
    const result = await agent.chat('unknown tool');

    expect(result.status).toBe('completed');
    const secondCall = model.received[1];
    expect(secondCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-missing',
          content: 'Error: Tool nope_tool not found.',
        }),
      ]),
    );
  });
});

describe('system prompt browser info', () => {
  it('includes the browser platform block instead of OS/shell details', async () => {
    const model = new FakeChatModel();
    model.turns = [{ content: 'hi' }];
    const storage = new FakeStorage();
    const agent = new Agent(model, 'test-model', {}, storage);
    await agent.chat('hi');

    const system = (agent as any).messages[0].content as string;
    expect(system).toContain('Platform: browser (PWA, offline-capable)');
    expect(system).toContain('User-Agent:');
    expect(system).toContain('Workspace root:');
    expect(system).not.toContain('Node.js Version');
  });
});

describe('registry helpers', () => {
  it('executeToolHandler resolves registered tools and reports unconfigured ones', async () => {
    const gated: ToolModule = {
      ...readFileTool(),
      definition: {
        type: 'function',
        function: { name: 'gated_tool', description: 'gated', parameters: { type: 'object', properties: {}, required: [] } },
      },
      isAvailable: (config: any) => !!config?.enabled,
      handler: async () => 'gated result',
    };
    setToolRegistry([gated]);
    expect((await executeToolHandler('gated_tool', {}, { enabled: true }))).toBe('gated result');
    expect((await executeToolHandler('gated_tool', {}, {}))).toContain('not configured');
    expect((await executeToolHandler('missing', {}, {}))).toContain('not found');
    setToolRegistry([]);
  });
});
