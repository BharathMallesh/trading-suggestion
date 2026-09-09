// BROWSER-ADAPTED: vendored from upstream src/tools/core.ts:205-233. Browser-safe
// (Intl/Date only); schema and JSON output shape preserved.
import type { ToolModule } from './interface';

export function makeDateTimeTool(): ToolModule {
  return {
    name: 'Date & Time',
    definition: {
      type: 'function',
      function: {
        name: 'get_current_datetime',
        description: "Get the current system date and time. Use this when the user refers to relative dates (like 'today', 'next week', 'this March') to ensure accuracy.",
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async () => {
      const now = new Date();
      return JSON.stringify({
        iso: now.toISOString(),
        local: now.toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
      }, null, 2);
    },
  };
}
