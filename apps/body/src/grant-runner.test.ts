import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import {
  interpreterScriptArgument,
  parseCommandGrantTarget,
} from '@beeline/api-contract/agent-grants';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import {
  GrantCommandRunner,
  GrantRunnerServer,
  ROOM_SANDBOX_UNAVAILABLE,
  matchCommandGrant,
  type GrantWritePolicy,
} from './grant-runner.js';

const AGENT = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const ALEX = 'c'.repeat(64);
type LiveGrant = DaemonOperationMap['listAgentGrants']['output']['grants'][number];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function grant(overrides: Partial<LiveGrant>): LiveGrant {
  return {
    grantId: 'grant-1',
    workspaceId: WORKSPACE,
    roomId: ROOM,
    kind: 'command',
    target: `${process.execPath} probe.mjs --with FLY_TOKEN`,
    status: 'approved',
    requestedBy: ALEX,
    requestedByName: 'Alex',
    ...overrides,
  };
}

/**
 * The script binding an approval carries for an interpreter line (C94). The
 * probes here run under `process.execPath`, which IS an interpreter, so every
 * fixture grant is bound to the bytes of the probe it names — exactly as a real
 * approval card binds what a human read.
 */
function bindScript(cwd: string, entry: LiveGrant): LiveGrant {
  if (entry.kind !== 'command') return entry;
  let argument: { path: string } | undefined;
  try {
    argument = interpreterScriptArgument(parseCommandGrantTarget(entry.target).argv);
  } catch {
    return entry;
  }
  if (!argument) return entry;
  const path = resolve(cwd, argument.path);
  if (!existsSync(path)) return entry;
  const bytes = readFileSync(path);
  return {
    ...entry,
    script: {
      path: argument.path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      contents: bytes.toString('utf8'),
    },
  };
}

async function harness(
  grants: LiveGrant[],
  turn?: () => { requestId: string; requester?: { pubkey: string; name?: string } } | undefined,
  writePolicy: () => GrantWritePolicy = () => ({ surface: 'corner' }),
) {
  const cwd = await mkdtemp(join(tmpdir(), 'beeline-grant-runner-'));
  roots.push(cwd);
  // Command targets carry no shell metacharacters, so the probes are files in the checkout.
  await writeFile(
    join(cwd, 'probe.mjs'),
    "console.log(process.env.FLY_TOKEN ?? 'none', process.env.OTHER ?? 'none', process.env.LEAKY ?? 'none', process.cwd());\n",
  );
  await writeFile(join(cwd, 'exit3.mjs'), 'process.exit(3);\n');
  await writeFile(join(cwd, 'seven.mjs'), 'console.log(7);\n');
  await writeFile(join(cwd, 'one.mjs'), '\n');
  await writeFile(
    join(cwd, 'write.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2] ?? 'evil.txt', 'x');\nconsole.log('wrote');\n",
  );
  await writeFile(join(cwd, 'read.mjs'), "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('probe.mjs', 'utf8').length > 0 ? 'read' : 'empty');\n");
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const live = grants.map((entry) => bindScript(cwd, entry));
  const api = {
    execute: vi.fn(async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      if (name === 'listAgentGrants') return { grants: live };
      if (name === 'consumeAgentGrant') {
        const index = live.findIndex((entry) => entry.grantId === input.grantId);
        if (index < 0 || live[index]!.status !== 'once') throw new Error('once grant not found');
        live.splice(index, 1);
      }
      return { id: 'write', createdAt: 1 };
    }),
  };
  const secrets = new Map([
    ['FLY_TOKEN', 'fly-secret-value-123'],
    ['OTHER', 'other-secret'],
  ]);
  const runner = new GrantCommandRunner({
    api: api as never,
    agentId: AGENT,
    resolveSecret: async (name) => secrets.get(name),
    env: { PATH: process.env.PATH ?? '', HOME: cwd, LEAKY: 'must-not-reach-child' },
    timeoutMs: 20_000,
  });
  runner.register(ROOM, {
    workspaceId: WORKSPACE,
    cwd,
    writePolicy,
    turn: turn ?? (() => ({ requestId: 'turn-1', requester: { pubkey: ALEX, name: 'Alex' } })),
  });
  return { runner, api, calls, cwd, live };
}

