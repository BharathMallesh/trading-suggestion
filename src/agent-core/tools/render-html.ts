// TEMPORARY STUB (Task 7) — real body lands in Task 9.
import type { StorageProvider } from '../storage';
import type { ToolModule } from './interface';

export function makeRenderHtmlTool(_storage: StorageProvider): ToolModule {
  return {
    name: 'Render HTML',
    definition: {
      type: 'function',
      function: {
        name: 'render_html',
        description: 'stub',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async () => 'stub',
  };
}
