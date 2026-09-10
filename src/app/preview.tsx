// Dev-only design harness: renders the Luna Shell with a stubbed agent and an
// in-memory fake StorageProvider (seeded with skills + a workspace tree) so the
// screens exercise their REAL code paths without downloading a model.
// Served at /preview.html. Not part of the production boot path (main.tsx).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent } from '@core/events';
import type { FileStat, StorageProvider } from '@core/storage';
import { Shell } from './Shell';

/* ---- fake agent: streams a canned reply ---- */
const emitters: Array<(e: AgentEvent) => void> = [];
const emit = (e: AgentEvent) => emitters.forEach((fn) => fn(e));

let aborted = false;
async function send(text: string): Promise<void> {
  aborted = false;
  emit({ event: 'run_start' } as AgentEvent);
  const reply = `You said: "${text}". This is a stubbed preview response — the real reply comes from AutoClaw's on-device model once one is loaded. It keeps going for a while so the Stop button is easy to try, word after word after word after word.`;
  for (const word of reply.split(' ')) {
    if (aborted) {
      emit({ event: 'run_end', status: 'error', steps: 1 } as AgentEvent);
      return;
    }
    await new Promise((r) => setTimeout(r, 120));
    emit({ event: 'token', text: word + ' ' } as AgentEvent);
  }
  emit({ event: 'run_end', status: 'ok', steps: 1 } as AgentEvent);
}
function stop(): void {
  aborted = true;
}
function registerEmitter(fn: (e: AgentEvent) => void): () => void {
  emitters.push(fn);
  return () => {
    const i = emitters.indexOf(fn);
    if (i >= 0) emitters.splice(i, 1);
  };
}

/* ---- fake storage: in-memory files, real StorageProvider surface ---- */
function skill(name: string, category: string, version: string, description: string): [string, string] {
  return [
    `skills-builtin/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\ncategory: ${category}\n---\n# ${name}\n\n${description}\n`,
  ];
}

const SEED: Record<string, string> = Object.fromEntries([
  skill('web-fetch', 'Browsing', '1.2.0', 'Fetch and read web pages, APIs, and files over HTTP for research and data gathering.'),
  skill('document-writer', 'Content', '1.0.0', 'Draft articles, reports, and long-form content in a rich editor instead of dumping it in chat.'),
  skill('inbox-management', 'Email', '0.9.0', 'Ongoing inbox triage via scheduled runs — archives noise, flags urgent items, drafts replies (never auto-sends).'),
  skill('followups', 'Email', '0.8.0', 'Track sent messages awaiting responses across communication channels.'),
  skill('image-studio', 'Content', '1.1.0', 'Create images from a text description, or edit photos and graphics the user provides.'),
  skill('calendar', 'Calendar', '1.0.0', 'Read availability and manage events; propose free slots without leaking event details.'),
  skill('computer-use', 'System', '0.5.0', 'Control a connected desktop to complete cross-app workflows.'),
  skill('phone-calls', 'Voice', '0.6.0', 'Make outgoing phone calls, receive incoming calls, and pull up past call transcripts.'),
  ['skills/my-standup/SKILL.md', '---\nname: my-standup\ndescription: My personal daily standup summarizer tuned to my projects.\nversion: 0.1.0\ncategory: Productivity\n---\n# my-standup\n'],
  // Bilingual builtin (mirrors the real code2media): Chinese display_name +
  // English display_name_en, to verify the UI prefers English.
  ['skills-builtin/code2media/SKILL.md', '---\nname: code2media\ndisplay_name: 代码转多媒体\ndisplay_name_en: Code to Media\ndescription: 通用多媒体渲染 — universal media renderer.\ndescription_en: The universal media renderer — no fixed templates, any layout, rendered as precise images, SVG, paged PDFs and animations. Offline.\ncategory: Content\nversion: 1.2.2\n---\n# code2media\n'],
  ['config.json', JSON.stringify({ name: 'Luna', model: 'qwen2.5-3b-instruct', skillsEnabled: true }, null, 2)],
  ['IDENTITY.md', '# Identity\n\nName: Luna\nRole: offline personal assistant.\n'],
  ['SOUL.md', '# Soul\n\nTone dials, values, and long-lived preferences live here.\n'],
  ['HEARTBEAT.md', '# Heartbeat\n\nLast active: just now.\n'],
  ['NOW.md', '# Now\n\nCurrent focus: building the Luna UI on AutoClaw.\n'],
  ['memory/notes.md', '- prefers concise, bulleted summaries\n- timezone: Asia/Calcutta\n'],
  ['conversations/flagging-inbox-replies.md', '# Flagging Inbox Replies\n\n(transcript)\n'],
  ['logs/app.log', '[info] booted\n[info] model loaded\n'],
]);

const files = new Map<string, string>(Object.entries(SEED));
const clean = (p: string) => p.replace(/\/+$/, '').replace(/^\/+/, '');

// Persist writes to localStorage so the harness can prove save/reload survival.
const LS_KEY = 'luna-preview-fs';
try {
  const saved = localStorage.getItem(LS_KEY);
  if (saved) for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, string>)) files.set(k, v);
} catch {
  /* ignore */
}
function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(files)));
  } catch {
    /* ignore */
  }
}

const fakeStorage: StorageProvider = {
  kind: 'fake',
  async list(dir: string): Promise<string[]> {
    const prefix = clean(dir) ? clean(dir) + '/' : '';
    const set = new Set<string>();
    for (const p of files.keys()) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest) set.add(rest.split('/')[0]);
    }
    return [...set].sort();
  },
  async exists(path: string): Promise<boolean> {
    const p = clean(path);
    if (files.has(p)) return true;
    const prefix = p + '/';
    for (const k of files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  },
  async readText(path: string): Promise<string> {
    const t = files.get(clean(path));
    if (t == null) throw new Error(`missing: ${path}`);
    return t;
  },
  async stat(path: string): Promise<FileStat> {
    const t = files.get(clean(path));
    if (t == null) throw new Error(`missing: ${path}`);
    return { size: new Blob([t]).size, mtimeMs: Date.now() };
  },
  async readBytes(path: string) {
    return new TextEncoder().encode(await this.readText(path));
  },
  async readFile(path: string) {
    return new Blob([await this.readText(path)]);
  },
  async writeText(path: string, text: string) {
    files.set(clean(path), text);
    persist();
  },
  async writeBytes(path: string, data: Uint8Array) {
    files.set(clean(path), new TextDecoder().decode(data));
    persist();
  },
  async appendText(path: string, text: string) {
    files.set(clean(path), (files.get(clean(path)) ?? '') + text);
    persist();
  },
  async remove(path: string) {
    files.delete(clean(path));
    persist();
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell
      send={send}
      stop={stop}
      registerEmitter={registerEmitter}
      resolveConfirm={() => {}}
      storageKind="fake"
      storage={fakeStorage}
    />
  </StrictMode>,
);