describe('command grant matching', () => {
  it('matches only word-for-word argv prefixes inside the same Workspace', () => {
    const rules = [grant({ target: 'fly deploy -a preview --with FLY_TOKEN' })];
    expect(matchCommandGrant(rules, WORKSPACE, ['fly', 'deploy', '-a', 'preview', '--now'])?.grant.grantId).toBe(
      'grant-1',
    );
    expect(matchCommandGrant(rules, WORKSPACE, ['fly', 'deploy', '-a', 'prod'])).toBeUndefined();
    expect(matchCommandGrant(rules, WORKSPACE, ['fly', 'deploy'])).toBeUndefined();
    expect(matchCommandGrant(rules, 'other-workspace', ['fly', 'deploy', '-a', 'preview'])).toBeUndefined();
    expect(matchCommandGrant([grant({ kind: 'host', target: 'fly deploy' })], WORKSPACE, ['fly', 'deploy'])).toBeUndefined();
  });
});

describe('GrantCommandRunner', () => {
  it('refuses without a matching rule and never runs anything', async () => {
    const { runner, calls } = await harness([]);
    await expect(runner.run({ roomId: ROOM, argv: ['echo', 'hi'] })).rejects.toThrow(
      'no approved command grant matches: echo hi',
    );
    expect(calls.map((call) => call.name)).toEqual(['listAgentGrants']);
  });

  it('refuses argv that is not a prefix match of the approved line', async () => {
    const { runner, calls } = await harness([grant({ target: 'npm test --with FLY_TOKEN' })]);
    await expect(runner.run({ roomId: ROOM, argv: ['npm', 'run', 'build'] })).rejects.toThrow(
      'no approved command grant matches',
    );
    await expect(runner.run({ roomId: ROOM, argv: ['npm'] })).rejects.toThrow('no approved');
    expect(calls.filter((call) => call.name === 'postAgentActivity')).toHaveLength(0);
  });

  it('refuses a Room this daemon is not serving and malformed argv', async () => {
    const { runner } = await harness([grant({})]);
    await expect(runner.run({ roomId: 'other-room', argv: ['echo'] })).rejects.toThrow(
      'not serving that Room',
    );
    await expect(runner.run({ roomId: ROOM, argv: [] })).rejects.toThrow('non-empty array');
    await expect(runner.run({ roomId: ROOM, argv: ['echo', 'a\nb'] })).rejects.toThrow('single-line');
  });

  it('runs outside the sandbox in the checkout with PATH/HOME plus only the named secrets, scrubs them, and writes one ledger row with the requester', async () => {
    const { runner, calls, cwd } = await harness([grant({})]);
    const argv = [process.execPath, 'probe.mjs', '--extra', 'argument'];
    const result = await runner.run({ roomId: ROOM, argv });
    expect(result.exitCode).toBe(0);
    expect(result.grantId).toBe('grant-1');
    // The named secret reached the child (scrubbed on the way back); the unnamed one and LEAKY did not.
    expect(result.output.trim()).toBe(`[FLY_TOKEN] none none ${cwd}`);
    expect(result.output).not.toContain('fly-secret-value-123');
    const ledger = calls.filter((call) => call.name === 'postAgentActivity');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.input).toEqual({
      agentId: AGENT,
      roomId: ROOM,
      requestId: 'turn-1',
      activity: [
        expect.objectContaining({
          kind: 'tool',
          title: `ran ${argv.join(' ')} under grant grant-1 · asked by Alex`,
          operation: 'execute',
          status: 'exit 0',
          command: argv.join(' '),
          requestedBy: { pubkey: ALEX, name: 'Alex' },
        }),
      ],
    });
    expect((ledger[0]!.input.activity as Array<{ output: string }>)[0]!.output).not.toContain(
      'fly-secret-value-123',
    );
    // An approved rule is not consumed.
    expect(calls.some((call) => call.name === 'consumeAgentGrant')).toBe(false);
  });

  it('consumes a once grant before running and refuses the second run', async () => {
    const { runner, calls } = await harness([
      grant({ grantId: 'once-1', status: 'once', target: `${process.execPath} one.mjs` }),
    ]);
    const first = await runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] });
    expect(first.exitCode).toBe(0);
    expect(calls.map((call) => call.name)).toEqual([
      'listAgentGrants',
      'consumeAgentGrant',
      'postAgentActivity',
    ]);
    await expect(runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] })).rejects.toThrow(
      'no approved command grant matches',
    );
  });

  it('refuses when a named secret is missing from the key store, before consuming or running', async () => {
    const { runner, calls } = await harness([
      grant({ status: 'once', target: `${process.execPath} one.mjs --with MISSING_SECRET` }),
    ]);
    await expect(runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] })).rejects.toThrow(
      'secret MISSING_SECRET is not in the operator key store',
    );
    expect(calls.map((call) => call.name)).toEqual(['listAgentGrants']);
  });

  it('reports a non-zero exit and a command that does not start, still with a ledger row', async () => {
    const { runner, calls } = await harness([
      grant({ grantId: 'fail', target: `${process.execPath} exit3.mjs` }),
      grant({ grantId: 'missing', target: '/definitely/not/a/binary' }),
    ]);
    const failed = await runner.run({ roomId: ROOM, argv: [process.execPath, 'exit3.mjs'] });
    expect(failed.exitCode).toBe(3);
    const missing = await runner.run({ roomId: ROOM, argv: ['/definitely/not/a/binary', 'x'] });
    expect(missing.exitCode).toBeNull();
    expect(missing.output).toContain('ENOENT');
    const statuses = calls
      .filter((call) => call.name === 'postAgentActivity')
      .map((call) => (call.input.activity as Array<{ status: string }>)[0]!.status);
    expect(statuses).toEqual(['exit 3', 'error']);
  });

  it('falls back to the grant requester when no turn is in flight', async () => {
    const { runner, calls } = await harness([grant({ target: `${process.execPath} one.mjs` })], () => undefined);
    await runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] });
    const row = calls.find((call) => call.name === 'postAgentActivity')!;
    expect(row.input.requestId).toBe('grant:grant-1');
    expect((row.input.activity as Array<{ requestedBy: unknown; title: string }>)[0]).toEqual(
      expect.objectContaining({
        requestedBy: { pubkey: ALEX, name: 'Alex' },
        title: expect.stringContaining('asked by Alex'),
      }),
    );
  });
});

