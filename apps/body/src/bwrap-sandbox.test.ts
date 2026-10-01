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
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AcpClient } from './acp.js';
import {
  BUBBLEWRAP_INSTALL_FIX,
  BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER,
  buildBwrapArgv,
  credentialMaskPaths,
  detectBwrapSandbox,
  ensureBwrapSandbox,
  grantedSandboxDevices,
  isSandboxPolicy,
  harnessHomeStateDirs,
  sandboxMountPlan,
  siblingAgentMaskPaths,
  wrapAgentCommand,
} from './bwrap-sandbox.js';
import { trustySquireStorePath } from './trusty-squire-storage.js';
import { grantedSquireHostBindPaths } from './agent-home.js';
import { ensureSquireHostDir, squireFacadeLaunch } from './squire-host.js';
import { startFakeMcpBroker, stopFakeMcpBroker } from './squire-broker-link.test-support.js';

const ROOM_BASE = [
  '--unshare-pid',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--dev-bind-try',
  '/dev/kvm',
  '/dev/kvm',
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
  '--dev-bind-try',
  '/dev/kvm',
  '/dev/kvm',
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

  it('binds the host Trusty Squire directory read-write when a host route is granted', () => {
    const plan = sandboxMountPlan({
      mode: 'readonly',
      cwd: '/srv/beeline/repositories/abc',
      harnessStateDirs: ['/srv/beeline/rooms/r1/agent-home/claude'],
      additionalWritablePaths: [
        '/srv/beeline/agents/pk/rooms/r1/agent-home',
        '/home/op/.trusty-squire',
      ],
    });
    expect(plan.writable).toContain('/home/op/.trusty-squire');
  });

  it('gives a Room its attach-scratch root a writable bind too, not just harness state', () => {
    // The attach scratch root (BEELINE_ATTACH_SCRATCH_ROOT, normally the
    // per-Room agent-home dir) is where `write_scratch_file` writes so
    // `post_artifact` has something to send — it is not itself harness state,
    // so it must be threaded through `additionalWritablePaths`.
    const plan = sandboxMountPlan({
      mode: 'readonly',
      cwd: '/srv/beeline/repositories/abc',
      harnessStateDirs: ['/srv/beeline/rooms/r1/agent-home/claude'],
      additionalWritablePaths: ['/srv/beeline/agents/pk/rooms/r1/agent-home'],
    });
    expect(plan.writable).toEqual([
      '/srv/beeline/agents/pk/rooms/r1/agent-home',
      '/srv/beeline/rooms/r1/agent-home/claude',
    ]);
  });

  it('binds the Room attach-scratch root read-write in the generated bwrap argv', () => {
    const wrapped = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'readonly',
        cwd: '/srv/beeline/repositories/abc',
        additionalWritablePaths: ['/srv/beeline/agents/pk/rooms/r1/agent-home'],
      },
      command: '/fake-agent',
      args: [],
    });
    const index = wrapped.args.findIndex(
      (arg, i) =>
        arg === '--bind-try' &&
        wrapped.args[i + 1] === '/srv/beeline/agents/pk/rooms/r1/agent-home',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(wrapped.args[index + 2]).toBe('/srv/beeline/agents/pk/rooms/r1/agent-home');
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

  it('binds approved device grants into the private /dev after /dev/kvm', () => {
    const { args } = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: { mode: 'edit', cwd: '/w', devices: ['/dev/bus/usb', '/dev/kvm'] },
      command: 'codex-acp',
    });
    expect(args.slice(0, CORNER_BASE.length + 3)).toEqual([
      ...CORNER_BASE.slice(0, CORNER_BASE.indexOf('--proc')),
      '--dev-bind-try',
      '/dev/bus/usb',
      '/dev/bus/usb',
      ...CORNER_BASE.slice(CORNER_BASE.indexOf('--proc')),
    ]);
    expect(args.filter((argument) => argument === '--dev-bind-try')).toHaveLength(2);
  });

  it('mounts only approved device grants under /dev/', () => {
    expect(
      grantedSandboxDevices({
        grants: [
          { kind: 'device', target: '/dev/bus/usb', status: 'approved' },
          { kind: 'device', target: ' /dev/ttyUSB0 ', status: 'once' },
          { kind: 'device', target: '/dev/video0', status: 'pending' },
          { kind: 'device', target: '/dev/sdb', status: 'denied' },
          { kind: 'device', target: '/dev/../etc/shadow', status: 'approved' },
          { kind: 'device', target: '/home/op/.ssh', status: 'approved' },
          { kind: 'device', target: 'dev/kvm', status: 'approved' },
          { kind: 'device', target: '/dev/', status: 'approved' },
          { kind: 'path', target: '/dev/kvm', status: 'approved' },
          { kind: 'device', target: '/dev/bus/usb', status: 'approved' },
        ],
      }),
    ).toEqual(['/dev/bus/usb', '/dev/ttyUSB0']);
    expect(grantedSandboxDevices(undefined)).toEqual([]);
    expect(grantedSandboxDevices({ grants: 'nope' })).toEqual([]);
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
    expect(harnessHomeStateDirs('/home/op/.cursor/bin/cursor-agent-acp', '/home/op')).toEqual([
      '/home/op/.cursor',
    ]);
    expect(harnessHomeStateDirs('cursor-acp-bridge', '/home/op')).toEqual(['/home/op/.cursor']);
    expect(harnessHomeStateDirs('opencode', '/home/op')).toEqual([
      '/home/op/.local/share/opencode',
      '/home/op/.config/opencode',
    ]);
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
    const store = '/home/op/.gnupg';
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

  it('leaves MCP session directories off the known mask so they stay reachable', () => {
    const session = '/home/op/.config/trusty-squire';
    const masks = credentialMaskPaths(undefined, '/home/op', (path) => {
      if (
        path === '/home/op/.netrc' ||
        path === '/home/op/.git-credentials' ||
        path === '/home/op/.secrets.env'
      ) {
        return { isDirectory: false };
      }
      return { isDirectory: true };
    });
    expect(masks.map((mask) => mask.path)).not.toContain(session);
    expect(masks.map((mask) => mask.path)).toEqual(
      expect.arrayContaining(['/home/op/.config/gh', '/home/op/.ssh']),
    );
  });
});

