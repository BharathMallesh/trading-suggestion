// Turns the UI's persisted personality dials (and the user's own contact
// notes) into a persona instruction spliced into the system prompt, so the
// dials the user sets actually shape how the assistant talks. Reads the same
// `luna/*.json` files the UI writes; returns '' when nothing is configured.
import type { StorageProvider } from './storage';

// Dial order matches the UI (src/app/pages/Personality.tsx), value 0..1:
// 0 = left trait, 1 = right trait.
const DIAL_TEXT: Array<{ low: string; mid: string; high: string }> = [
  { low: 'a warm, personal companion', mid: 'friendly but professional', high: 'a focused professional coworker' },
  { low: 'contemporary, Gen-Z casual phrasing (lowercase and light slang are fine)', mid: 'a neutral, current voice', high: 'classic, measured phrasing' },
  { low: 'act independently and take initiative without over-asking', mid: 'balance initiative with checking in', high: 'collaborate closely and confirm before acting' },
  { low: 'playful, witty, and light', mid: 'lightly playful but on-task', high: 'serious and businesslike' },
  { low: 'polite and diplomatic', mid: 'candid but tactful', high: 'blunt, direct, and unfiltered' },
];

function pick(bucket: { low: string; mid: string; high: string }, v: number): string {
  if (v < 0.34) return bucket.low;
  if (v > 0.66) return bucket.high;
  return bucket.mid;
}

async function readJson<T>(storage: StorageProvider, path: string): Promise<T | null> {
  try {
    if (!(await storage.exists(path))) return null;
    return JSON.parse(await storage.readText(path)) as T;
  } catch {
    return null;
  }
}

export async function loadPersonaBlock(storage: StorageProvider, name = 'the assistant'): Promise<string> {
  const dials = await readJson<number[]>(storage, 'luna/personality.json');
  const contacts = await readJson<Array<{ id: string; name?: string; notes?: string }>>(storage, 'luna/contacts.json');

  const lines: string[] = [];

  if (Array.isArray(dials) && dials.length === DIAL_TEXT.length) {
    lines.push(`ASSISTANT PERSONA — you are ${name}. Adopt this communication style:`);
    for (let i = 0; i < DIAL_TEXT.length; i++) {
      const v = typeof dials[i] === 'number' ? dials[i] : 0.5;
      lines.push(`- Be ${pick(DIAL_TEXT[i], v)}.`);
    }
    lines.push('Let this shape tone and word choice only — never at the expense of correctness, safety, or completing the task.');
  }

  const you = contacts?.find((c) => c.id === 'you');
  const about: string[] = [];
  if (you?.name?.trim()) about.push(`The user's name is ${you.name.trim()}.`);
  if (you?.notes?.trim()) about.push(`Notes about the user: ${you.notes.trim()}`);
  if (about.length) {
    if (lines.length) lines.push('');
    lines.push('ABOUT THE USER:', ...about.map((a) => `- ${a}`));
  }

  return lines.length ? lines.join('\n') : '';
}
