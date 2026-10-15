import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the shell-less MCP fallback reads repository and materialized skills while refusing every escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'minimal-readonly-'));
  try {
    const repo = join(root, 'repo'),
      skills = join(root, 'skills');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(skills, 'using-beeline'), { recursive: true });
    writeFileSync(join(repo, 'hello.txt'), 'authorized repository text');
    writeFileSync(join(skills, 'using-beeline', 'SKILL.md'), 'approved built-in skill');
    writeFileSync(join(root, 'outside.txt'), 'private-outside-value');
    writeFileSync(join(repo, '.git', 'config'), 'private-git-value');
    symlinkSync(join(root, 'outside.txt'), join(repo, 'escape.txt'));
    const calls = [
      { id: 1, method: 'tools/list' },
      ...[
        { action: 'read', path: 'hello.txt' },
        { action: 'skill', area: 'skills', path: 'using-beeline/SKILL.md' },
        { action: 'read', path: '../outside.txt' },
        { action: 'read', path: '.git/config' },
        { action: 'read', path: 'escape.txt' },
      ].map((args, index) => ({
        id: index + 2,
        method: 'tools/call',
        params: { name: 'repository_io', arguments: args },
      })),
    ];
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          BEELINE_MCP_SURFACE: '',
          BEELINE_TURN_CONTEXT_FILE: '',
          BEELINE_READONLY_ROOT: repo,
          BEELINE_READONLY_EXTRA_ROOTS: '',
          BEELINE_READONLY_AGENT_SKILLS_ROOT: skills,
        },
        input: calls.map((call) => JSON.stringify({ jsonrpc: '2.0', ...call })).join('\n') + '\n',
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const results = child.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.id - b.id);
    expect(results[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'repository_io',
    ]);
    expect(results[1].result.content[0].text).toContain('authorized repository text');
    expect(results[2].result.content[0].text).toContain('approved built-in skill');
    for (const response of results.slice(3)) expect(response.result.isError).toBe(true);
    expect(child.stdout).not.toContain('private-outside-value');
    expect(child.stdout).not.toContain('private-git-value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
