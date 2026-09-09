// BROWSER-ADAPTED: vendored from upstream src/agent.ts (v1.3.7). The OpenAI
// SDK, chalk/ora/console output, and Node fs/os/path are replaced by the
// ChatModel, AgentEventSink, and StorageProvider seams. Loop behavior
// (tool_calls accumulation, trimming, repeat guard, step cap, deadline) is
// preserved exactly.
import { getToolDefinitions, executeToolHandler, listUnavailableTools } from './tools/index';
import { withRetry } from './retry';
import { truncateOutput } from './truncate';
import { buildSkillsManifest } from './skills';
import type { ChatModel, ChatMessage, ChatChunk } from './chat-model';
import type { AgentEvent, AgentEventSink } from './events';
import type { StorageProvider } from './storage';

const DEFAULT_MAX_STEPS = 25;
const TOOL_RESULT_TRIM_MARKER = 'older tool output trimmed';

// Canonical JSON: sorted object keys, so equivalent arguments from
// different model turns map to the same repeat signature.
function canonicalArgs(args: any): string {
  try {
    return JSON.stringify(args, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((acc: any, k) => { acc[k] = value[k]; return acc; }, {});
      }
      return value;
    });
  } catch {
    return String(args);
  }
}

export interface AgentUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AgentRunResult {
  status: 'completed' | 'error' | 'max_steps' | 'timeout';
  steps: number;
  error?: string;
  message?: string | null;
  usage?: AgentUsage;
}

export class Agent {
  private llm: ChatModel;
  private messages: ChatMessage[];
  private model: string;
  private config: any;
  private storage: StorageProvider;
  private emit: AgentEventSink;
  public lastOutputFile: string | null = null;

  constructor(
    llm: ChatModel,
    model: string,
    config: any,
    storage: StorageProvider,
    emit: AgentEventSink = () => {},
  ) {
    this.llm = llm;
    this.model = model;
    this.config = config ?? {};
    this.storage = storage;
    this.emit = emit;

    // BROWSER-ADAPTED: upstream printed OS/shell/home/user details; the app
    // runs in a browser against a virtual filesystem instead.
    const sysInfo = [
      `Platform: browser (PWA, offline-capable)`,
      `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'test'}`,
      `Workspace root: the app's virtual filesystem (paths are relative)`,
      `Current date/time: ${new Date().toString()}`,
    ].join('\n');

    // Every turn resends every tool definition, so unconfigured capabilities
    // are dropped from both the tool array and this capability list.
    const unavailable = listUnavailableTools(config);
    const has = (tool: string) => !unavailable.includes(tool);
    const capabilities = [
      '- Shell: execute_shell_command — run scripts, install packages, manage processes, interact with the OS',
      '- Files: read_file / write_file — inspect logs, generate configs, produce reports',
      has('web_search') ? '- Web: web_search — real-time information lookup' : null,
      has('read_website') ? '- Web: read_website — extract article content from a URL' : null,
      has('take_screenshot') ? '- Web: take_screenshot — capture page visuals' : null,
      has('start_background_process') ? '- Processes: start_background_process / check_background_process / stop_background_process — run long-lived commands (servers, watchers) in the background and poll their output' : null,
      has('send_email') ? '- Communication: send_email — SMTP email delivery' : null,
      has('send_notification') ? '- Communication: send_notification — push to Feishu/DingTalk/WeCom' : null,
      has('generate_image') ? '- Creation: generate_image — AI image generation (DALL-E compatible)' : null,
      has('optimize_prompt') ? '- Creation: optimize_prompt — refine raw prompts for creative/complex tasks (recommended before creative work)' : null,
      '- Utility: get_current_datetime — accurate system time for temporal reasoning'
    ].filter((line): line is string => line !== null).join('\n');

    // BROWSER-ADAPTED: the skills manifest placeholder is async, so it is
    // loaded on the first chat() call (see ensureSkillsManifest).
    this.messages = [
      {
        role: "system",
        content: `You are AutoClaw, a lightweight AI agent that operates directly in the terminal. You accomplish tasks by executing shell commands, reading and writing files, and using integrated tools — no GUI, no guesswork, deterministic results.

You may be running on a developer workstation, a headless server, inside a Docker container, or in a CI/CD pipeline. Adapt accordingly.

${sysInfo}

WHAT YOU CAN DO:
${capabilities}
{SKILLS_BLOCK}
RULES OF ENGAGEMENT:
1. One shot, not one chat. Produce working results, not conversation. Be terse.
2. Use the right tool for the job. Shell for system ops. Files for content. Web tools for external info.
3. Always pass non-interactive flags: --yes for npx, -y for apt/apk, -f for rm, etc. Assume no human is watching. Set GIT_TERMINAL_PROMPT=0 for git commands that may need credentials so they fail fast instead of hanging.
4. Container-friendly: stick to standard Unix tools available in Alpine/Debian slim images. No GUI apps, no browser-based debug tools.
5. For creative or complex tasks (image prompts, long-form writing, intricate scripts): call optimize_prompt first. It significantly raises output quality.
6. If a command fails, diagnose and try one alternative. Don't retry the same thing, don't give up on first error.
7. Read before write. When modifying a file, read it first. When installing a package, check if it's already there.
`
      }
    ];
  }

