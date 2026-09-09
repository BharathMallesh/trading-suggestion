import { describe, it, expect } from 'vitest';
import { matchDangerousPattern, isWorkspacePath, needsConfirmation } from '../../src/agent-core/safety';

describe('matchDangerousPattern (vendored)', () => {
  it('flags rm -rf', () => expect(matchDangerousPattern('rm -rf /')).toBeTruthy());
  it('passes ls', () => expect(matchDangerousPattern('ls -la')).toBeNull());
});

describe('isWorkspacePath', () => {
  it('accepts relative in-workspace paths', () => {
    expect(isWorkspacePath('notes/a.md')).toBe(true);
  });
  it('rejects traversal and absolute paths', () => {
    expect(isWorkspacePath('../secrets')).toBe(false);
    expect(isWorkspacePath('/etc/passwd')).toBe(false);
    expect(isWorkspacePath('a/../../b')).toBe(false);
  });
});

describe('needsConfirmation', () => {
  it('write/delete tools need confirmation unless autoConfirm', () => {
    expect(needsConfirmation('write_file', {}, { autoConfirm: false })).toBe(true);
    expect(needsConfirmation('write_file', {}, { autoConfirm: true })).toBe(false);
    expect(needsConfirmation('read_file', {}, { autoConfirm: false })).toBe(false);
  });
  it('dangerous args always need confirmation even with autoConfirm', () => {
    expect(needsConfirmation('write_file', { path: '../x' }, { autoConfirm: true })).toBe(true);
  });
});
