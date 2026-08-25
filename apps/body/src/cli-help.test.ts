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
    expect(result.stdout).toContain('--agent <codex|claude|goose|pi|grok|reference|custom>');
    expect(result.stdout).toContain('With no --agent flag, beeline detects supported installed');
    expect(result.stdout).toContain('ACP adapters stay visible');
    expect(result.stdout).toContain('never installs packages automatically');
    expect(result.stdout).toContain(
      "grok       Operator's Grok through its native 'grok agent stdio' ACP server",
    );
    expect(result.stdout).toContain(
      'reference  Bundled buzz-agent (explicit fallback; requires an LLM key)',
    );
    // Cursor has no native ACP; the help must document the real custom path
    // rather than imply a preset exists.
    expect(result.stdout).toContain('Cursor has no native ACP mode');
    expect(result.stdout).toContain("--agent custom --agent-command 'cursor-acp'");
    expect(result.stdout).toContain('--agent-command');
  });

  it('documents multi-runtime pairing and the per-agent access policy', () => {
    const directory = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'pair', '--help'],
      { cwd: directory, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--agents <kind1,kind2,...>');
    expect(result.stdout).toContain('--access <everyone|creator|allowlist>');
    expect(result.stdout).toContain('--allow <npub-or-hex,...>');
    expect(result.stdout).toContain('--mcp <squire-credential-use|squire-app-access>');
    expect(result.stdout).toContain('Account capabilities require --access creator');
    expect(result.stdout).toContain('one single-use pairing code per agent');
    expect(result.stdout).toContain('creator   only the inviting owner may');
  });
});
