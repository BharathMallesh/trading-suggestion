// DANGEROUS_PATTERNS vendored from upstream src/tools/core.ts:20-35. Shell
// commands don't exist in the browser build, but the matcher is reused to
// flag dangerous *arguments* (paths, code strings).
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(?:-\w+\s+)*-\w*[rR]\w*[fF]\b/,
  /\b(?:rd|rmdir|del|erase)\s+\/[sS]\b/,
  /\bRemove-Item\b[^;\n]*-(?:Recurse[^;\n]*Force|Force[^;\n]*Recurse)/i,
  /\b(?:format|diskpart)\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\b[^|]*\bof=/i,
  /(?:>>?|tee)\s*\/dev\/(?:sd|nvme|hd|vd)[a-z]/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\breg\s+delete\b/i,
];

export function matchDangerousPattern(input: string): RegExp | null {
  for (const re of DANGEROUS_PATTERNS) if (re.test(input)) return re;
  return null;
}

/** POSIX-normalize and confine to the virtual workspace. */
export function isWorkspacePath(p: string): boolean {
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  let depth = 0;
  for (const part of parts) {
    if (part === '..') { if (--depth < 0) return false; } else depth++;
  }
  return true;
}

const WRITE_TOOLS = new Set(['write_file', 'delete_file', 'render_html']);

export function needsConfirmation(tool: string, args: any, config: any): boolean {
  const argsStr = JSON.stringify(args ?? {});
  if (matchDangerousPattern(argsStr) || (args?.path && !isWorkspacePath(args.path))) return true;
  if (WRITE_TOOLS.has(tool)) return !config?.autoConfirm;
  return false;
}