/**
 * C94: the Room's read-only promise covers a granted command.
 *
 * These run the host's real bubblewrap, because the whole point is that the
 * refusal comes from the kernel rather than from a guess about what the argv
 * means. They soft-skip where `bwrap-sandbox.test.ts` does.
 */
const bwrap = detectBwrapSandbox();
const roomDescribe = bwrap.path ? describe : describe.skip;

roomDescribe('a granted command in a top-level Room', () => {
  const roomPolicy = (scratch?: string): (() => GrantWritePolicy) => {
    return () => ({ surface: 'room', bwrapPath: bwrap.path!, ...(scratch ? { scratch } : {}) });
  };

  it('reads freely but cannot write the checkout, and the refusal names the corner', async () => {
    const { runner, calls, cwd } = await harness(
      [
        grant({ grantId: 'read', target: `${process.execPath} read.mjs` }),
        grant({ grantId: 'write', target: `${process.execPath} write.mjs` }),
      ],
      undefined,
      roomPolicy(),
    );
    const read = await runner.run({ roomId: ROOM, argv: [process.execPath, 'read.mjs'] });
    expect(read.exitCode).toBe(0);
    expect(read.output.trim()).toBe('read');
    expect(read.writeRefused).toBeUndefined();

    const write = await runner.run({ roomId: ROOM, argv: [process.execPath, 'write.mjs'] });
    expect(write.exitCode).not.toBe(0);
    expect(write.writeRefused).toBe(true);
    expect(write.output).toMatch(/read-only file system/i);
    expect(write.output).toContain('open_corner');
    expect(existsSync(join(cwd, 'evil.txt'))).toBe(false);
    // The record carries the refusal, not just the exit code.
    const rows = calls.filter((call) => call.name === 'postAgentActivity');
    expect((rows.at(-1)!.input.activity as Array<{ output: string }>)[0]!.output).toContain(
      'read-only',
    );
  });

  it('writes into the session scratch, the one place a Room may write', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'beeline-grant-scratch-'));
    roots.push(scratch);
    const { runner } = await harness(
      [grant({ target: `${process.execPath} write.mjs` })],
      undefined,
      roomPolicy(scratch),
    );
    const target = join(scratch, 'note.txt');
    const result = await runner.run({
      roomId: ROOM,
      argv: [process.execPath, 'write.mjs', target],
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('x');
  });

  it('keeps the session home overlay writable, exactly as the harness has it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-grant-home-'));
    roots.push(home);
    const { runner } = await harness(
      [grant({ target: `${process.execPath} write.mjs` })],
      undefined,
      () => ({ surface: 'room', bwrapPath: bwrap.path!, harnessStateDirs: [home] }),
    );
    const note = join(home, 'note.txt');
    expect(
      (await runner.run({ roomId: ROOM, argv: [process.execPath, 'write.mjs', note] })).exitCode,
    ).toBe(0);
    expect(readFileSync(note, 'utf8')).toBe('x');
  });

  it('lets the same write through in a corner, where writes belong', async () => {
    const { runner, cwd } = await harness([grant({ target: `${process.execPath} write.mjs` })]);
    const result = await runner.run({ roomId: ROOM, argv: [process.execPath, 'write.mjs'] });
    expect(result.exitCode).toBe(0);
    expect(result.writeRefused).toBeUndefined();
    expect(readFileSync(join(cwd, 'evil.txt'), 'utf8')).toBe('x');
  });
});