describe('sibling agent masks — same Unix account, so file modes cannot isolate agents alone', () => {
  it('masks every other agent directory under the same agents root, sorted', () => {
    const masks = siblingAgentMaskPaths('/state/beeline/agents/aaa', (root) => {
      expect(root).toBe('/state/beeline/agents');
      return ['aaa', 'bbb', 'ccc'];
    });
    expect(masks).toEqual([
      { path: '/state/beeline/agents/bbb', kind: 'dir' },
      { path: '/state/beeline/agents/ccc', kind: 'dir' },
    ]);
  });

  it('never masks its own directory, case-insensitively', () => {
    const masks = siblingAgentMaskPaths('/state/beeline/agents/AAA', () => ['aaa', 'AAA', 'bbb']);
    expect(masks.map((mask) => mask.path)).not.toContain('/state/beeline/agents/AAA');
    expect(masks.map((mask) => mask.path)).not.toContain('/state/beeline/agents/aaa');
    expect(masks.map((mask) => mask.path)).toEqual(['/state/beeline/agents/bbb']);
  });

  it('degrades to no masks when the agents root does not exist (default lister)', () => {
    const masks = siblingAgentMaskPaths('/does/not/exist/beeline/agents/aaa');
    expect(masks).toEqual([]);
  });

  it('lists the real agents root by default when no lister is injected', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sibling-agents-'));
    const own = resolve(root, 'aaa');
    const sibling = resolve(root, 'bbb');
    mkdirSync(own, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(resolve(root, 'not-a-dir'), 'x');
    try {
      const masks = siblingAgentMaskPaths(own);
      expect(masks).toEqual([{ path: sibling, kind: 'dir' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
          'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.',
      }),
    });
    expect(result.path).toBeUndefined();
    expect(result.advisory).toMatch(/Ubuntu AppArmor may be blocking/);
    expect(result.advisory).toMatch(/reinstall the Beeline user unit/);
    expect(result.advisory).toMatch(/transitions to unconfined/);
  });

  it('reports a status-only self-test failure instead of an empty reason', () => {
    const result = detectBwrapSandbox({
      env: { PATH: '/usr/bin' },
      run: () => ({ status: 23, stderr: '' }),
    });
    expect(result.advisory).toContain('self-test failed (exit 23)');
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

  /**
   * A Room shell is approved only inside this sandbox, so a host that is simply
   * missing the package is worth one install attempt rather than a helper that
   * quietly has no shell. Detection after the attempt is the verdict, never the
   * installer's own exit code.
   */
  describe('bubblewrap on first need', () => {
    const missing = { advisory: 'UNAVAILABLE: bwrap (bubblewrap) is not on PATH' };
    const usable = { path: '/usr/bin/bwrap', advisory: 'ENABLED' };

    /**
     * apt losing the lists lock to another apt process, verbatim: three lines
     * whose LAST one never says "could not get lock", which is why the verdict is
     * read from the whole output.
     */
    const APT_LISTS_LOCK_HELD = [
      'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 4711 (apt-get)',
      'N: Be aware that removing the lock file is not a solution and may break your system.',
      'E: Unable to lock directory /var/lib/apt/lists/',
    ].join('\n');

    /**
     * Hermetic: a PATH holding an `apt-get` and no `bwrap`, so the verdict does
     * not depend on what this host happens to have installed. The runner is
     * always stubbed, so nothing on this PATH is ever executed.
     */
    function hostPath(executables: string[]): {
      env: NodeJS.ProcessEnv;
      dir: string;
      install: (name: string) => void;
      cleanup: () => void;
    } {
      const dir = mkdtempSync(resolve(tmpdir(), 'beeline-bwrap-host-'));
      const install = (name: string) =>
        writeFileSync(resolve(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      for (const name of executables) install(name);
      return {
        env: { PATH: dir, BEELINE_HARNESS_PATH_AUGMENT: '0' },
        dir,
        install,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    }

    /** The helper's own runtime directory, where the failure marker lives. */
    function stateDir(): { path: string; markedAt: () => number | undefined; cleanup: () => void } {
      const dir = mkdtempSync(resolve(tmpdir(), 'beeline-bwrap-state-'));
      return {
        path: dir,
        markedAt: () => {
          try {
            return Number.parseInt(
              readFileSync(resolve(dir, 'bubblewrap-install-failed'), 'utf8').trim(),
              10,
            );
          } catch {
            return undefined;
          }
        },
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    }

    it('refreshes the package list, installs, then re-runs the real self-test', async () => {
      const host = hostPath(['apt-get']);
      try {
        const commands: string[][] = [];
        let detections = 0;
        let extended = 0;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          beforeInstall: () => {
            extended += 1;
          },
          detect: () => {
            detections += 1;
            return detections === 1 ? missing : usable;
          },
          run: async (command, args) => {
            commands.push([command, ...args]);
            return { code: 0, output: '' };
          },
        });
        // A stale cache answers "Unable to locate package" on every start, so
        // the refresh is part of the attempt, not an optimisation.
        expect(commands).toEqual([
          ['sudo', '-n', 'apt-get', 'update'],
          ['sudo', '-n', 'apt-get', 'install', '-y', 'bubblewrap'],
        ]);
        // The caller owns the deadline this spend comes out of, and pays only
        // when a package command really runs.
        expect(extended).toBe(1);
        expect(detections).toBe(2);
        expect(result.path).toBe('/usr/bin/bwrap');
        expect(result.shellDetail).toBeUndefined();
      } finally {
        host.cleanup();
      }
    });

    /**
     * The runner reports a SIGTERM at the timeout and a maxBuffer overflow as
     * failures whatever dpkg actually did, so a completed install must not be
     * thrown away: detection always runs again and its verdict wins.
     */
    it('accepts an install the runner reported as failed when bwrap now works', async () => {
      const host = hostPath(['apt-get']);
      try {
        let detections = 0;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          detect: () => {
            detections += 1;
            return detections === 1 ? missing : usable;
          },
          run: async (command, args) =>
            args.includes('install')
              ? { code: null, output: 'Command failed: killed' }
              : { code: 0, output: '' },
        });
        expect(detections).toBe(2);
        expect(result.path).toBe('/usr/bin/bwrap');
      } finally {
        host.cleanup();
      }
    });

    /**
     * An install that exits 0 leaves two different states, and the sentence the
     * model is told to relay into a Room has to name the one that happened.
     */
    it('names the reason the install left behind, not always a failed self-test', async () => {
      const absent = hostPath(['apt-get']);
      try {
        const result = await ensureBwrapSandbox({
          env: absent.env,
          platform: 'linux',
          detect: () => missing,
          run: async () => ({ code: 0, output: '' }),
        });
        expect(result.path).toBeUndefined();
        expect(result.shellDetail).toContain('bubblewrap is not installed');
        expect(result.shellDetail).toContain(BUBBLEWRAP_INSTALL_FIX);
      } finally {
        absent.cleanup();
      }

      const landed = hostPath(['apt-get']);
      try {
        const result = await ensureBwrapSandbox({
          env: landed.env,
          platform: 'linux',
          detect: () => ({ advisory: 'UNAVAILABLE: /usr/bin/bwrap self-test failed (exit 1)' }),
          run: async (command, args) => {
            if (args.includes('install')) landed.install('bwrap');
            return { code: 0, output: '' };
          },
        });
        expect(result.path).toBeUndefined();
        expect(result.shellDetail).toContain('failed its start-up self-test');
      } finally {
        landed.cleanup();
      }
    });

    it('reports the failure and the one-line fix when it cannot install', async () => {
      const host = hostPath(['apt-get']);
      try {
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          detect: () => missing,
          run: async (command, args) =>
            args.includes('install')
              ? { code: 1, output: 'sudo: a password is required' }
              : { code: 0, output: '' },
        });
        expect(result.path).toBeUndefined();
        expect(result.advisory).toContain('sudo: a password is required');
        expect(result.advisory).toContain(BUBBLEWRAP_INSTALL_FIX);
        expect(result.advisory).toContain('A Room shell stays refused');
        // The prompt sentence carries the fix and nothing the operator advisory
        // says about this host: it is relayed into a Room.
        expect(result.shellDetail).toContain(BUBBLEWRAP_INSTALL_FIX);
        expect(result.shellDetail).not.toContain('sudo: a password is required');
        expect(result.shellDetail).not.toContain('permission handler');
      } finally {
        host.cleanup();
      }
    });

    /**
     * One unreachable third-party repo exits `apt-get update` non-zero on a host
     * where bubblewrap installs fine from the base archive, so the refresh is a
     * courtesy and only the install's own result is the verdict.
     */
    it('installs anyway when the index refresh fails', async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        const commands: string[][] = [];
        let detections = 0;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          detect: () => {
            detections += 1;
            return detections === 1 ? missing : usable;
          },
          run: async (command, args) => {
            commands.push([command, ...args]);
            return args.includes('update')
              ? { code: 100, output: 'E: Some index files failed to download' }
              : { code: 0, output: '' };
          },
        });
        expect(commands).toEqual([
          ['sudo', '-n', 'apt-get', 'update'],
          ['sudo', '-n', 'apt-get', 'install', '-y', 'bubblewrap'],
        ]);
        expect(result.path).toBe('/usr/bin/bwrap');
        expect(state.markedAt()).toBeUndefined();
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    it('arms the day-long skip on the install, never on the refresh', async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 7_000,
          detect: () => missing,
          run: async (command, args) =>
            args.includes('update')
              ? { code: 100, output: 'E: Some index files failed to download' }
              : { code: 100, output: 'E: Unable to locate package bubblewrap' },
        });
        expect(result.path).toBeUndefined();
        // The reason a person reads is the install's, not the refresh's.
        expect(result.advisory).toContain('Unable to locate package');
        expect(result.advisory).not.toContain('index files');
        expect(state.markedAt()).toBe(7_000);
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    it('names an unsupported host instead of prescribing a command it cannot run', async () => {
      const host = hostPath([]);
      try {
        let ran = false;
        let extended = 0;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          detect: () => missing,
          beforeInstall: () => {
            extended += 1;
          },
          run: async () => {
            ran = true;
            return { code: 0, output: '' };
          },
        });
        expect(ran).toBe(false);
        // Nothing is going to run, so the caller is not asked for more deadline.
        expect(extended).toBe(0);
        expect(result.advisory).toContain('no apt-get');
        // Naming the absent package manager and then prescribing it is the one
        // thing this branch exists to avoid.
        expect(result.advisory).toContain(BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER);
        expect(result.advisory).not.toContain(BUBBLEWRAP_INSTALL_FIX);
        expect(result.shellDetail).toContain(BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER);
        expect(result.shellDetail).not.toContain('apt-get');
      } finally {
        host.cleanup();
      }
    });

    it('installs nothing when the operator turned the sandbox off', async () => {
      const host = hostPath(['apt-get']);
      try {
        let ran = false;
        const result = await ensureBwrapSandbox({
          policy: 'off',
          env: host.env,
          platform: 'linux',
          detect: () => ({ advisory: 'DISABLED by configuration (sandbox=off)' }),
          run: async () => {
            ran = true;
            return { code: 0, output: '' };
          },
        });
        expect(ran).toBe(false);
        expect(result.path).toBeUndefined();
        expect(result.advisory).toContain('DISABLED by configuration');
        expect(result.shellDetail).toContain('turned off by its operator');
      } finally {
        host.cleanup();
      }
    });

    it('installs nothing when bwrap is present but failed its self-test', async () => {
      const host = hostPath(['bwrap', 'apt-get']);
      try {
        let ran = false;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          detect: () => ({ advisory: 'UNAVAILABLE: self-test failed (exit 1)' }),
          run: async () => {
            ran = true;
            return { code: 0, output: '' };
          },
        });
        expect(ran).toBe(false);
        expect(result.advisory).toContain('self-test failed');
        expect(result.advisory).not.toContain(BUBBLEWRAP_INSTALL_FIX);
        expect(result.shellDetail).toContain('failed its start-up self-test');
      } finally {
        host.cleanup();
      }
    });

    it('skips the install on a platform the package does not serve', async () => {
      const host = hostPath(['apt-get']);
      try {
        let extended = 0;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'darwin',
          detect: () => missing,
          beforeInstall: () => {
            extended += 1;
          },
          run: async () => ({ code: 0, output: '' }),
        });
        expect(result.path).toBeUndefined();
        expect(extended).toBe(0);
        expect(result.advisory).toContain('Linux only');
      } finally {
        host.cleanup();
      }
    });

    /**
     * A host where bubblewrap is unobtainable would otherwise pay a full
     * `apt-get update` + install before READY on every `Restart=always` bounce.
     */
    it('remembers a failed attempt for a day and skips the package commands', async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        const first = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 5_000_000,
          detect: () => missing,
          run: async () => ({ code: 100, output: 'E: Unable to locate package bubblewrap' }),
        });
        expect(first.path).toBeUndefined();
        expect(state.markedAt()).toBe(5_000_000);

        let ran = false;
        let extended = 0;
        const second = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 5_000_000 + 60 * 60_000,
          beforeInstall: () => {
            extended += 1;
          },
          detect: () => missing,
          run: async () => {
            ran = true;
            return { code: 0, output: '' };
          },
        });
        expect(ran).toBe(false);
        expect(extended).toBe(0);
        expect(second.path).toBeUndefined();
        expect(second.advisory).toContain('did not retry');
        expect(second.shellDetail).toContain(BUBBLEWRAP_INSTALL_FIX);
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    it('retries once the remembered failure is a day old, and forgets it on success', async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        writeFileSync(resolve(state.path, 'bubblewrap-install-failed'), '1000\n', 'utf8');
        const commands: string[][] = [];
        let detections = 0;
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 1000 + 25 * 60 * 60_000,
          detect: () => {
            detections += 1;
            return detections === 1 ? missing : usable;
          },
          run: async (command, args) => {
            commands.push([command, ...args]);
            return { code: 0, output: '' };
          },
        });
        expect(commands).toEqual([
          ['sudo', '-n', 'apt-get', 'update'],
          ['sudo', '-n', 'apt-get', 'install', '-y', 'bubblewrap'],
        ]);
        expect(result.path).toBe('/usr/bin/bwrap');
        expect(state.markedAt()).toBeUndefined();
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    /**
     * The marker is consulted only AFTER detection, so an operator who installs
     * the package by hand is not made to wait out somebody else's failure.
     */
    it('adopts a bwrap that appeared since the failure, marker or not', async () => {
      const host = hostPath(['apt-get', 'bwrap']);
      const state = stateDir();
      try {
        writeFileSync(resolve(state.path, 'bubblewrap-install-failed'), '9000\n', 'utf8');
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 9_001,
          detect: () => usable,
          run: async () => {
            throw new Error('must not install');
          },
        });
        expect(result.path).toBe('/usr/bin/bwrap');
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    /**
     * A sibling helper that won the package-manager lock leaves a `bwrap` this
     * one adopts on its next start, because detection runs before the marker is
     * ever read — no waiting on a sibling, and no day-long lockout either.
     */
    it("adopts a sibling's install on the next start after losing the lock", async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        const lost = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 4_000,
          detect: () => missing,
          run: async () => ({ code: 100, output: APT_LISTS_LOCK_HELD }),
        });
        expect(lost.path).toBeUndefined();

        host.install('bwrap');
        let ran = false;
        const next = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 5_000,
          detect: () => usable,
          run: async () => {
            ran = true;
            return { code: 0, output: '' };
          },
        });
        expect(next.path).toBe('/usr/bin/bwrap');
        // No package command, and the earlier failure's marker had no say in it:
        // detection runs before the marker is ever read.
        expect(ran).toBe(false);
        expect(state.markedAt()).toBe(4_000);
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    /**
     * An install that exits 0 without leaving `bwrap` on this unit's PATH is the
     * one state the marker exists to bound: unmarked, it runs apt again before
     * READY on every restart, forever.
     */
    it('remembers an install that exited 0 and left no bwrap behind', async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 8_000,
          detect: () => missing,
          run: async () => ({ code: 0, output: '' }),
        });
        expect(result.path).toBeUndefined();
        expect(result.shellDetail).toContain('bubblewrap is not installed');
        expect(state.markedAt()).toBe(8_000);
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    /**
     * A `bwrap` that landed and cannot unshare is not a missing package, so it
     * keeps no marker: the cheap present-but-failed early return serves every
     * later start without running apt at all.
     */
    it('keeps no marker when the installed bwrap fails its self-test', async () => {
      const host = hostPath(['apt-get']);
      const state = stateDir();
      try {
        const result = await ensureBwrapSandbox({
          env: host.env,
          platform: 'linux',
          stateDir: state.path,
          now: () => 9_000,
          detect: () => ({ advisory: 'UNAVAILABLE: /usr/bin/bwrap self-test failed (exit 1)' }),
          run: async (command, args) => {
            if (args.includes('install')) host.install('bwrap');
            return { code: 0, output: '' };
          },
        });
        expect(result.path).toBeUndefined();
        expect(result.shellDetail).toContain('failed its start-up self-test');
        expect(state.markedAt()).toBeUndefined();
      } finally {
        state.cleanup();
        host.cleanup();
      }
    });

    it('returns the detected sandbox untouched when the host already has one', async () => {
      const result = await ensureBwrapSandbox({
        detect: () => usable,
        run: async () => {
          throw new Error('must not install');
        },
      });
      expect(result).toEqual(usable);
    });
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

  it('a full-access codex Room that never asks still cannot write: the kernel refuses, not the prompt', async () => {
    // Under bwrap a codex Room selects `agent-full-access` (`roomModeCandidates`),
    // so codex-acp stops sending session/request_permission. This fake codex
    // runs the write DIRECTLY on prompt, never asking, exactly like a
    // full-access harness — and the write must still die at the read-only
    // filesystem. The Room callback (reject anything that is not a mounted MCP
    // tool) stays wired but must never be the layer that held the rule here.
    // Inside the checkout: the host /tmp is hidden behind the private one.
    const fakeCodex = resolve(checkout, 'codex-acp.mjs');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's', modes: {
      currentModeId: 'read-only',
      availableModes: [{ id: 'read-only' }, { id: 'agent' }, { id: 'agent-full-access' }],
    } } });
  } else if (message.method === 'session/set_mode') {
    if (message.params.modeId !== 'agent-full-access') process.exit(71);
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    const touch = spawnSync('touch', ['./evil.txt'], { encoding: 'utf8' });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'exit=' + touch.status + ' ' + touch.stderr.trim() },
    } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
      { mode: 0o755 },
    );
    const wrapped = wrapAgentCommand({
      bwrapPath: bwrap.path!,
      spec: { mode: 'readonly', cwd: checkout },
      command: process.execPath,
      args: [fakeCodex],
    });
    let permissionRequests = 0;
    const client = new AcpClient({
      agentCommand: wrapped.command,
      agentArgs: wrapped.args,
      agentLabel: fakeCodex,
      agentEnv: {},
      agentCwd: checkout,
      osSandbox: true,
      autoApprovePermissions: false,
      permissionAllowlist: () => {
        permissionRequests += 1;
        return false;
      },
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: checkout, mode: 'readonly' });
      const result = await client.sessionPrompt(sessionId, 'write evil.txt', 20_000);
      expect(result.agentText).toMatch(/Read-only file system/);
      expect(result.agentText).not.toMatch(/exit=0/);
    } finally {
      await client.stop();
    }
    expect(permissionRequests).toBe(0);
    expect(existsSync(resolve(checkout, 'evil.txt'))).toBe(false);
  });

  it('keeps stores and session sockets created after activation outside the namespace', async () => {
    const hostConfig = resolve(root, 'late-config');
    const runtimeDir = resolve(root, 'late-run');
    const store = resolve(hostConfig, 'late-store');
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

  it('a granted Squire façade reaches the one host broker; an ungranted grant reaches nothing', async () => {
    const operatorHome = resolve(checkout, 'squire-operator');
    const sessionDir = resolve(operatorHome, '.config/trusty-squire');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, 'session.json'), '{"paired":true}\n');
    const paths = ensureSquireHostDir(operatorHome);
    const ledger = resolve(paths.dir, 'brokers.jsonl');
    // Squire's own server, as far as electing goes: it binds the socket it was
    // handed and says whether it became the daemon or found one already there.
    const shimDir = resolve(checkout, 'squire-bin');
    mkdirSync(shimDir, { recursive: true });
    const shim = resolve(shimDir, 'npx');
    writeFileSync(
      shim,
      `#!${process.execPath}
'use strict';
const fs = require('fs');
const net = require('net');
const socket = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
const record = (outcome) =>
  fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ outcome, socket }) + '\\n');
const server = net.createServer();
server.once('error', () => {
  record('connected');
  process.exit(0);
});
server.listen(socket, () => {
  record('elected');
  server.close(() => process.exit(0));
});
`,
      { mode: 0o755 },
    );
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(paths.brokerSocket, resolveListen);
    });
    const wrapFacade = (granted: readonly string[]) => {
      const launch = squireFacadeLaunch(operatorHome, { agentId: 'agent-a', roomId: 'room-a' });
      const wrapped = wrapAgentCommand({
        bwrapPath: bwrap.path!,
        spec: {
          mode: 'readonly' as const,
          cwd: checkout,
          additionalWritablePaths: grantedSquireHostBindPaths({
            operatorHome,
            grantedHostRoutes: granted,
          }),
          maskPaths: credentialMaskPaths(undefined, operatorHome),
        },
        command: launch.command,
        args: launch.args,
      });
      const env = {
        ...launch.env,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        HOME: operatorHome,
      };
      return { command: wrapped.command, args: wrapped.args, env };
    };
    const runFacade = (granted: readonly string[]) => {
      const wrapped = wrapFacade(granted);
      return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env: wrapped.env });
    };
    /** Real round-trip through the sandboxed façade's connect-only relay,
     * over its shared MCP socket — `spawnSync` closes stdin the instant its
     * whole `input` is written, which races ahead of the façade's async
     * socket connect, so this keeps stdin open like a real harness does. */
    const runFacadeInteractive = async (granted: readonly string[]): Promise<number | null> => {
      const wrapped = wrapFacade(granted);
      const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ['pipe', 'pipe', 'ignore'] });
      const readLine = async (): Promise<Record<string, unknown>> =>
        await new Promise((resolveLine) => {
          let buffer = Buffer.alloc(0);
          const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf(10);
            if (end < 0) return;
            child.stdout.off('data', onData);
            resolveLine(JSON.parse(buffer.subarray(0, end).toString('utf8')) as Record<string, unknown>);
          };
          child.stdout.on('data', onData);
        });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      const initReply = await readLine();
      expect((initReply.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-mcp-broker');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      const toolsReply = await readLine();
      expect((toolsReply.result as { tools: unknown[] }).tools).toHaveLength(1);
      child.stdin.end();
      return await new Promise((resolveExit) => child.once('exit', resolveExit));
    };
    const records = () =>
      readFileSync(ledger, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { outcome: string; socket: string });
    const mcpBroker = await startFakeMcpBroker(paths.mcpSocket);
    try {
      const reachable = runWrapped(
        {
          mode: 'readonly' as const,
          cwd: checkout,
          maskPaths: credentialMaskPaths(undefined, operatorHome),
        },
        `cat ${JSON.stringify(resolve(sessionDir, 'session.json'))}`,
      );
      expect(reachable.stdout.trim()).toBe('{"paired":true}');

      writeFileSync(ledger, '');
      expect(await runFacadeInteractive(['squire'])).toBe(0);
      expect(await runFacadeInteractive(['squire'])).toBe(0);
      // The regression this test guards: a real sandboxed façade reaches the
      // host broker over its shared MCP socket directly and never touches
      // `npx` at all — there is nothing left inside the sandbox that could
      // fall through to an on-demand broker launch (whose own guard,
      // `systemctl --user show`, is itself unreachable from inside bwrap).
      expect(records()).toEqual([]);
      expect(lstatSync(paths.brokerSocket).isSocket()).toBe(true);

      // A grant on some other host server binds nothing here: the broker
      // directory stays read-only, so the same façade cannot touch it.
      writeFileSync(ledger, '');
      expect(runFacade(['browser']).status).not.toBe(0);
      expect(records()).toEqual([]);
    } finally {
      await stopFakeMcpBroker(mcpBroker);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

// ---------------------------------------------------------------------------
// Agent-to-agent isolation: the exact incident this closes. Every Beeline
// agent on a host shares one Unix account, so a real ACP child's sandbox is
// the only thing that can stop it reading a SIBLING agent's `runtime.json`
// (signing `secretKeyHex`, `daemonToken`) the way a Room agent did on
// 2026-09-29 with a plain `cat agents/*/runtime.json`.
// ---------------------------------------------------------------------------

liveDescribe('agent A cannot read agent B in a real sandboxed command', () => {
  let agentsRoot: string;
  let agentA: string;
  let agentB: string;

  beforeAll(() => {
    // Deliberately OUTSIDE /tmp: the sandbox's own private `--tmpfs /tmp`
    // would otherwise hide agent B for a reason that has nothing to do with
    // the mask under test (only `cwd` — agent A — gets restored there).
    agentsRoot = mkdtempSync(resolve(homedir(), '.beeline-sibling-agents-proof-'));
    agentA = resolve(agentsRoot, 'a'.repeat(64));
    agentB = resolve(agentsRoot, 'b'.repeat(64));
    mkdirSync(agentA, { recursive: true, mode: 0o700 });
    mkdirSync(agentB, { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(agentA, 'runtime.json'),
      JSON.stringify({ agent: { secretKeyHex: 'AGENT-A-SECRET-KEY-HEX' } }),
      { mode: 0o600 },
    );
    writeFileSync(
      resolve(agentB, 'runtime.json'),
      JSON.stringify({ agent: { secretKeyHex: 'AGENT-B-SECRET-KEY-HEX' } }),
      { mode: 0o600 },
    );
  });

  afterAll(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  const readBoth = (maskPaths: ReturnType<typeof siblingAgentMaskPaths>) => {
    const wrapped = wrapAgentCommand({
      bwrapPath: bwrap.path!,
      spec: { mode: 'readonly', cwd: agentA, maskPaths },
      command: '/bin/sh',
      args: [
        '-c',
        `cat ${JSON.stringify(resolve(agentA, 'runtime.json'))}; echo ---; ` +
          `cat ${JSON.stringify(resolve(agentB, 'runtime.json'))} 2>&1`,
      ],
    });
    return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  };

  it('the vulnerability: an unmasked Room sandbox can still read a sibling agent runtime.json', () => {
    // 0600 file modes do nothing here — both files are owned by the same
    // account the sandboxed child runs as, and the whole-home ro-bind makes
    // every path on the host readable absent an explicit mask. This is the
    // exact shape of the read Hoots ran against production.
    const result = readBoth([]);
    expect(result.stdout).toContain('AGENT-A-SECRET-KEY-HEX');
    expect(result.stdout).toContain('AGENT-B-SECRET-KEY-HEX');
  });

  it('the fix: siblingAgentMaskPaths hides every other agent while leaving A intact', () => {
    const result = readBoth(siblingAgentMaskPaths(agentA));
    const [own, rest] = result.stdout.split('---\n');
    expect(own).toContain('AGENT-A-SECRET-KEY-HEX');
    expect(rest ?? '').not.toContain('AGENT-B-SECRET-KEY-HEX');
    expect(result.stdout).not.toContain('AGENT-B-SECRET-KEY-HEX');
    expect((rest ?? '') + result.stderr).toMatch(/No such file or directory/);
  });
});
