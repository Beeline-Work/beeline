import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callMcpTool, hasWriteTools, listMcpToolNames } from './mcp-inventory.js';

const expectedToolNames = [
  'list_files',
  'read_file',
  'search_text',
  'git_log',
  'git_show',
  'git_diff',
];

const serverPath = fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
let repository = '';
let outside = '';

function git(args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'readonly@example.test',
      GIT_AUTHOR_NAME: 'Read Only Test',
      GIT_COMMITTER_EMAIL: 'readonly@example.test',
      GIT_COMMITTER_NAME: 'Read Only Test',
    },
  }).trim();
}

function server() {
  return {
    name: 'buzz-readonly-mcp',
    command: process.execPath,
    args: ['--import', tsxLoader, serverPath],
    cwd: repository,
    env: { BUZZ_READONLY_ROOT: repository },
  };
}

function textResult(value: unknown): string {
  const result = value as { content?: Array<{ type?: string; text?: string }> };
  return result.content?.find((part) => part.type === 'text')?.text ?? '';
}

beforeAll(async () => {
  repository = await mkdtemp(resolve(tmpdir(), 'beeline-readonly-mcp-repo-'));
  outside = await mkdtemp(resolve(tmpdir(), 'beeline-readonly-mcp-outside-'));
  await writeFile(resolve(outside, 'secret.txt'), 'outside boundary\n');
  await writeFile(resolve(repository, 'README.md'), '# Seed repository\n');
  await writeFile(
    resolve(repository, 'stories.ts'),
    'export const primaryStory = "A person asks an agent to analyze the repository.";\n',
  );
  await symlink(resolve(outside, 'secret.txt'), resolve(repository, 'outside-link'));
  git(['init', '-q', '-b', 'main']);
  git(['add', 'README.md', 'stories.ts']);
  git(['commit', '-q', '-m', 'seed repository']);
  await writeFile(resolve(repository, 'README.md'), '# Seed repository\n\nRead-only analysis.\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'document analysis']);
});

afterAll(async () => {
  if (repository) await rm(repository, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

describe('buzz-readonly-mcp', () => {
  it('advertises only the fixed inspection inventory', async () => {
    const tools = await listMcpToolNames(server());
    expect(tools).toEqual(expectedToolNames);
    expect(hasWriteTools(tools)).toBe(false);
  });

  it('lists, reads, searches, and inspects bounded local git history', async () => {
    const listed = textResult(await callMcpTool(server(), 'list_files', { max_depth: 2 }));
    expect(listed).toContain('README.md');
    expect(listed).toContain('stories.ts');
    expect(listed).toContain('outside-link@');
    expect(listed).not.toContain('.git/');

    const read = textResult(await callMcpTool(server(), 'read_file', { path: 'stories.ts' }));
    expect(read).toContain('A person asks an agent to analyze the repository.');

    const searched = textResult(
      await callMcpTool(server(), 'search_text', { query: 'primaryStory' }),
    );
    expect(searched).toContain('stories.ts:1:');

    const log = textResult(await callMcpTool(server(), 'git_log', { limit: 2 }));
    expect(log).toContain('document analysis');
    expect(log).toContain('seed repository');

    const shown = textResult(await callMcpTool(server(), 'git_show', { revision: 'HEAD' }));
    expect(shown).toContain('document analysis');
    expect(shown).toContain('Read-only analysis.');

    const diff = textResult(
      await callMcpTool(server(), 'git_diff', { from: 'HEAD~1', to: 'HEAD' }),
    );
    expect(diff).toContain('+Read-only analysis.');
  });

  it('refuses traversal, escaping symlinks, raw commands, and every mutation-class tool', async () => {
    const attackOutput = resolve(repository, 'owned-by-option-injection');
    await expect(callMcpTool(server(), 'read_file', { path: '../secret.txt' })).rejects.toThrow(
      'inspection boundary',
    );
    await expect(callMcpTool(server(), 'read_file', { path: '.GIT/config' })).rejects.toThrow(
      'inspection boundary',
    );
    await expect(callMcpTool(server(), 'read_file', { path: 'outside-link' })).rejects.toThrow(
      'outside the repository',
    );
    await expect(
      callMcpTool(server(), 'git_show', { revision: `--output=${attackOutput}` }),
    ).rejects.toThrow('not an allowed local revision');

    for (const tool of [
      'shell',
      'execute',
      'write_file',
      'str_replace',
      'apply_patch',
      'git_commit',
      'git_checkout',
      'git_branch',
      'git_config',
      'git_push',
    ]) {
      await expect(callMcpTool(server(), tool, { command: 'touch owned' })).rejects.toThrow(
        `tool is not available in read-only mode: ${tool}`,
      );
    }

    expect(existsSync(attackOutput)).toBe(false);
    await expect(readFile(resolve(repository, 'README.md'), 'utf8')).resolves.toBe(
      '# Seed repository\n\nRead-only analysis.\n',
    );
  }, 60_000);
});
