// BROWSER-ADAPTED: minimal registry over a settable array; full browser tools
// land in Task 7. Tests and app bootstrapping replace the registry contents.
import type { ToolModule, ToolDefinition } from './interface';
import { matchDangerousPattern, isWorkspacePath, needsConfirmation } from '../safety';

let toolRegistry: ToolModule[] = [];
let confirmCounter = 0;

function confirmationReason(tool: string, args: any, fullConfig: any): string | null {
  const argsStr = JSON.stringify(args ?? {});
  const hit = matchDangerousPattern(argsStr);
  if (hit) return `dangerous pattern matched: ${hit}`;
  if (args?.path && !isWorkspacePath(args.path)) return `path outside workspace: ${args.path}`;
  if (needsConfirmation(tool, args, fullConfig)) return `tool ${tool} modifies the workspace`;
  return null;
}

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
  const reason = confirmationReason(name, args, fullConfig);
  if (reason) {
    const id = `confirm-${Date.now()}-${confirmCounter++}`;
    try {
      fullConfig?._emit?.({ event: 'confirm_request', id, tool: name, args, reason });
    } catch {
      // a throwing sink must never break tool dispatch
    }
    if (typeof fullConfig?._confirm === 'function') {
      const approved = await fullConfig._confirm(id);
      if (!approved) return 'Error: action denied by user';
    } else {
      return 'Error: action requires confirmation but no confirmation channel is configured.';
    }
  }
  return tool.handler(args, fullConfig);
}
