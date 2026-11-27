import { describe, expect, it } from 'vitest';

// Node modules, loaded so the app's type check (no Node types) does not see them.
const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { execFileSync } = (await import(/* @vite-ignore */ 'node:child_process' as string)) as {
  execFileSync(file: string, args: string[], options: { encoding: 'utf8' }): string;
};
const node = (globalThis as unknown as { process: { execPath: string } }).process.execPath;

describe('rules.ts (Ruling 269)', () => {
  it('matches the installed markdownlint, so an upgrade cannot leave it stale', () => {
    const fresh = execFileSync(node, ['scripts/gen-lint-rules.mjs', '--stdout'], { encoding: 'utf8' });

    expect(readFileSync('src/lib/lint/rules.ts', 'utf8')).toBe(fresh);
  });
});
