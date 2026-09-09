// Replaces console/ora/chalk output in upstream agent.ts.
// Event shapes match upstream's --json NDJSON events exactly.

import type { AgentRunResult, AgentUsage } from './agent';

export type AgentEvent =
  | { event: 'run_start'; model: string; task: string }
  | { event: 'token'; text: string }                       // streaming assistant text
  | { event: 'tool_call'; step: number; tool: string; args: unknown }
  | { event: 'tool_result'; step: number; tool: string; truncated: boolean; bytes: number; output_file?: string }
  | ({ event: 'usage'; step: number } & AgentUsage)
  | { event: 'confirm_request'; id: string; tool: string; args: unknown; reason: string }
  | ({ event: 'run_end' } & AgentRunResult);

export type AgentEventSink = (e: AgentEvent) => void;
