import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setToolRegistry, executeToolHandler } from '../../../src/agent-core/tools';
import type { ToolModule } from '../../../src/agent-core/tools/interface';

function fakeTool(name: string): ToolModule & { handler: ReturnType<typeof vi.fn> } {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description: `fake ${name}`, parameters: { type: 'object', properties: {}, required: [] } },
    },
    handler: vi.fn(async () => `ok:${name}`),
  };
}

describe('executeToolHandler confirmation gate', () => {
  let writeFile: ReturnType<typeof fakeTool>;
  let readFile: ReturnType<typeof fakeTool>;

  beforeEach(() => {
    writeFile = fakeTool('write_file');
    readFile = fakeTool('read_file');
    setToolRegistry([writeFile, readFile]);
  });

  it('write_file triggers confirm_request and proceeds on approval', async () => {
    const events: any[] = [];
    const config = {
      autoConfirm: false,
      _emit: (e: any) => events.push(e),
      _confirm: vi.fn(async () => true),
    };
    const result = await executeToolHandler('write_file', { path: 'a.md', content: 'x' }, config);
    expect(result).toBe('ok:write_file');
    expect(writeFile.handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'confirm_request',
      tool: 'write_file',
      reason: expect.stringContaining('write_file'),
    });
    expect(typeof events[0].id).toBe('string');
    expect(config._confirm).toHaveBeenCalledWith(events[0].id);
  });

  it('denial returns the denied error and handler is NOT called', async () => {
    const config = { autoConfirm: false, _emit: vi.fn(), _confirm: vi.fn(async () => false) };
    const result = await executeToolHandler('write_file', { path: 'a.md', content: 'x' }, config);
    expect(result).toBe('Error: action denied by user');
    expect(writeFile.handler).not.toHaveBeenCalled();
  });

  it('no _confirm configured returns the error string', async () => {
    const config = { autoConfirm: false };
    const result = await executeToolHandler('write_file', { path: 'a.md', content: 'x' }, config);
    expect(result).toBe('Error: action requires confirmation but no confirmation channel is configured.');
    expect(writeFile.handler).not.toHaveBeenCalled();
  });

  it('read_file passes through without confirmation', async () => {
    const config = { autoConfirm: false, _emit: vi.fn(), _confirm: vi.fn(async () => true) };
    const result = await executeToolHandler('read_file', { path: 'a.md' }, config);
    expect(result).toBe('ok:read_file');
    expect(readFile.handler).toHaveBeenCalledTimes(1);
    expect(config._emit).not.toHaveBeenCalled();
    expect(config._confirm).not.toHaveBeenCalled();
  });

  it('a throwing _emit does not break dispatch', async () => {
    const config = {
      autoConfirm: false,
      _emit: () => { throw new Error('sink exploded'); },
      _confirm: vi.fn(async () => true),
    };
    const result = await executeToolHandler('write_file', { path: 'a.md', content: 'x' }, config);
    expect(result).toBe('ok:write_file');
    expect(config._confirm).toHaveBeenCalled();
  });
});
