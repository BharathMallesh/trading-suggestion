// BROWSER-ADAPTED: minimal registry over a settable array; full browser tools
// land in Task 7. Tests and app bootstrapping replace the registry contents.
import type { ToolModule, ToolDefinition } from './interface';

let toolRegistry: ToolModule[] = [];

/** Tests and the app bootstrapping replace the registry contents. */
export function setToolRegistry(tools: ToolModule[]): void { toolRegistry = tools; }

export function getToolDefinitions(config?: any): ToolDefinition[] {
  return toolRegistry.filter((t) => !t.isAvailable || t.isAvailable(config)).map((t) => t.definition);
}
export function listUnavailableTools(config?: any): string[] {
  return toolRegistry.filter((t) => t.isAvailable && !t.isAvailable(config)).map((t) => t.definition.function.name);
}
export async function executeToolHandler(name: string, args: any, fullConfig: any): Promise<string> {
  const tool = toolRegistry.find((t) => t.definition.function.name === name);
  if (!tool) return `Error: Tool ${name} not found.`;
  if (tool.isAvailable && !tool.isAvailable(fullConfig)) return `Error: Tool ${name} is not configured.`;
  return tool.handler(args, fullConfig);
}
