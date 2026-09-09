import { describe, it, expect } from 'vitest';
import { FakeStorage } from '../helpers/fake-storage';
import { parseSkillMd, discoverSkills, buildSkillsManifest } from '../../src/agent-core/skills';

const SKILL = `---
name: greeter
description: Greets the user politely.
version: 1.0.0
---

# Greeter skill
Say hello warmly.
`;

describe('parseSkillMd (vendored)', () => {
  it('parses flat frontmatter and body', () => {
    const p = parseSkillMd(SKILL);
    expect(p?.frontmatter.name).toBe('greeter');
    expect(p?.body).toContain('Say hello warmly');
  });
  it('returns null without frontmatter', () => {
    expect(parseSkillMd('# no frontmatter')).toBeNull();
  });
});

describe('discoverSkills over StorageProvider', () => {
  it('finds skills in a scope dir; later scopes shadow earlier', async () => {
    const s = new FakeStorage();
    await s.writeText('skills-builtin/greeter/SKILL.md', SKILL);
    await s.writeText('skills/greeter/SKILL.md', SKILL.replace('1.0.0', '2.0.0'));
    await s.writeText('skills/other/SKILL.md', SKILL.replace('name: greeter', 'name: other'));
    const { skills, warnings } = await discoverSkills(s, [
      { dir: 'skills-builtin', source: 'builtin' },
      { dir: 'skills', source: 'user' },
    ]);
    expect(warnings).toEqual([]);
    expect(skills.find((k) => k.name === 'greeter')?.version).toBe('2.0.0'); // user shadows builtin
    expect(skills.map((k) => k.name).sort()).toEqual(['greeter', 'other']);
  });
  it('skips skill dirs with invalid SKILL.md and warns', async () => {
    const s = new FakeStorage();
    await s.writeText('skills/broken/SKILL.md', '# nope');
    const { skills, warnings } = await discoverSkills(s, [{ dir: 'skills', source: 'user' }]);
    expect(skills).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe('buildSkillsManifest', () => {
  it('emits one manifest line per skill with its read path', async () => {
    const s = new FakeStorage();
    await s.writeText('skills/greeter/SKILL.md', SKILL);
    const m = await buildSkillsManifest(s, {});
    expect(m).toContain('- greeter (v1.0.0): Greets the user politely.');
    expect(m).toContain('skills/greeter/SKILL.md');
  });
  it('returns null when skillsEnabled is false', async () => {
    expect(await buildSkillsManifest(new FakeStorage(), { skillsEnabled: false })).toBeNull();
  });
});
