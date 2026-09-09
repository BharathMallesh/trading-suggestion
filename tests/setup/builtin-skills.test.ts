import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_SKILL_FILES } from '../../src/setup/SetupWizard';

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(path.join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(path.join(dir, rel)).isDirectory()) walk(dir, rel, out);
    else out.push(rel);
  }
}

describe('BUILTIN_SKILL_FILES', () => {
  it('matches the files actually shipped under public/skills-builtin/', () => {
    const onDisk: string[] = [];
    walk(path.resolve('public/skills-builtin'), '', onDisk);
    expect([...BUILTIN_SKILL_FILES].sort()).toEqual(onDisk.sort());
  });
});