describe('a corner has strictly more freedom than a Room', () => {
  it('acts on the live host, the capability a Room does not have', async () => {
    const host = await mkdtemp(join(tmpdir(), 'beeline-grant-host-'));
    roots.push(host);
    const target = join(host, 'deployed.txt');
    // The corner writes OUTSIDE its own worktree: this is the host operation
    // that used to be reachable only from a Room, which was backwards.
    const { runner, calls } = await harness([grant({ target: `${process.execPath} write.mjs` })]);
    const result = await runner.run({
      roomId: ROOM,
      argv: [process.execPath, 'write.mjs', target],
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('x');
    // Under yolo this needed no card: the approval is the grant it already has.
    expect(calls.map((call) => call.name)).toEqual(['listAgentGrants', 'postAgentActivity']);
  });
});

describe('a Room with no usable sandbox', () => {
  it('refuses the run rather than widening the boundary, and says where to go', async () => {
    const { runner, calls } = await harness(
      [grant({ target: `${process.execPath} one.mjs` })],
      undefined,
      () => ({ surface: 'room' }),
    );
    await expect(runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] })).rejects.toThrow(
      ROOM_SANDBOX_UNAVAILABLE,
    );
    expect(calls.some((call) => call.name === 'postAgentActivity')).toBe(false);
  });
});

describe('the two hard stops', () => {
  it('refuses a credential file the approved prefix never showed a human', async () => {
    const { runner, calls } = await harness([grant({ grantId: 'cut', target: 'cut -d=' })]);
    // The rule reads a column; the run reads the key names out of an env file.
    await expect(
      runner.run({ roomId: ROOM, argv: ['cut', '-d=', '-f1', '/home/op/proj/.env'] }),
    ).rejects.toThrow('names a credential or environment file');
    expect(calls.some((call) => call.name === 'postAgentActivity')).toBe(false);
    // The approved shape itself still runs.
    expect((await runner.run({ roomId: ROOM, argv: ['cut', '-d=', '-f1', '/dev/null'] })).exitCode).toBe(
      0,
    );
  });

  it('refuses an interpreter run whose script no card ever showed', async () => {
    const { runner, live } = await harness([grant({ target: `${process.execPath} one.mjs` })]);
    live[0] = { ...live[0]!, script: undefined };
    await expect(runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] })).rejects.toThrow(
      'no human has read',
    );
  });

  it('refuses a script that changed after it was approved', async () => {
    const { runner, cwd } = await harness([grant({ target: `${process.execPath} one.mjs` })]);
    await writeFile(join(cwd, 'one.mjs'), "console.log('rewritten after the yes');\n");
    await expect(runner.run({ roomId: ROOM, argv: [process.execPath, 'one.mjs'] })).rejects.toThrow(
      'changed after it was approved',
    );
  });

  it('runs an interpreter line whose script still hashes to the approved bytes', async () => {
    const { runner } = await harness([grant({ target: `${process.execPath} seven.mjs` })]);
    expect((await runner.run({ roomId: ROOM, argv: [process.execPath, 'seven.mjs'] })).output).toBe(
      '7\n',
    );
  });
});

describe('GrantRunnerServer', () => {
  it('serves run over loopback only to the bearer token', async () => {
    const { runner } = await harness([grant({ target: `${process.execPath} seven.mjs` })]);
    const server = new GrantRunnerServer(runner);
    const endpoint = await server.start();
    try {
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const unauthorized = await fetch(`${endpoint.url}/run`, {
        method: 'POST',
        body: JSON.stringify({ roomId: ROOM, argv: [process.execPath, 'seven.mjs'] }),
      });
      expect(unauthorized.status).toBe(401);
      const ok = await fetch(`${endpoint.url}/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM, argv: [process.execPath, 'seven.mjs'] }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual(
        expect.objectContaining({ grantId: 'grant-1', exitCode: 0, output: '7\n' }),
      );
      const refused = await fetch(`${endpoint.url}/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: ROOM, argv: ['rm', '-rf', '/'] }),
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('no approved command grant');
    } finally {
      await server.close();
    }
  });
});