  // BROWSER-ADAPTED: skills ride along as one-line manifest entries; the
  // manifest is async (storage-backed discovery), so it is resolved on first
  // use and spliced into the system prompt. Never break startup on a
  // malformed skill system.
  // Memoized so concurrent chat() calls await the same splice.
  private skillsPromise?: Promise<void>;
  private ensureSkillsManifest(): Promise<void> {
    this.skillsPromise ??= (async () => {
      let skillsManifest: string | null = null;
      try {
        skillsManifest = await buildSkillsManifest(this.storage, this.config);
      } catch {
        skillsManifest = null;
      }
      const sys = this.messages[0];
      if (typeof sys.content !== 'string') return;
      if (skillsManifest) {
        sys.content = sys.content.replace('{SKILLS_BLOCK}', `\n${skillsManifest}\n`);
      } else {
        sys.content = sys.content.replace('{SKILLS_BLOCK}', '');
      }
    })();
    return this.skillsPromise;
  }

  // BROWSER-ADAPTED: a throwing UI sink must not kill the agent loop.
  private safeEmit(e: AgentEvent): void {
    try { this.emit(e); } catch { /* UI bug must not kill the run */ }
  }

  async chat(userInput: string): Promise<AgentRunResult> {
    await this.ensureSkillsManifest();
    this.messages.push({ role: "user", content: userInput });

    // BROWSER-ADAPTED: env-var overrides (AUTOCLOW_*) removed; config only.
    // Invalid values fall back to the defaults instead of NaN/negative math.
    const parsedMaxSteps = Number(this.config?.maxSteps);
    const maxSteps = Number.isFinite(parsedMaxSteps) && parsedMaxSteps > 0 ? parsedMaxSteps : DEFAULT_MAX_STEPS;
    const parsedTimeoutMs = Number(this.config?.taskTimeoutMs);
    const taskTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : 0;
    const deadline = taskTimeoutMs > 0 ? Date.now() + taskTimeoutMs : Number.POSITIVE_INFINITY;
    const abortController = new AbortController();
    const abortTimer = taskTimeoutMs > 0
      ? setTimeout(
          () => abortController.abort(new Error(`task wall-clock timeout after ${taskTimeoutMs}ms`)),
          taskTimeoutMs
        )
      : null;
    const startedAt = Date.now();
    let active = true;
    let step = 0;
    let status: AgentRunResult['status'] = 'completed';
    let errorMessage: string | undefined;
    let lastContent: string | null = null;
    let lastToolSignature: string | null = null;
    let consecutiveRepeats = 0;
    const totalUsage: AgentUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let sawUsage = false;

    this.safeEmit({ event: 'run_start', model: this.model, task: userInput });

    while (active) {
      if (step >= maxSteps) {
        status = 'max_steps';
        break;
      }
      if (Date.now() > deadline) {
        status = 'timeout';
        errorMessage = `task wall-clock timeout after ${taskTimeoutMs}ms`;
        break;
      }
      this.trimOldToolResults();
      step++;

      let stream: AsyncIterable<ChatChunk>;
      try {
        // Retries cover request setup and the header phase; a failure after
        // the stream started yielding chunks is not retried, because partial
        // output may already have been emitted.
        // NOTE: this.messages is passed BY REFERENCE and mutated in place
        // (trimOldToolResults, tool results) between turns; ChatModel
        // implementations must serialize eagerly — the wllama shim
        // structuredClones before postMessage.
        stream = await withRetry(
          async () => this.llm.createChatCompletionStream({
              model: this.model,
              messages: this.messages,
              tools: getToolDefinitions(this.config),
              tool_choice: "auto",
              stream: true,
          }, { signal: abortController.signal }),
          {
            // BROWSER-ADAPTED: the ora spinner text is replaced by nothing;
            // retries are silent until they exhaust.
            onRetry: () => {}
          }
        );
      } catch (error: any) {
        if (abortController.signal.aborted) {
          status = 'timeout';
          errorMessage = `task wall-clock timeout after ${taskTimeoutMs}ms`;
        } else {
          status = 'error';
          errorMessage = error.message;
        }
        active = false;
        break;
      }

      let content = '';
      let reasoningContent = '';
      let toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

      try {
        for await (const chunk of stream) {
          if (chunk.usage) {
            sawUsage = true;
            totalUsage.prompt_tokens += chunk.usage.prompt_tokens ?? 0;
            totalUsage.completion_tokens += chunk.usage.completion_tokens ?? 0;
            totalUsage.total_tokens += chunk.usage.total_tokens ?? 0;
          }
          const delta = chunk.choices[0]?.delta;

          // Handle reasoning/thinking content (e.g., DeepSeek)
          if (delta?.reasoning_content) {
            reasoningContent += delta.reasoning_content;
          }

          // Handle regular content
          if (delta?.content) {
            // BROWSER-ADAPTED: stdout writes become token events.
            this.safeEmit({ event: 'token', text: delta.content });
            content += delta.content;
          }

          // Handle tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      } catch (error: any) {
        if (abortController.signal.aborted) {
          status = 'timeout';
          errorMessage = `task wall-clock timeout after ${taskTimeoutMs}ms`;
        } else {
          status = 'error';
          errorMessage = error.message;
        }
        active = false;
        break;
      }

      // Build the full message for history
      const message: any = { role: "assistant" };
      if (content) message.content = content;
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        message.content = message.content || null;
      }
      this.messages.push(message);
      if (content) lastContent = content;

      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          if (toolCall.type !== 'function') continue;

          const functionName = toolCall.function.name;
          let functionArgs: any;
          try {
            functionArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch (parseError: any) {
            // Feed the failure back so the model can correct itself next turn
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Error: arguments for ${functionName} were not valid JSON (${parseError.message}). Re-issue the tool call with well-formed JSON arguments.`
            });
            continue;
          }

          // BROWSER-ADAPTED: console arg display becomes a tool_call event.
          this.safeEmit({ event: 'tool_call', step, tool: functionName, args: functionArgs });

          let toolResult: string;
          try {
            // BROWSER-ADAPTED: the runToolQuietly console monkey-patch is
            // deleted; tool handlers never touch console.
            toolResult = await executeToolHandler(functionName, functionArgs, this.config);
          } catch (err: any) {
            toolResult = `Error: ${err.message}`;
          }

          // Bound what goes back into the model context; the full output is
          // kept in storage for /view.
          const MAX_PREVIEW_LINES = 20;
          const truncation = truncateOutput(toolResult);
          const boundedResult = truncation.content;
          const resultLines = boundedResult.split('\n');

          // Loop hygiene (idea from dsh repeat-tool-reminder): identical
          // consecutive calls get an escalating reminder so the model changes
          // approach early instead of burning turns until the step cap.
          const signature = `${functionName}:${canonicalArgs(functionArgs)}`;
          if (signature === lastToolSignature) consecutiveRepeats++;
          else { consecutiveRepeats = 1; lastToolSignature = signature; }
          const repeatSuffix = consecutiveRepeats < 3
            ? ''
            : consecutiveRepeats < 5
              ? `\n[AutoClaw] Note: this is the ${consecutiveRepeats}th identical ${functionName} call in a row. If it keeps returning the same result, change approach instead of repeating it.`
              : `\n[AutoClaw] You have now made the identical ${functionName} call ${consecutiveRepeats} times in a row (arguments: ${JSON.stringify(functionArgs).slice(0, 120)}). This exact call keeps returning the same result. Stop retrying it: change approach, fix the underlying problem, or finish the task with what you already have.`;
          let outputFile: string | null = null;

          if (resultLines.length > MAX_PREVIEW_LINES || truncation.truncated) {
            // Best-effort like appendRunLog: a failing spill must not lose the
            // tool result — the bounded version still goes back to the model.
            try {
              outputFile = await this.saveOutput(functionName, toolResult);
            } catch {
              outputFile = null;
            }
            this.lastOutputFile = outputFile;
          } else {
            this.lastOutputFile = null;
          }

          // BROWSER-ADAPTED: NDJSON emitEvent becomes an unconditional event.
          this.safeEmit({
            event: 'tool_result',
            step,
            tool: functionName,
            truncated: truncation.truncated,
            bytes: truncation.totalBytes,
            ...(outputFile ? { output_file: outputFile } : {})
          });

          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: boundedResult + repeatSuffix
          });
        }
      } else {
        active = false;
      }

      if (sawUsage) {
        this.safeEmit({ event: 'usage', step, ...totalUsage });
      }
    }

    if (abortTimer) clearTimeout(abortTimer);

    const result: AgentRunResult = {
      status,
      steps: step,
      message: lastContent,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(sawUsage ? { usage: totalUsage } : {})
    };
    await this.appendRunLog(userInput, result, startedAt);
    this.safeEmit({ event: 'run_end', ...result });
    return result;
  }

  // Best-effort local run history: cache/runs.jsonl in app storage, one line
  // per run, for post-hoc debugging. Logging must never fail a run.
  // BROWSER-ADAPTED: fs.appendFileSync(~/.autoclaw/logs) replaced by storage.
  private async appendRunLog(userInput: string, result: AgentRunResult, startedAt: number): Promise<void> {
    try {
      const line = JSON.stringify({
        time: new Date().toISOString(),
        model: this.model,
        task: String(userInput).slice(0, 200),
        status: result.status,
        steps: result.steps,
        ...(result.error ? { error: result.error.slice(0, 300) } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        durationMs: Date.now() - startedAt
      });
      await this.storage.appendText('cache/runs.jsonl', line + '\n');
    } catch {
      // ignore
    }
  }

  // Every turn resends the full history, so early large tool results
  // dominate context growth. Keep the most recent results intact and bound
  // older ones to a short excerpt (full output stays in storage via /view when
  // it was large enough to be saved).
  private trimOldToolResults(): void {
    const toolIndexes: number[] = [];
    this.messages.forEach((m, i) => {
      if ((m as any).role === 'tool') toolIndexes.push(i);
    });
    const cutoff = toolIndexes.length - 3;
    for (let k = 0; k < cutoff; k++) {
      const msg: any = this.messages[toolIndexes[k]];
      if (typeof msg.content === 'string' && msg.content.length > 512 && !msg.content.includes(TOOL_RESULT_TRIM_MARKER)) {
        const original = msg.content.length;
        msg.content = `${msg.content.slice(0, 256)}\n[${TOOL_RESULT_TRIM_MARKER}: ${original} bytes total; re-run the tool if you need the full output again]`;
      }
    }
  }

  // BROWSER-ADAPTED: fs.writeFileSync(~/.autoclaw/output) replaced by storage;
  // returns the storage-relative path.
  private async saveOutput(functionName: string, toolResult: string): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `cache/outputs/${functionName}_${ts}.txt`;
    await this.storage.writeText(filename, toolResult);
    return filename;
  }
}
