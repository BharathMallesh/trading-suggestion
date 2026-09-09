// TEMPORARY STUB (Task 7) — real body lands in Task 8.
import type { ToolModule } from './interface';

export function makeWebFetchTool(): ToolModule {
  return {
    name: 'Web Fetch',
    isAvailable: (config: any) => !!config?.online,
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'stub',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async () => 'stub',
  };
}
