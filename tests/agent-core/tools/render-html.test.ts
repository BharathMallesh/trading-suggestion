import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../../helpers/fake-storage';
import { makeRenderHtmlTool } from '../../../src/agent-core/tools/render-html';

describe('render_html', () => {
  it('writes an SVG file to the workspace and returns its path', async () => {
    const storage = new FakeStorage();
    const t = makeRenderHtmlTool(storage);
    const out = await t.handler({ html: '<div style="width:100px;height:50px">Hi</div>', path: 'cards/x.svg', format: 'svg' }, {});
    expect(out).toContain('cards/x.svg');
    const svg = await storage.readText('workspace/cards/x.svg');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Hi');
  });
  it('rejects output paths outside the workspace', async () => {
    const t = makeRenderHtmlTool(new FakeStorage());
    await expect(t.handler({ html: '<b/>', path: '../x.svg', format: 'svg' }, {})).rejects.toThrow(/outside/i);
  });
  it('escapes & so the SVG stays well-formed', async () => {
    const storage = new FakeStorage();
    const t = makeRenderHtmlTool(storage);
    await t.handler({ html: '<b>Me & You</b>', path: 'a.svg', format: 'svg' }, {});
    const svg = await storage.readText('workspace/a.svg');
    expect(svg).toContain('Me &amp; You');
    expect(svg).not.toContain('Me & You<');
  });
  it('png in the test env degrades gracefully to SVG', async () => {
    const storage = new FakeStorage();
    const t = makeRenderHtmlTool(storage);
    const out = await t.handler({ html: '<b/>', path: 'x.png', format: 'png' }, {});
    expect(out).toContain('x.png');
    const svg = await storage.readText('workspace/x.png');
    expect(svg).toContain('<svg');
  });
});
