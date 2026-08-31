/**
 * OS sandbox for ACP harness children — see `bwrap-sandbox.ts`.
 *
 * Two things are worth pinning here and nowhere else. The mount table is the
 * whole enforcement mechanism, so it is asserted as an exact argv rather than a
 * "contains a bind" spot check: an accidental extra `--bind` is exactly the
 * regression that would quietly reopen the Room write boundary, and a missing
 * one silently breaks a corner's ability to commit. And the fallback must stay
 * fail-OPEN: a host without a working bwrap has to keep serving Rooms, so every
 * detection failure resolves to "no path, one advisory line", never a throw.
 *
 * The last block is the live proof: it runs the real `bwrap` this host has and
 * checks that a trivial command actually cannot write where the plan says it
 * cannot. It soft-skips when bubblewrap is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  buildBwrapArgv,
  credentialMaskPaths,
  detectBwrapSandbox,
  isSandboxPolicy,
  harnessHomeStateDirs,
  resolveGitCommonDir,
  sandboxMountPlan,
  wrapAgentCommand,
} from './bwrap-sandbox.js';
import { trustySquireStorePath } from './trusty-squire-storage.js';

const ROOM_BASE = [
  '--unshare-pid',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
];
const CORNER_BASE = [
  '--unshare-pid',
  '--bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
];

describe('sandbox mount plan', () => {
  it('gives a Room its own harness state and nothing else — no checkout, no host path', () => {
    const plan = sandboxMountPlan({
      mode: 'readonly',
      cwd: '/srv/beeline/repositories/abc',
      harnessStateDirs: [
        '/srv/beeline/rooms/r1/agent-home/claude',
        '/srv/beeline/rooms/r1/agent-home/codex',
        '/srv/beeline/rooms/r1/agent-home/state',
        '/srv/beeline/rooms/r1/agent-home/cache',
      ],
      harnessHomeStateDirs: ['/home/op/.pi'],
      tmpDir: '/srv/beeline/rooms/r1/agent-home/tmp',
    });
    // Harness bookkeeping only. codex-acp cannot even start a Room session with
    // CODEX_HOME read-only, and pi-acp cannot start one with ~/.pi read-only.
    expect(plan.writable).toEqual([
      '/home/op/.pi',
      '/srv/beeline/rooms/r1/agent-home/cache',
      '/srv/beeline/rooms/r1/agent-home/claude',
      '/srv/beeline/rooms/r1/agent-home/codex',
      '/srv/beeline/rooms/r1/agent-home/state',
      '/srv/beeline/rooms/r1/agent-home/tmp',
    ]);
    // The property that matters: no checkout, and no path outside harness state.
    expect(plan.writable).not.toContain('/srv/beeline/repositories/abc');
    // Nothing here lives under /tmp, so nothing needs restoring through it.
    expect(plan.readOnly).toEqual([]);
  });

  it('gives a Room with no harness state nothing writable but the private /tmp', () => {
    expect(sandboxMountPlan({ mode: 'readonly', cwd: '/srv/repo' })).toEqual({
      readOnly: [],
      writable: [],
      quotaTmpfs: [],
      masks: [],
    });
  });

  it('restores a corner worktree, harness state, and git common dir writable', () => {
    const plan = sandboxMountPlan({
      mode: 'edit',
      cwd: '/home/op/.beeline-corners/proj/c1',
      worktreePath: '/home/op/.beeline-corners/proj/c1',
      gitCommonDir: '/srv/beeline/repositories/abc/.git',
      harnessStateDirs: [
        '/srv/beeline/rooms/r1/agent-home/claude',
        '/srv/beeline/rooms/r1/agent-home/state',
      ],
      tmpDir: '/srv/beeline/rooms/r1/agent-home/tmp',
    });
    expect(plan.writable).toEqual([
      '/home/op/.beeline-corners/proj/c1',
      '/srv/beeline/repositories/abc/.git',
      '/srv/beeline/rooms/r1/agent-home/claude',
      '/srv/beeline/rooms/r1/agent-home/state',
      '/srv/beeline/rooms/r1/agent-home/tmp',
    ]);
    // The canonical checkout's WORKING TREE stays read-only; only its git dir
    // is writable, which is what a linked worktree commits through.
    expect(plan.writable).not.toContain('/srv/beeline/repositories/abc');
    expect(plan.rootWritable).toBe(true);
  });

  it('makes corners writable by default and overlays only the hygiene denylist', () => {
    const plan = sandboxMountPlan({
      mode: 'edit',
      cwd: '/corners/c1',
      worktreePath: '/corners/c1',
      gitCommonDir: '/repos/canonical/.git',
      protectedPaths: ['/corners', '/repos/canonical', '/state/beeline'],
      additionalWritablePaths: ['/state/beeline/rooms/r1/agent-private'],
    });
    expect(plan.rootWritable).toBe(true);
    expect(plan.readOnly).toEqual(['/corners', '/repos/canonical', '/state/beeline']);
    expect(plan.writable).toEqual([
      '/corners/c1',
      '/repos/canonical/.git',
      '/state/beeline/rooms/r1/agent-private',
    ]);
    // ~/.cache, /tmp and toolchain locations need no allowlist entry: the root
    // bind is writable and only the paths above are overlaid read-only.
    expect(plan.writable).not.toContain('/home/op/.cache');
    expect(plan.writable).not.toContain('/opt/toolchains');
  });

  it('deduplicates and sorts so the argv is stable across call order', () => {
    const plan = sandboxMountPlan({
      mode: 'edit',
      cwd: '/w',
      worktreePath: '/w',
      gitCommonDir: '/w/.git',
      harnessStateDirs: ['/w', '/b/', '/a'],
    });
    expect(plan.writable).toEqual(['/a', '/b', '/w', '/w/.git']);
  });

});

describe('restoring session paths the /tmp tmpfs would hide', () => {
  it('re-binds a Room whose checkout and harness state live under /tmp', () => {
    const plan = sandboxMountPlan({
      mode: 'readonly',
      cwd: '/tmp/fixture/checkout',
      harnessStateDirs: ['/tmp/fixture/agent-home/claude'],
      tmpDir: '/tmp/fixture/agent-home/tmp',
    });
    // Without this the checkout is simply GONE inside the sandbox and the
    // harness silently loses its credentials — not a denial, an absence.
    // The checkout is restored read-only; the harness state dir is not in
    // readOnly because it is already restored by its own writable bind.
    expect(plan.readOnly).toEqual(['/tmp/fixture/checkout']);
    expect(plan.writable).toEqual([
      '/tmp/fixture/agent-home/claude',
      '/tmp/fixture/agent-home/tmp',
    ]);
  });

  it('never re-binds read-only something the same session gets read-write', () => {
    const plan = sandboxMountPlan({
      mode: 'edit',
      cwd: '/tmp/fixture/corner',
      worktreePath: '/tmp/fixture/corner',
      gitCommonDir: '/tmp/fixture/repo/.git',
    });
    expect(plan.readOnly).toEqual([]);
    expect(plan.writable).toEqual(['/tmp/fixture/corner', '/tmp/fixture/repo/.git']);
  });

  it('leaves a session outside /tmp with no restore mounts at all', () => {
    expect(
      sandboxMountPlan({ mode: 'readonly', cwd: '/srv/repo', harnessStateDirs: ['/srv/state'] })
        .readOnly,
    ).toEqual([]);
  });
});

describe('bwrap argv construction', () => {
  it('builds the exact Room argv: harness state writable, the checkout not', () => {
    const { command, args } = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'readonly',
        cwd: '/srv/repo',
        harnessStateDirs: ['/srv/rooms/r1/agent-home/claude'],
        tmpDir: '/srv/rooms/r1/agent-home/tmp',
      },
      command: 'pi-acp',
      args: ['--flag'],
    });
    expect(command).toBe('/usr/bin/bwrap');
    expect(args).toEqual([
      ...ROOM_BASE,
      '--bind-try',
      '/srv/rooms/r1/agent-home/claude',
      '/srv/rooms/r1/agent-home/claude',
      '--bind-try',
      '/srv/rooms/r1/agent-home/tmp',
      '/srv/rooms/r1/agent-home/tmp',
      '--chdir',
      '/srv/repo',
      '--die-with-parent',
      '--',
      'pi-acp',
      '--flag',
    ]);
    // The Room's cwd is the canonical checkout and it is bound nowhere: it is
    // read-only by virtue of `--ro-bind / /` alone.
    expect(args).not.toContain('/srv/repo/');
    expect(args.filter((argument) => argument === '/srv/repo')).toEqual(['/srv/repo']);
    // Network is deliberately untouched: the harness has to reach its model API.
    expect(args).not.toContain('--unshare-net');
  });

  it('builds the exact corner argv, binding writable paths AFTER the tmpfs', () => {
    const { args } = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'edit',
        cwd: '/corners/c1',
        worktreePath: '/corners/c1',
        gitCommonDir: '/repos/abc/.git',
        protectedPaths: ['/corners', '/repos/abc', '/state/beeline'],
      },
      command: 'codex-acp',
    });
    expect(args).toEqual([
      ...CORNER_BASE,
      '--ro-bind',
      '/corners',
      '/corners',
      '--ro-bind',
      '/repos/abc',
      '/repos/abc',
      '--ro-bind',
      '/state/beeline',
      '/state/beeline',
      '--bind-try',
      '/corners/c1',
      '/corners/c1',
      '--bind-try',
      '/repos/abc/.git',
      '/repos/abc/.git',
      '--chdir',
      '/corners/c1',
      '--die-with-parent',
      '--',
      'codex-acp',
    ]);
    // bwrap applies operations in order, so a bind placed before `--tmpfs /tmp`
    // would be silently shadowed for any path under /tmp.
    expect(args.indexOf('--tmpfs')).toBeLessThan(args.indexOf('--bind-try'));
  });


  it("names only the configured harness's own $HOME state root", () => {
    expect(harnessHomeStateDirs('/usr/local/bin/pi-acp', '/home/op')).toEqual(['/home/op/.pi']);
    expect(harnessHomeStateDirs('codex-acp', '/home/op')).toEqual(['/home/op/.codex']);
    expect(harnessHomeStateDirs('claude-agent-acp', '/home/op')).toEqual(['/home/op/.claude']);
    expect(harnessHomeStateDirs('goose', '/home/op')).toEqual([
      '/home/op/.config/goose',
      '/home/op/.local/share/goose',
    ]);
    expect(harnessHomeStateDirs('/home/op/.grok/bin/grok', '/home/op')).toEqual(['/home/op/.grok']);
    // An unrecognised harness gets none, rather than four empty directories
    // created in the operator's home for harnesses this host does not run.
    expect(harnessHomeStateDirs('some-unknown-acp', '/home/op')).toEqual([]);
    expect(harnessHomeStateDirs(undefined, '/home/op')).toEqual([]);
  });

  it('leaves the command untouched when no bwrap path is configured', () => {
    expect(
      wrapAgentCommand({ spec: { mode: 'edit', cwd: '/w' }, command: 'pi-acp', args: ['--rpc'] }),
    ).toEqual({ command: 'pi-acp', args: ['--rpc'] });
  });

  it('puts the agent argv after `--` so a harness flag is never read by bwrap', () => {
    const { args } = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      plan: { readOnly: [], writable: [], masks: [] },
      cwd: '/w',
      command: 'pi',
      args: ['--ro-bind', '/etc', '/etc'],
    });
    const separator = args.indexOf('--');
    expect(args.slice(separator + 1)).toEqual(['pi', '--ro-bind', '/etc', '/etc']);
  });
});

describe('credential masks — readable is usable, so known stores are absent', () => {
  it('mounts the resolved Body-owned Trusty Squire store as an empty filesystem', () => {
    const store = trustySquireStorePath('/var/lib/beeline/squire-host-config');
    const masks = credentialMaskPaths([store], '/home/op', (path) =>
      path === store ? { isDirectory: true } : undefined,
    );
    const plan = sandboxMountPlan({ mode: 'readonly', cwd: '/srv/repo', maskPaths: masks });
    const { args } = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      plan,
      cwd: '/srv/repo',
      command: 'codex-acp',
    });
    const storeAt = args.indexOf(store);
    expect(plan.masks).toContainEqual({ path: store, kind: 'dir' });
    expect(args[storeAt - 1]).toBe('--tmpfs');
  });

  it('creates private mountpoints for required paths absent on the host', () => {
    const store = '/home/op/.config/trusty-squire';
    const bus = '/run/user/1000/bus';
    const masks = credentialMaskPaths([store, bus], '/home/op', () => undefined, [store, bus]);
    const { args } = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      plan: sandboxMountPlan({ mode: 'readonly', cwd: '/srv/repo', maskPaths: masks }),
      cwd: '/srv/repo',
      command: 'codex-acp',
    });
    for (const path of [store, bus]) {
      const mountAt = args.indexOf(path);
      expect(masks).toContainEqual({ path, kind: 'dir', create: true });
      expect(args.slice(mountAt - 1, mountAt + 3)).toEqual(['--dir', path, '--tmpfs', path]);
    }
  });

  it('masks the built-in known credential homes in BOTH modes', () => {
    for (const mode of ['readonly', 'edit'] as const) {
      const plan = sandboxMountPlan({
        mode,
        cwd: '/srv/repo',
        maskPaths: [
          { path: '/home/op/.config/gh', kind: 'dir' },
          { path: '/home/op/.ssh', kind: 'dir' },
          { path: '/home/op/.netrc', kind: 'file' },
        ],
      });
      expect(plan.masks.map((mask) => mask.path).sort()).toEqual([
        '/home/op/.config/gh',
        '/home/op/.netrc',
        '/home/op/.ssh',
      ]);
      // A masked path must not also be restored read-only or bound writable.
      expect(plan.readOnly).not.toContain('/home/op/.ssh');
      expect(plan.writable).not.toContain('/home/op/.ssh');
    }
  });

  it('emits dir masks as empty tmpfs and file masks as /dev/null, AFTER the ro-bind', () => {
    const { args } = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      plan: {
        readOnly: [],
        writable: [],
        masks: [
          { path: '/home/op/.config/gh', kind: 'dir' },
          { path: '/home/op/.netrc', kind: 'file' },
        ],
      },
      cwd: '/srv/repo',
      command: 'codex-acp',
    });
    // dir → empty tmpfs
    const gh = args.indexOf('/home/op/.config/gh');
    expect(args[gh - 1]).toBe('--tmpfs');
    // file → /dev/null bind (--ro-bind /dev/null <path>)
    const netrc = args.indexOf('/home/op/.netrc');
    expect(args.slice(netrc - 2, netrc)).toEqual(['--ro-bind', '/dev/null']);
    // Masks must come after the whole-home ro-bind they override.
    expect(gh).toBeGreaterThan(0);
    expect(args.slice(0, 4)).toEqual(['--unshare-pid', '--ro-bind', '/', '/']);
  });

  it('writable harness-state binds are emitted AFTER masks so they win on overlap', () => {
    const { args } = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'edit',
        cwd: '/corners/c1',
        worktreePath: '/corners/c1',
        maskPaths: [{ path: '/home/op/.no-mistakes', kind: 'dir' }],
      },
      command: 'codex-acp',
    });
    // Occurrences of the path: the mask (tmpfs), then the writable bind pair.
    const maskAt = args.indexOf('/home/op/.no-mistakes');
    const bindTryAt = args.indexOf('--bind-try');
    expect(bindTryAt).toBeGreaterThan(maskAt);
  });

  it('skips configured extras that do not exist, dedupes, and stats file vs dir', () => {
    const entries = credentialMaskPaths(
      ['/home/op/.secrets.env', '/home/op/.config/gh'],
      '/home/op',
      (path) => {
        if (path === '/home/op/.secrets.env') return { isDirectory: false };
        if (path === '/home/op/.config/gh') return { isDirectory: true };
        return undefined;
      },
    );
    expect(entries).toEqual([
      { path: '/home/op/.config/gh', kind: 'dir' },
      { path: '/home/op/.secrets.env', kind: 'file' },
    ]);
  });
});

describe('feature detection falls back rather than failing the daemon', () => {
  it('reports unavailable, not an error, when bwrap is not on PATH', () => {
    const result = detectBwrapSandbox({ env: { PATH: '/nonexistent' } });
    expect(result.path).toBeUndefined();
    expect(result.advisory).toMatch(/UNAVAILABLE/);
    expect(result.advisory).toMatch(/bubblewrap/);
  });

  it('reports unavailable when a present bwrap fails its self-test', () => {
    const calls: string[][] = [];
    const result = detectBwrapSandbox({
      env: { PATH: '/usr/bin' },
      run: (command, args) => {
        calls.push([command, ...args]);
        return { status: 1, stderr: 'bwrap: No permissions to creating new namespace' };
      },
    });
    // The probe is the real mount table, not `--version`: a bwrap that exists
    // but cannot unshare only fails when it tries.
    expect(calls[0]?.slice(1, 5)).toEqual(['--unshare-pid', '--ro-bind', '/', '/']);
    expect(result.path).toBeUndefined();
    expect(result.advisory).toMatch(/self-test failed/);
    expect(result.advisory).toMatch(/No permissions to creating new namespace/);
  });

  it('gives an AppArmor-specific recovery without disabling the host-wide guard', () => {
    const result = detectBwrapSandbox({
      env: { PATH: '/usr/bin' },
      run: () => ({
        status: 1,
        stderr:
          'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.',
      }),
    });
    expect(result.path).toBeUndefined();
    expect(result.advisory).toMatch(/Ubuntu AppArmor may be blocking/);
    expect(result.advisory).toMatch(/Keep the system-wide restriction enabled/);
    expect(result.advisory).toMatch(/apps\/body\/README\.md/);
  });

  it('honours the runtime.json off-switch without probing at all', () => {
    let probed = false;
    const result = detectBwrapSandbox({
      policy: 'off',
      env: { PATH: '/usr/bin' },
      run: () => {
        probed = true;
        return { status: 0 };
      },
    });
    expect(probed).toBe(false);
    expect(result.path).toBeUndefined();
    expect(result.advisory).toMatch(/DISABLED by configuration/);
  });

  it('lets BUZZY_BODY_SANDBOX override the persisted policy in both directions', () => {
    expect(
      detectBwrapSandbox({ policy: 'bwrap', env: { PATH: '/usr/bin', BUZZY_BODY_SANDBOX: 'off' } })
        .advisory,
    ).toMatch(/DISABLED by configuration/);
    expect(
      detectBwrapSandbox({
        policy: 'off',
        env: { PATH: '/nonexistent', BUZZY_BODY_SANDBOX: 'bwrap' },
      }).advisory,
    ).toMatch(/UNAVAILABLE/);
  });

  it('validates the persisted policy value', () => {
    expect(isSandboxPolicy('bwrap')).toBe(true);
    expect(isSandboxPolicy('off')).toBe(true);
    expect(isSandboxPolicy('on')).toBe(false);
    expect(isSandboxPolicy(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live proof against this host's real bubblewrap.
// ---------------------------------------------------------------------------

const bwrap = detectBwrapSandbox();
const liveDescribe = bwrap.path ? describe : describe.skip;

liveDescribe('the wrapper enforces Room read-only and the corner hygiene denylist', () => {
  let root: string;
  let checkout: string;
  let worktree: string;
  const homeProbe = resolve(homedir(), '.beeline-sandbox-proof-corner-writable');
  let siblingCorner: string;

  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), 'bwrap-proof-'));
    checkout = resolve(root, 'checkout');
    worktree = resolve(root, 'corners/current');
    siblingCorner = resolve(root, 'corners/sibling');
    spawnSync('mkdir', ['-p', checkout, worktree, siblingCorner]);
    writeFileSync(resolve(checkout, 'README.md'), 'canonical\n');
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (existsSync(homeProbe)) rmSync(homeProbe, { force: true });
  });

  const runWrapped = (spec: Parameters<typeof wrapAgentCommand>[0]['spec'], script: string) => {
    const wrapped = wrapAgentCommand({
      bwrapPath: bwrap.path!,
      spec,
      command: '/bin/sh',
      args: ['-c', script],
    });
    return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  };

  it('a Room can read the checkout but cannot write it, $HOME, or anywhere else', () => {
    const spec = { mode: 'readonly' as const, cwd: checkout };
    expect(runWrapped(spec, 'cat README.md').stdout.trim()).toBe('canonical');

    const writeCheckout = runWrapped(spec, 'touch ./evil.txt');
    expect(writeCheckout.status).not.toBe(0);
    expect(writeCheckout.stderr).toMatch(/Read-only file system/);
    expect(existsSync(resolve(checkout, 'evil.txt'))).toBe(false);

    // The confirmed pi breach wrote to an absolute path in the operator's real
    // home while its cwd was correctly the checkout, so that is the exact shape
    // asserted here — against the real $HOME, not a fixture standing in for it.
    const writeHome = runWrapped(spec, `touch ${JSON.stringify(homeProbe)}`);
    expect(writeHome.status).not.toBe(0);
    expect(writeHome.stderr).toMatch(/Read-only file system/);
    expect(existsSync(homeProbe)).toBe(false);

    // The private /tmp is the one writable surface, and it is discarded.
    expect(runWrapped(spec, 'touch /tmp/scratch && echo ok').stdout.trim()).toBe('ok');
  });

  it('keeps stores and session sockets created after activation outside the namespace', async () => {
    const hostConfig = resolve(root, 'late-config');
    const runtimeDir = resolve(root, 'late-run');
    const store = resolve(hostConfig, 'trusty-squire');
    const bus = resolve(runtimeDir, 'bus');
    mkdirSync(hostConfig, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    const masks = credentialMaskPaths([store, bus], root, undefined, [store, bus]);
    const wrapped = wrapAgentCommand({
      bwrapPath: bwrap.path!,
      spec: { mode: 'readonly', cwd: checkout, maskPaths: masks },
      command: '/bin/sh',
      args: [
        '-c',
        `echo ready; read signal; test ! -e ${JSON.stringify(resolve(store, 'session.json'))}; test ! -S ${JSON.stringify(bus)}; echo isolated`,
      ],
    });
    const child = spawn(wrapped.command, wrapped.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let readySeen = false;
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    });
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('ready\n')) {
          readySeen = true;
          resolveReady();
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', rejectReady);
      child.once('exit', (status) => {
        if (!readySeen) rejectReady(new Error(`bubblewrap exited ${status}: ${stderr}`));
      });
    });
    await ready;
    mkdirSync(store, { recursive: true });
    writeFileSync(resolve(store, 'session.json'), 'host-secret');
    const busServer = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      busServer.once('error', rejectListen);
      busServer.listen(bus, resolveListen);
    });
    try {
      child.stdin.end('continue\n');
      const status = await exited;
      expect(status).toBe(0);
      expect(stdout).toContain('isolated\n');
      expect(readFileSync(resolve(store, 'session.json'), 'utf8')).toBe('host-secret');
    } finally {
      await new Promise<void>((resolveClose) => busServer.close(() => resolveClose()));
    }
  });

  it('a corner writes generally but cannot write protected checkouts or sibling corners', () => {
    const spec = {
      mode: 'edit' as const,
      cwd: worktree,
      worktreePath: worktree,
      protectedPaths: [checkout, resolve(root, 'corners')],
    };
    expect(runWrapped(spec, 'touch ./work.txt && echo ok').stdout.trim()).toBe('ok');
    expect(existsSync(resolve(worktree, 'work.txt'))).toBe(true);

    const writeHome = runWrapped(spec, `touch ${JSON.stringify(homeProbe)} && echo ok`);
    expect(writeHome.stdout.trim()).toBe('ok');
    expect(existsSync(homeProbe)).toBe(true);

    const escapeCheckout = runWrapped(
      spec,
      `touch ${JSON.stringify(resolve(checkout, 'evil.txt'))}`,
    );
    expect(escapeCheckout.status).not.toBe(0);
    expect(existsSync(resolve(checkout, 'evil.txt'))).toBe(false);

    const escapeSibling = runWrapped(
      spec,
      `touch ${JSON.stringify(resolve(siblingCorner, 'evil.txt'))}`,
    );
    expect(escapeSibling.status).not.toBe(0);
    expect(existsSync(resolve(siblingCorner, 'evil.txt'))).toBe(false);
  });

  it('a corner can commit, because its git common directory is writable', async () => {
    const repo = resolve(root, 'gitrepo');
    spawnSync('git', ['init', '-q', '-b', 'main', repo]);
    spawnSync('git', ['-C', repo, 'config', 'user.email', 'proof@example.com']);
    spawnSync('git', ['-C', repo, 'config', 'user.name', 'proof']);
    writeFileSync(resolve(repo, 'a.txt'), 'a\n');
    spawnSync('git', ['-C', repo, 'add', '.']);
    spawnSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    const linked = resolve(root, 'linked');
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feature', linked]);

    const gitCommonDir = await resolveGitCommonDir(linked);
    expect(gitCommonDir).toBe(resolve(repo, '.git'));

    const committed = runWrapped(
      {
        mode: 'edit',
        cwd: linked,
        worktreePath: linked,
        gitCommonDir,
        protectedPaths: [repo],
      },
      'echo b > b.txt && git add b.txt && git commit -qm proof && git rev-parse --short HEAD',
    );
    expect(committed.stderr).toBe('');
    expect(committed.status).toBe(0);

    // …and the same corner without the git bind cannot, which is why that mount
    // is part of the table rather than an optimisation.
    const denied = runWrapped(
      { mode: 'edit', cwd: linked, worktreePath: linked, protectedPaths: [repo] },
      'echo c > c.txt && git add c.txt && git commit -qm nope',
    );
    expect(denied.status).not.toBe(0);
  });
});
