import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('beeline pair help', () => {
  it('documents auto-detection, every preset, and the explicit fallbacks', () => {
    const directory = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'pair', '--help'],
      { cwd: directory, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--agent <codex|claude|goose|pi|reference|custom>');
    expect(result.stdout).toContain('With no --agent flag, beeline detects installed');
    expect(result.stdout).toContain('Non-interactive sessions with several matches');
    expect(result.stdout).toContain(
      'reference  Bundled buzz-agent (explicit fallback; requires an LLM key)',
    );
    expect(result.stdout).toContain('--agent-command');
  });
});
