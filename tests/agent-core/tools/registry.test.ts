import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { buildToolRegistry, getToolDefinitions, executeToolHandler, listUnavailableTools } from '../../../src/agent-core/tools';

describe('registry', () => {
  it('lists browser tools and gates web_fetch offline', () => {
    buildToolRegistry(new FakeStorage(), { online: false });
    const names = getToolDefinitions({}).map((d) => d.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
    expect(names).toContain('get_current_datetime');
    expect(names).not.toContain('web_fetch');
    expect(listUnavailableTools({})).toContain('web_fetch');
  });
  it('executeToolHandler dispatches and reports unknown tools', async () => {
    buildToolRegistry(new FakeStorage(), {});
    const out = await executeToolHandler('nope_tool', {}, { autoConfirm: true });
    expect(out).toMatch(/Error: Tool nope_tool not found/);
  });
});
