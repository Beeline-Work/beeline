import { describe, expect, it, afterEach } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bodyDirectory = fileURLToPath(new URL('..', import.meta.url));
const cliPath = resolve(bodyDirectory, 'src/cli.ts');
// An absolute path so tsx's ESM loader hook resolves regardless of the
// spawned process's cwd (which these tests deliberately point elsewhere).
const tsxLoaderPath = resolve(bodyDirectory, '../../node_modules/tsx/dist/loader.mjs');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tmpDir(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

/** A fake ACP command advertising a small model/effort catalog, like acp.test.ts's fixtures. */
async function fakeModelAgent(): Promise<string> {
  const directory = await tmpDir('beeline-pair-cli-agent-');
  const binary = resolve(directory, 'fake-model-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'default',
            options: [{ id: 'default' }, { id: 'sonnet' }],
          },
          {
            id: 'effort',
            category: 'effort',
            currentValue: 'default',
            options: [{ id: 'default' }, { id: 'high' }],
          },
        ],
      },
    });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

function runPair(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoaderPath, cliPath, 'pair', ...args],
    {
      cwd: opts.cwd,
      encoding: 'utf8',
      env: { ...process.env, ...opts.env },
      timeout: 30_000,
    },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('beeline pair — repository resolution', () => {
  it('fails with an actionable error (not a stack trace) when the cwd is not a git repository and --repo is absent', async () => {
    const nonRepo = await tmpDir('beeline-pair-cli-nonrepo-');
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();
    // --agent custom pins the agent so the failure under test is the
    // repository check, not the host's own installed-agent auto-detection
    // (this sandbox has several real coding CLIs on PATH).
    const { status, stderr } = runPair(
      ['BUZZ-ABCD-EFGH', '--agent', 'custom', '--agent-command', agent],
      { cwd: nonRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('[beeline] pair failed:');
    expect(stderr).toContain('pass --repo <path>');
    // No raw stack trace: a thrown Error's frames all start with a
    // whitespace-indented "at " line, which the clean handler never emits.
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('--repo bypasses the cwd git-repository check and reaches pairing-code validation', async () => {
    const nonRepo = await tmpDir('beeline-pair-cli-nonrepo-');
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();
    // A malformed pairing code fails synchronously, before any network call —
    // so if --repo worked, the failure reason changes from "not a git
    // repository" to "invalid agent pairing code", with no relay involved.
    const { status, stderr } = runPair(
      ['not-a-real-code', '--repo', gitRepo, '--agent', 'custom', '--agent-command', agent],
      { cwd: nonRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).not.toContain('git repository');
    expect(stderr).toContain('invalid agent pairing code');
  });

  it('rejects a --repo path that does not exist with a clear error', async () => {
    const nonRepo = await tmpDir('beeline-pair-cli-nonrepo-');
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const { status, stderr } = runPair(
      ['BUZZ-ABCD-EFGH', '--repo', resolve(nonRepo, 'does-not-exist')],
      { cwd: nonRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('--repo path does not exist');
  });
});

describe('beeline pair — --model/--effort validation', () => {
  it('rejects a model the agent does not advertise, before ever touching the relay', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    const { status, stderr } = runPair(
      [
        'BUZZ-ABCD-EFGH',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        agent,
        '--model',
        'gpt-nonexistent',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('--model/--effort check failed');
    expect(stderr).toContain("not one of \"model\"'s advertised options");
    // Proves this failed before redemption: no relay/network error text.
    expect(stderr).not.toContain('invalid agent pairing code');
  });

  it('rejects an effort the agent does not advertise, before ever touching the relay', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    const { status, stderr } = runPair(
      [
        'BUZZ-ABCD-EFGH',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        agent,
        '--effort',
        'ultra-max',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('--model/--effort check failed');
    expect(stderr).toContain("not one of \"effort\"'s advertised options");
  });

  it('accepts an advertised model/effort pair and proceeds past validation to redemption', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    // A malformed code fails synchronously right after the (successful)
    // model/effort check, so this proves the check passed without needing a
    // live relay: the failure reason is the pairing-code format, not the
    // model/effort check.
    const { status, stderr } = runPair(
      [
        'not-a-real-code',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        agent,
        '--model',
        'sonnet',
        '--effort',
        'high',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).not.toContain('--model/--effort check failed');
    expect(stderr).toContain('invalid agent pairing code');
  });
});
