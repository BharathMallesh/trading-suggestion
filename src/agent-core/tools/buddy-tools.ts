// Tools that let the agent work with Buddy's own data — the same luna/*.json
// files the UI reads/writes. This makes memory two-way (the agent can save what
// you tell it) and lets it set up schedules on request ("remind me every
// morning"). Saved memories flow back into the system prompt via persona.ts.
import type { ToolModule } from './interface';
import type { StorageProvider } from '../storage';

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function readArray<T>(storage: StorageProvider, path: string): Promise<T[]> {
  try {
    if (!(await storage.exists(path))) return [];
    const v = JSON.parse(await storage.readText(path));
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

interface MemNode {
  id: string;
  text: string;
  status: 'pending' | 'settled';
  x: number;
  y: number;
  r: number;
}

/** Save a lasting memory (appends to luna/memory.json in the Memory screen's shape). */
export function makeRememberTool(storage: StorageProvider): ToolModule {
  return {
    name: 'Remember',
    definition: {
      type: 'function',
      function: {
        name: 'remember',
        description:
          'Save a lasting memory about the user or their world to recall in future conversations — preferences, facts, names, ongoing projects. Use it whenever the user shares something worth remembering (e.g. "I\'m vegetarian", "my manager is Priya").',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The memory as a concise, standalone fact.' },
          },
          required: ['text'],
        },
      },
    },
    handler: async (args) => {
      const text = String(args?.text ?? '').trim();
      if (!text) return 'Error: nothing to remember (empty text).';
      const list = await readArray<MemNode>(storage, 'luna/memory.json');
      if (list.some((m) => (m.text || '').trim().toLowerCase() === text.toLowerCase())) {
        return `Already remembered: "${text}"`;
      }
      list.push({
        id: uuid(),
        text,
        status: 'settled',
        x: 20 + Math.random() * 60,
        y: 20 + Math.random() * 60,
        r: 22 + Math.random() * 10,
      });
      await storage.writeText('luna/memory.json', JSON.stringify(list, null, 2));
      return `Saved to memory: "${text}"`;
    },
  };
}

/** List everything currently remembered (also injected into the system prompt). */
export function makeRecallTool(storage: StorageProvider): ToolModule {
  return {
    name: 'Recall memories',
    definition: {
      type: 'function',
      function: {
        name: 'recall_memories',
        description: 'List everything you currently remember about the user. Use when the user asks what you know/remember, or to check before saving a duplicate.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async () => {
      const list = await readArray<MemNode>(storage, 'luna/memory.json');
      const texts = list.map((m) => m?.text?.trim()).filter(Boolean);
      return texts.length ? texts.map((t) => `- ${t}`).join('\n') : 'No memories saved yet.';
    },
  };
}

type Repeat = 'Hourly' | 'Daily' | 'Weekly' | 'Monthly';
interface Schedule {
  id: string;
  name: string;
  description: string;
  repeat: Repeat;
  hour: number;
  minute: number;
  ampm: 'AM' | 'PM';
  message: string;
}

/** Create a recurring schedule (appends to luna/schedules.json; the app fires it). */
export function makeCreateScheduleTool(storage: StorageProvider): ToolModule {
  return {
    name: 'Create schedule',
    definition: {
      type: 'function',
      function: {
        name: 'create_schedule',
        description:
          'Set up a recurring instruction that runs on a timer (e.g. a morning briefing, an hourly inbox check). The message is delivered to you on each fire. Use when the user asks to be reminded/updated regularly.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the schedule.' },
            message: { type: 'string', description: 'What you should do each time it fires.' },
            repeat: { type: 'string', enum: ['Hourly', 'Daily', 'Weekly', 'Monthly'], description: 'How often it repeats.' },
            hour: { type: 'number', description: 'Hour on a 12-hour clock, 1-12 (ignored for Hourly).' },
            minute: { type: 'number', description: 'Minute, 0-59 (ignored for Hourly).' },
            ampm: { type: 'string', enum: ['AM', 'PM'], description: 'AM or PM (ignored for Hourly).' },
          },
          required: ['name', 'message', 'repeat'],
        },
      },
    },
    handler: async (args) => {
      const name = String(args?.name ?? '').trim();
      const message = String(args?.message ?? '').trim();
      const repeat = (['Hourly', 'Daily', 'Weekly', 'Monthly'] as const).includes(args?.repeat) ? args.repeat : 'Daily';
      if (!name || !message) return 'Error: a schedule needs a name and a message.';
      const hour = Math.min(12, Math.max(1, Math.round(Number(args?.hour) || 9)));
      const minute = Math.min(59, Math.max(0, Math.round(Number(args?.minute) || 0)));
      const ampm = args?.ampm === 'PM' ? 'PM' : 'AM';
      const list = await readArray<Schedule>(storage, 'luna/schedules.json');
      list.push({ id: uuid(), name, description: '', repeat, hour, minute, ampm, message });
      await storage.writeText('luna/schedules.json', JSON.stringify(list, null, 2));
      const when = repeat === 'Hourly' ? 'every hour' : `${repeat.toLowerCase()} at ${hour}:${String(minute).padStart(2, '0')} ${ampm}`;
      return `Created schedule "${name}" — runs ${when}.`;
    },
  };
}

export function makeBuddyTools(storage: StorageProvider): ToolModule[] {
  return [makeRememberTool(storage), makeRecallTool(storage), makeCreateScheduleTool(storage)];
}
