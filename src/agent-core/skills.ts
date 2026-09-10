// BROWSER-ADAPTED: vendored from upstream src/skills.ts. The fs/os/path/zip
// install/pack/remove machinery is gone; discovery and the manifest run
// async over the StorageProvider instead of fs.readdirSync.
import type { StorageProvider } from './storage';

// Skill = a SKILL.md package (frontmatter + instructions, optional
// references/scripts/templates). Same format as the WorkBuddy skill store, so
// one package runs both inside AutoClaw (manifest in the system prompt, files
// read via read_file, scripts executed via shell) and on other platforms.

export type SkillSource = 'builtin' | 'user' | 'project';

export interface SkillMeta {
  name: string;
  displayName?: string;
  displayNameEn?: string;
  description: string;
  descriptionZh?: string;
  descriptionEn?: string;
  version?: string;
  author?: string;
  category?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  source: SkillSource;
  dir: string;
  skillMdPath: string;
}

export interface SkillScope {
  dir: string;
  source: SkillSource;
}

// ---- SKILL.md parsing (YAML subset: flat "key: value" lines, no nesting) ----

export interface ParsedSkillMd {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseSkillMd(raw: string): ParsedSkillMd | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

// BROWSER-ADAPTED: dir/skillMdPath are storage-relative POSIX paths, so the
// upstream path.basename/path.join calls become string ops on '/'.
function toMeta(frontmatter: Record<string, string>, dir: string, source: SkillSource): SkillMeta {
  const bool = (v?: string) => v === 'true' ? true : v === 'false' ? false : undefined;
  return {
    name: frontmatter.name || dir.split('/').pop()!,
    displayName: frontmatter.display_name,
    displayNameEn: frontmatter.display_name_en,
    description: frontmatter.description || frontmatter.description_zh || frontmatter.description_en || '',
    descriptionZh: frontmatter.description_zh,
    descriptionEn: frontmatter.description_en,
    version: frontmatter.version,
    author: frontmatter.author,
    category: frontmatter.category,
    disableModelInvocation: bool(frontmatter['disable-model-invocation']),
    userInvocable: bool(frontmatter['user-invocable']),
    source,
    dir,
    skillMdPath: `${dir}/SKILL.md`,
  };
}

// ---- discovery ----

export interface DiscoveryResult {
  skills: SkillMeta[];
  warnings: string[];
}

// BROWSER-ADAPTED: async over StorageProvider. Later scopes win on name
// collisions; dot-dirs are skipped (same policy as upstream).
export async function discoverSkills(storage: StorageProvider, scopes: SkillScope[]): Promise<DiscoveryResult> {
  const byName = new Map<string, SkillMeta>();
  const warnings: string[] = [];
  for (const scope of scopes) {           // later scopes shadow earlier on name
    if (!(await storage.exists(scope.dir))) continue;
    for (const entry of await storage.list(scope.dir)) {
      if (entry.startsWith('.')) continue;
      const skillMdPath = `${scope.dir}/${entry}/SKILL.md`;
      if (!(await storage.exists(skillMdPath))) continue;
      try {
        const parsed = parseSkillMd(await storage.readText(skillMdPath));
        const meta = parsed && toMeta(parsed.frontmatter, `${scope.dir}/${entry}`, scope.source);
        if (!meta) { warnings.push(`Skipped invalid SKILL.md at ${skillMdPath}`); continue; }
        byName.set(meta.name, { ...meta, source: scope.source, dir: `${scope.dir}/${entry}`, skillMdPath });
      } catch {
        warnings.push(`Skipped unreadable/invalid SKILL.md at ${skillMdPath}`);
      }
    }
  }
  return { skills: [...byName.values()], warnings };
}

// ---- system-prompt manifest (progressive disclosure: one line per skill) ----

// BROWSER-ADAPTED: async; defaults scope to the bundled builtin dir plus the
// user scope (project scope has no meaning in the browser build).
export async function buildSkillsManifest(storage: StorageProvider, config?: any, scopes?: SkillScope[]): Promise<string | null> {
  if (config?.skillsEnabled === false) return null;
  const { skills } = await discoverSkills(storage, scopes ?? [
    { dir: 'skills-builtin', source: 'builtin' },
    { dir: 'skills', source: 'user' },
  ]);
  const active = skills.filter((s) => !s.disableModelInvocation);
  if (!active.length) return null;
  // BROWSER-ADAPTED: header vendored from upstream buildSkillsManifest;
  // "file and shell tools" trimmed to "file tools" (no shell in the browser
  // build — skills run through the storage-backed file tools).
  return [
    'INSTALLED SKILL PACKAGES (procedural capabilities bundling instructions, scripts and templates).',
    'When a task matches a skill, first read its SKILL.md and follow it — skills run through your normal file tools, no special API:',
    ...active.map((s) =>
      `- ${s.name} (v${s.version ?? '0.0.0'}): ${s.description.replace(/\s+/g, ' ').slice(0, 400)} [read ${s.skillMdPath}]`,
    ),
  ].join('\n');
}
