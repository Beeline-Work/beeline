import { describe, expect, it, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('never derives a repository binding from cwd when --repo is absent', async () => {
    const source = await readFile(resolve(bodyDirectory, 'src/cli.ts'), 'utf8');
    const resolver = source.slice(
      source.indexOf('function resolvePairRepository('),
      source.indexOf('/**\n * Check `--model`', source.indexOf('function resolvePairRepository(')),
    );

    expect(resolver).toContain('return { cwd: process.cwd(), repo: null }');
    expect(resolver.indexOf('repo: null')).toBeLessThan(
      resolver.indexOf('tryInspectLocalRepository'),
    );
  });

  it('pairs from a directory that is not a git repository: no repo is not an error', async () => {
    const nonRepo = await tmpDir('beeline-pair-cli-nonrepo-');
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();
    // A repository belongs to a ROOM, so pairing with none is valid. A
    // malformed pairing code fails synchronously before any network call, so
    // reaching *that* failure proves the repo check no longer blocks. --agent
    // custom pins the agent so the host's own installed-agent auto-detection
    // (this sandbox has several real coding CLIs on PATH) can't interfere.
    const { status, stderr } = runPair(
      ['not-a-real-code', '--agent', 'custom', '--agent-command', agent],
      { cwd: nonRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('invalid agent pairing code');
    expect(stderr).not.toContain('git repository');
    // No raw stack trace: a thrown Error's frames all start with a
    // whitespace-indented "at " line, which the clean handler never emits.
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('still rejects an explicit --repo that is not a git repository, before any question', async () => {
    const nonRepo = await tmpDir('beeline-pair-cli-nonrepo-');
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const { status, stderr } = runPair(['BUZZ-ABCD-EFGH', '--repo', nonRepo], {
      cwd: nonRepo,
      env: { XDG_STATE_HOME: stateHome },
    });

    expect(status).toBe(1);
    expect(stderr).toContain('--repo path is not a git repository');
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('ignores an ambient human key and reaches pairing with a fresh agent identity', async () => {
    const nonRepo = await tmpDir('beeline-pair-cli-nonrepo-');
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();
    const humanKey = '11'.repeat(32);

    const { status, stderr } = runPair(
      ['not-a-real-code', '--agent', 'custom', '--agent-command', agent],
      { cwd: nonRepo, env: { XDG_STATE_HOME: stateHome, BUZZ_PRIVATE_KEY: humanKey } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('ignores BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY');
    expect(stderr).toContain('invalid agent pairing code');
    expect(stderr).not.toContain('already paired on this host');
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

describe('beeline pair — one live spinner at a time', () => {
  // Each clack spinner drives its own ~80ms setInterval that erases and
  // rewrites the same stdout line, so two live at once flicker rapidly
  // between their two messages — and a spinner left running underneath a
  // clack.select fights the prompt for that line too. The pair flow's rule
  // is therefore: ask every question first, start the working spinner last.
  // Terminal rendering can't be asserted from a piped test process, so this
  // pins the source structure that guarantees it (same technique as the
  // mobile design tests).
  it('never starts a spinner around the interactive questions', async () => {
    const source = await readFile(resolve(bodyDirectory, 'src/cli.ts'), 'utf8');
    const pairOneAgent = source.slice(
      source.indexOf('async function pairOneAgent('),
      source.indexOf('function printPairResult('),
    );
    const runPairCommand = source.slice(
      source.indexOf('async function runPairCommand('),
      source.indexOf('async function startRuntime('),
    );
    expect(pairOneAgent).not.toBe('');
    expect(runPairCommand).not.toBe('');

    // The caller must not wrap pairOneAgent (which prompts) in a spinner.
    expect(runPairCommand).not.toContain('clack.spinner()');
    // pairOneAgent owns exactly one, started after the last question.
    expect(pairOneAgent.match(/clack\.spinner\(\)/g)).toHaveLength(1);
    expect(pairOneAgent.indexOf('clack.spinner()')).toBeGreaterThan(
      pairOneAgent.indexOf('pickModelAndEffort('),
    );
    expect(pairOneAgent.indexOf('clack.spinner()')).toBeGreaterThan(
      pairOneAgent.indexOf('resolveAccessSettings('),
    );
  });
});

describe('beeline pair — --model/--effort validation', () => {
  it('passes an unadvertised model through with a warning instead of blocking pairing', async () => {
    // A catalog miss is not evidence a model is unusable (pi accepts unknown
    // ids verbatim as custom model ids), so the old hard failure here was a
    // false wall: the value warns and proceeds, and whatever the harness
    // makes of it surfaces at launch with the value named.
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

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
        'gpt-nonexistent',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).not.toContain('--model/--effort check failed');
    expect(stderr).toContain('passed through as a custom id');
    // Proves validation no longer blocks: the run reached redemption and
    // failed on the malformed code, not on the model.
    expect(stderr).toContain('invalid agent pairing code');
  });

  it('passes an unadvertised effort through with a warning instead of blocking pairing', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    const { status, stderr } = runPair(
      [
        'not-a-real-code',
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
    expect(stderr).not.toContain('--model/--effort check failed');
    expect(stderr).toContain('effort "ultra-max" is not in');
    expect(stderr).toContain('passed through as a custom id');
    expect(stderr).toContain('invalid agent pairing code');
  });
  it('accepts a Codex-shaped catalog that spells choices as `value`, not `id`', async () => {
    // Real codex-acp advertises { value, name } with no `id`. The #226 pickers
    // and --model/--effort check required `id`, so a live Codex catalog loaded
    // and then offered nothing (and rejected every --model the harness actually
    // advertises). This fake speaks that wire; the pairing code is malformed so
    // we never touch the relay.
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const directory = await tmpDir('beeline-pair-cli-codex-');
    const binary = resolve(directory, 'fake-codex-agent.mjs');
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
            currentValue: 'gpt-5.6-sol',
            options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }, { value: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' }],
          },
          {
            id: 'reasoning_effort',
            category: 'thought_level',
            currentValue: 'high',
            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
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

    const { status, stderr } = runPair(
      [
        'not-a-real-code',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        binary,
        '--model',
        'gpt-5.6-sol',
        '--effort',
        'high',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).not.toContain('--model/--effort check failed');
    expect(stderr).toContain('invalid agent pairing code');
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

describe('beeline pair — --access/--auto-response (non-interactive)', () => {
  it('rejects squire under an EXPLICIT everyone access before consuming the code', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    const { status, stderr } = runPair(
      [
        'not-a-real-code',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        agent,
        '--access',
        'everyone',
        '--mcp',
        'squire',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('external MCP capabilities require --access creator');
    expect(stderr).not.toContain('invalid agent pairing code');
  });

  it('allows squire with no --access flag: the new owner-only default already is creator', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    // No --access flag resolves to DEFAULT_ACCESS_POLICY ('creator'), which
    // satisfies the squire precondition — the run proceeds past the check and
    // fails later on the deliberately invalid pairing code instead.
    const { status, stderr } = runPair(
      [
        'not-a-real-code',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        agent,
        '--mcp',
        'squire',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('invalid agent pairing code');
    expect(stderr).not.toContain('external MCP capabilities require --access creator');
  });

  it('rejects an unrecognized --access value with a clear error, not a stack trace', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');

    const { status, stderr } = runPair(
      ['BUZZ-ABCD-EFGH', '--repo', gitRepo, '--access', 'nobody'],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('--access must be one of everyone|creator|allowlist');
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('never prompts non-interactively: --access creator with no --auto-response proceeds straight to redemption', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    // A non-TTY spawnSync run has no stdin to answer an access-scope or
    // auto-response prompt with, so if either ever blocked on one this would
    // hang past the timeout instead of reaching the (synchronous, pre-relay)
    // pairing-code format check.
    const { status, stderr } = runPair(
      [
        'not-a-real-code',
        '--repo',
        gitRepo,
        '--agent',
        'custom',
        '--agent-command',
        agent,
        '--access',
        'creator',
      ],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('invalid agent pairing code');
  });

  it('never prompts non-interactively with neither flag given: falls back to the owner-only default', async () => {
    const gitRepo = await tmpDir('beeline-pair-cli-gitrepo-');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    const stateHome = await tmpDir('beeline-pair-cli-state-');
    const agent = await fakeModelAgent();

    const { status, stderr } = runPair(
      ['not-a-real-code', '--repo', gitRepo, '--agent', 'custom', '--agent-command', agent],
      { cwd: gitRepo, env: { XDG_STATE_HOME: stateHome } },
    );

    expect(status).toBe(1);
    expect(stderr).toContain('invalid agent pairing code');
  });
});
