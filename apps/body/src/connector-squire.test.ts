import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  connectionGrant,
  connectionLedgerEntry,
  defaultStreamedRunner,
  installSquire,
  isProcessAlive,
  isSquireBrowserSessionFailure,
  parseConnectOutput,
  readConnectionDetail,
  readConnectionLedger,
  readGrants,
  readVault,
  reclaimSquireProfileClaim,
  releaseSquireConnectSession,
  resolveSquireConnectSpec,
  revokeGrants,
  squireConnectProcessEnv,
  squireConnectSession,
  squireProfileLockPath,
  vaultConnectionMeta,
  type InstallSquireOptions,
  type InstallSquireResult,
  type ShellRunner,
  type StreamedShellRunner,
  type SquireMcpClient,
} from './connector-squire.js';
import { resetSquireConnectFacts } from './squire-connect-state.js';

/** A scripted mock of the Squire MCP: no real Squire, ever. */
function mockSquire(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: { tool: string; args?: Record<string, unknown> }[] = [];
  const client: SquireMcpClient = {
    async call(tool, args) {
      calls.push({ tool, args });
      const handler = handlers[tool];
      if (!handler) throw new Error(`unknown tool: ${tool}`);
      return handler(args);
    },
  };
  return { client, calls };
}

const okRunner = () => async () => ({ code: 0, stdout: '', stderr: '' });

/** A runner whose stdout answers every invocation (scripted, in order). */
function scriptedRunner(responses: { stdout: string; code?: number }[]): {
  run: ShellRunner;
  invocations: string[][];
} {
  const invocations: string[][] = [];
  let index = 0;
  return {
    invocations,
    run: async (_command, args) => {
      invocations.push([_command, ...args]);
      return { code: 0, stdout: '', ...(responses[Math.min(index++, responses.length - 1)] ?? {}) };
    },
  };
}

/** A live stand-in for the connect process the streamed runner would spawn. */
function spawnLongLivedConnect() {
  return defaultStreamedRunner(process.execPath, [
    '-e',
    'console.log("sign in: https://squire.test/vnc#p=1"); setInterval(() => {}, 30_000)',
  ]);
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000 });
}

/** A fake streaming runner that resolves immediately with a given result. */
function fakeStreamRunner(result: {
  stdout?: string;
  stderr?: string;
  signIn?: { method: 'streamed-page' | 'oauth'; url: string };
  localScreen?: boolean;
}): StreamedShellRunner {
  return async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signIn: result.signIn,
    localScreen: result.localScreen,
    abort: () => {},
  });
}

const isolatedHomes: string[] = [];
afterEach(() => {
  releaseSquireConnectSession();
  resetSquireConnectFacts();
  for (const home of isolatedHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function isolatedConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'squire-session-'));
  isolatedHomes.push(home);
  mkdirSync(join(home, 'trusty-squire'), { recursive: true });
  return home;
}

function writeSession(configHome: string, accountId = 'acct_1'): void {
  writeFileSync(
    join(configHome, 'trusty-squire', 'session.json'),
    JSON.stringify({
      api_base_url: 'https://vault.test',
      account_id: accountId,
      agent_session_token: 'tok_live',
      machine_token: 'mach_live',
    }),
  );
}

function runInstall(
  options: InstallSquireOptions & { session?: boolean },
): Promise<InstallSquireResult> {
  const configHome = options.configHome ?? isolatedConfigHome();
  if (options.session) writeSession(configHome);
  return installSquire({
    seatDisplay: null,
    ...options,
    configHome,
  });
}

describe('parseConnectOutput', () => {
  it('reports a streamed noVNC page when Squire prints one', () => {
    const signIn = parseConnectOutput(
      'Remote sign-in ready: https://tunnel.example/vnc.html#p=hunter2\nOpen it in a browser.',
    );
    expect(signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.example/vnc.html#p=hunter2',
    });
  });

  it('reports an OAuth URL when Squire prints one', () => {
    const signIn = parseConnectOutput(
      'Sign in: https://squire.example/oauth/authorize?state=abc (oauth)',
    );
    expect(signIn).toEqual({ method: 'oauth', url: 'https://squire.example/oauth/authorize?state=abc' });
  });

  it('is undefined when connect printed no URL', () => {
    expect(parseConnectOutput('nothing useful here')).toBeUndefined();
  });

  it('reports the hosted --skip-browser install page as a streamed page', () => {
    const signIn = parseConnectOutput(
      'Open this in your browser to finish: https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqmXeQUojqvHNwnpta3vv5p\n',
    );
    expect(signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqmXeQUojqvHNwnpta3vv5p',
    });
  });
});

describe('installSquire', () => {
  it('reports every step and the sign-in method the connect command printed', async () => {
    const result = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'Open this in your browser: https://trustysquire.ai/install?token=secret\n',
        signIn: { method: 'streamed-page', url: 'https://trustysquire.ai/install?token=secret' },
      }),
    });
    expect(result.status).toBe('installing');
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=secret',
    });
    expect(result.steps.map((step) => step.label)).toEqual([
      'helper reached',
      'trusty-squire installed',
      'waiting for sign-in',
    ]);
  });

  it('verifies the resolved version, then runs connect on the @latest spec', async () => {
    const streamInvocations: string[][] = [];
    const { run, invocations } = scriptedRunner([{ stdout: '1.1.14' }, { stdout: '1.1.14' }]);
    await runInstall({
      workspaceId: 'ws-1',
      streamRun: async (_cmd, args) => {
        streamInvocations.push(['npx', ...args]);
        return {
          stdout: 'https://squire.example/oauth/authorize?x=1',
          stderr: '',
          signIn: { method: 'oauth', url: 'https://squire.example/oauth/authorize?x=1' },
          abort: () => {},
        };
      },
      run,
    });
    expect(invocations).toEqual([
      ['npm', 'view', '@trusty-squire/mcp', 'version'],
      ['npx', '-y', '@trusty-squire/mcp@latest', '--version'],
    ]);
    expect(streamInvocations).toEqual([
      ['npx', '-y', '@trusty-squire/mcp@latest', 'connect', '--target=codex'],
    ]);
  });

  it('fails with a clear reason when the streamed connect command errors with no URL', async () => {
    const result = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stderr: 'some connect error',
        signIn: undefined,
      }),
    });
    expect(result.status).toBe('error');
    expect(result.steps.find((step) => step.label === 'trusty-squire installed')?.reason).toContain(
      'some connect error',
    );
  });

  it('fails the sign-in step when streamed connect prints no URL on a headless host', async () => {
    const result = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({ signIn: undefined }),
    });
    expect(result.status).toBe('error');
    expect(
      result.steps.find((step) => step.label === 'trusty-squire installed')?.reason,
    ).toContain('no sign-in URL');
  });

  it('keeps a published ceremony installing without asking Squire whether it is connected', async () => {
    const result = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'Already connected (google + github). config refreshed.\nhttps://tunnel.example/vnc.html#p=x\n',
        signIn: { method: 'streamed-page', url: 'https://tunnel.example/vnc.html#p=x' },
      }),
    });
    expect(result.status).toBe('installing');
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.example/vnc.html#p=x',
    });
    expect(result.steps.find((step) => step.label === 'paired to workspace')).toBeUndefined();
  });

  it('emits the waiting-for-sign-in step via onProgress before the connect process would exit', async () => {
    const progressSteps: string[][] = [];
    let captured = false;
    await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: async () => ({
        stdout: 'https://vnc.trustysquire.ai/#p=secret\n',
        stderr: '',
        signIn: { method: 'streamed-page', url: 'https://vnc.trustysquire.ai/#p=secret' },
        abort: () => {},
      }),
      onProgress(steps) {
        progressSteps.push(steps.map((s) => s.label));
        const last = steps[steps.length - 1];
        if (last?.label === 'waiting for sign-in') captured = true;
      },
    });
    expect(captured).toBe(true);
    expect(
      progressSteps.some((labels) => labels.includes('waiting for sign-in')),
    ).toBe(true);
  });

  it('reports connected from the session file without spawning connect', async () => {
    let starts = 0;
    const result = await runInstall({
      workspaceId: 'ws-1',
      session: true,
      run: okRunner(),
      streamRun: async () => {
        starts += 1;
        return {
          stdout: 'Already connected (google + github). config refreshed.',
          stderr: '',
          abort: () => {},
        };
      },
    });
    expect(starts).toBe(0);
    expect(result.status).toBe('connected');
    expect(result.signedInAs).toBe('acct_1');
  });

  it('a dead connect that already published a ceremony does not start another display', async () => {
    let starts = 0;
    const streamRun: StreamedShellRunner = async (_cmd, args, env) => {
      starts += 1;
      return {
        stdout: `https://tunnel.test/vnc#p=${starts}`,
        stderr: '',
        signIn: { method: 'streamed-page', url: `https://tunnel.test/vnc#p=${starts}` },
        abort: () => {},
      };
    };
    const first = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun,
    });
    expect(first.status).toBe('installing');
    expect(first.signIn?.url).toBe('https://tunnel.test/vnc#p=1');
    const second = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun,
    });
    expect(starts).toBe(1);
    expect(second.status).toBe('installing');
    expect(second.signIn?.url).toBe('https://tunnel.test/vnc#p=1');
  });

  it('a host with a seat display stays installing when connect prints no URL', async () => {
    const result = await runInstall({
      workspaceId: 'ws-1',
      seatDisplay: ':0',
      run: okRunner(),
      streamRun: fakeStreamRunner({ localScreen: true }),
    });
    expect(result.status).toBe('installing');
    expect(result.signIn).toBeUndefined();
    expect(
      result.steps.find((step) => step.label === 'waiting for sign-in')?.reason,
    ).toContain('that screen');
  });
});

describe('version resolution', () => {
  it('accepts the plain @latest spec when npx already resolves the current release', async () => {
    const { run } = scriptedRunner([{ stdout: '1.1.14' }, { stdout: '1.1.14' }]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution).toEqual({
      npxArgs: ['-y', '@trusty-squire/mcp@latest'],
      resolvedVersion: '1.1.14',
      currentRelease: '1.1.14',
      reResolved: false,
    });
  });

  it('detects a stale npx copy (rc vs current release) and re-resolves with --prefer-online', async () => {
    // Probe 1: stale cached copy; probe 2 (cache busted): the current release.
    const { run, invocations } = scriptedRunner([
      { stdout: '1.1.14' },
      { stdout: '1.1.14-rc.34' },
      { stdout: '1.1.14' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution).toEqual({
      npxArgs: ['--prefer-online', '-y', '@trusty-squire/mcp@latest'],
      resolvedVersion: '1.1.14',
      currentRelease: '1.1.14',
      reResolved: true,
    });
    expect(invocations[2]).toEqual([
      'npx',
      '--prefer-online',
      '-y',
      '@trusty-squire/mcp@latest',
      '--version',
    ]);
  });

  it('runs the exact current release when the cache refuses to move', async () => {
    const { run } = scriptedRunner([
      { stdout: '1.1.14' },
      { stdout: '1.1.14-rc.34' },
      { stdout: '1.1.14-rc.34' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    // Resolved at runtime from the registry — never a source-level pin.
    expect(resolution.npxArgs).toEqual(['-y', '@trusty-squire/mcp@1.1.14']);
    expect(resolution.reResolved).toBe(true);
  });

  it('does not block connect when the registry is unreachable', async () => {
    const { run, invocations } = scriptedRunner([
      { code: 1, stdout: 'npm error network down' },
      { stdout: '1.1.14-rc.34' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution).toEqual({
      npxArgs: ['-y', '@trusty-squire/mcp@latest'],
      resolvedVersion: '1.1.14-rc.34',
      reResolved: false,
    });
    expect(invocations).toHaveLength(2);
  });

  it('carries the re-resolved spec into the connect invocation', async () => {
    const streamInvocations: string[][] = [];
    const { run } = scriptedRunner([
      { stdout: '1.1.14' },
      { stdout: '1.1.14-rc.34' },
      { stdout: '1.1.14-rc.34' },
    ]);
    const logs: string[] = [];
    const result = await runInstall({
      workspaceId: 'ws-1',
      streamRun: async (_cmd, args) => {
        streamInvocations.push(['npx', ...args]);
        return {
          stdout: 'https://squire.example/install?token=x',
          stderr: '',
          signIn: { method: 'streamed-page', url: 'https://squire.example/install?token=x' },
          abort: () => {},
        };
      },
      run,
      log: (message) => logs.push(message),
    });
    expect(result.status).toBe('installing');
    expect(streamInvocations[0]).toEqual([
      'npx',
      '-y',
      '@trusty-squire/mcp@1.1.14',
      'connect',
      '--target=codex',
    ]);
    expect(result.steps.find((s) => s.label.startsWith('trusty-squire'))?.status).toBe('done');
    expect(logs.join('\n')).toContain('stale copy');
  });
});

describe('connect session claim', () => {
  it('resolves a seat DISPLAY as a local screen without waiting for a URL', async () => {
    const result = await defaultStreamedRunner(
      process.execPath,
      ['-e', 'setInterval(() => {}, 30_000)'],
      { ...process.env, DISPLAY: ':0' },
    );
    expect(result.localScreen).toBe(true);
    expect(result.signIn).toBeUndefined();
    expect(isProcessAlive(squireConnectSession()?.pid)).toBe(true);
    result.abort();
    await until(() => !isProcessAlive(squireConnectSession()?.pid));
  });

  it('the streamed runner claims the session with the child pid, and abort kills it', async () => {
    const result = await spawnLongLivedConnect();
    expect(result.signIn).toBeDefined();
    const claim = squireConnectSession();
    expect(claim?.pid).toBeTypeOf('number');
    expect(isProcessAlive(claim!.pid)).toBe(true);
    claim!.abort();
    await until(() => !isProcessAlive(claim!.pid));
  });

  it('releases a live claim by aborting its owner before a fresh connect', async () => {
    await spawnLongLivedConnect();
    const claim = squireConnectSession()!;
    const logs: string[] = [];
    releaseSquireConnectSession((message) => logs.push(message));
    expect(squireConnectSession()).toBeUndefined();
    expect(logs.join('\n')).toContain('still live');
    await until(() => !isProcessAlive(claim.pid));
  });

  it('clears a dead claim (owner process gone) without touching anything', async () => {
    await spawnLongLivedConnect();
    const claim = squireConnectSession()!;
    process.kill(claim.pid!, 'SIGKILL');
    await until(() => !isProcessAlive(claim.pid));
    // The claim intentionally outlives its owner; the next connect attempt is
    // what detects the dead owner and clears it.
    expect(squireConnectSession()).toBeDefined();
    const logs: string[] = [];
    releaseSquireConnectSession((message) => logs.push(message));
    expect(squireConnectSession()).toBeUndefined();
    expect(logs.join('\n')).toContain('dead');
  });

  it('a second install waits on this helper\'s live connect instead of starting another', async () => {
    await spawnLongLivedConnect();
    const claim = squireConnectSession()!;
    let started = 0;
    const result = await runInstall({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: async () => {
        started += 1;
        return { stdout: '', stderr: '', abort: () => {} };
      },
    });
    expect(started).toBe(0);
    expect(result.status).toBe('installing');
    expect(isProcessAlive(claim.pid)).toBe(true);
    claim.abort();
    await until(() => !isProcessAlive(claim.pid));
  });
});

describe('on-disk profile claim reclaim', () => {
  function claimDir(): { profileDir: string; lockRoot: string; lockPath: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'squire-claim-'));
    const profileDir = join(root, 'profile');
    const lockRoot = join(root, 'locks');
    mkdirSync(profileDir);
    mkdirSync(lockRoot);
    const lockPath = squireProfileLockPath(profileDir, lockRoot);
    return {
      profileDir,
      lockRoot,
      lockPath,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  function writeLock(lockPath: string, pid: number, startTime = 'unknown'): void {
    writeFileSync(
      lockPath,
      JSON.stringify({ host: hostname(), pid, start_time: startTime, token: 'test-token' }),
    );
  }

  it('isSquireBrowserSessionFailure matches hyphen, em-dash, and remapped spellings', () => {
    expect(
      isSquireBrowserSessionFailure(
        'another Trusty Squire session is already using the browser — close it first',
      ),
    ).toBe(true);
    expect(
      isSquireBrowserSessionFailure(
        'another Trusty Squire session is already using the browser - close it first',
      ),
    ).toBe(true);
    expect(
      isSquireBrowserSessionFailure(
        'Trusty Squire is still using the browser — connect Trusty Squire first',
      ),
    ).toBe(true);
    expect(
      isSquireBrowserSessionFailure(
        "Trusty Squire's browser is in use by another process (pid 12). Finish or close that Trusty Squire session, then press Connect again.",
      ),
    ).toBe(true);
    expect(isSquireBrowserSessionFailure('scope refused')).toBe(false);
    expect(
      isSquireBrowserSessionFailure(
        'no Google credentials found. Put a google-credentials.json at /tmp or connect your Google account in Trusty Squire first.',
      ),
    ).toBe(false);
  });

  it('reclaims a lock whose owner process is gone', () => {
    const dir = claimDir();
    writeLock(dir.lockPath, 2_147_483_647);
    expect(existsSync(dir.lockPath)).toBe(true);
    const result = reclaimSquireProfileClaim({
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
    });
    expect(result.kind).toBe('reclaimed-dead');
    expect(existsSync(dir.lockPath)).toBe(false);
    dir.cleanup();
  });

  it('does not kill a live foreign owner; installSquire fails with an actionable pid', async () => {
    const dir = claimDir();
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeLock(dir.lockPath, holder.pid!);
    let streamed = false;
    const result = await runInstall({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run: okRunner(),
      streamRun: async () => {
        streamed = true;
        return { stdout: '', stderr: '', abort: () => {} };
      },
    });
    expect(streamed).toBe(false);
    expect(result.status).toBe('installing');
    expect(result.steps.find((step) => step.label === 'waiting for sign-in')?.reason).toContain(
      String(holder.pid),
    );
    expect(existsSync(dir.lockPath)).toBe(true);
    expect(isProcessAlive(holder.pid)).toBe(true);
    holder.kill();
    dir.cleanup();
  });

  it('releases a lock this helper already claimed without killing a live owner', () => {
    const dir = claimDir();
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeLock(dir.lockPath, holder.pid!);
    const result = reclaimSquireProfileClaim({
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      ourPids: [holder.pid!],
    });
    expect(result.kind).toBe('released-ours');
    expect(existsSync(dir.lockPath)).toBe(false);
    expect(isProcessAlive(holder.pid)).toBe(true);
    holder.kill();
    dir.cleanup();
  });

  it('rewrites a busy-browser connect refusal to the foreign-holder action', async () => {
    const dir = claimDir();
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await runInstall({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: async () => {
        writeLock(dir.lockPath, holder.pid!);
        return {
          stdout: '',
          stderr: 'another Trusty Squire session is already using the browser - close it first',
          abort: () => {},
        };
      },
    });
    expect(result.status).toBe('installing');
    expect(result.steps.find((step) => step.label === 'waiting for sign-in')?.reason).toContain(
      String(holder.pid),
    );
    expect(result.errorMessage).toBeUndefined();
    expect(existsSync(dir.lockPath)).toBe(true);
    holder.kill();
    dir.cleanup();
  });

  it('clears a dead on-disk lock before connect runs', async () => {
    const dir = claimDir();
    writeLock(dir.lockPath, 2_147_483_647);
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await runInstall({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: fakeStreamRunner({
        stdout: 'https://squire.example/install?token=x',
        signIn: { method: 'streamed-page', url: 'https://squire.example/install?token=x' },
      }),
    });
    expect(result.status).toBe('installing');
    expect(existsSync(dir.lockPath)).toBe(false);
    dir.cleanup();
  });

  it('pins connect to the helper profile so a foreign Codex config cannot steal the claim', async () => {
    const dir = claimDir();
    let env: NodeJS.ProcessEnv | undefined;
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await runInstall({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: async (_command, _args, spawnEnv) => {
        env = spawnEnv;
        return {
          stdout: 'https://squire.example/install?token=x',
          stderr: '',
          signIn: { method: 'streamed-page', url: 'https://squire.example/install?token=x' },
          abort: () => {},
        };
      },
    });
    expect(result.status).toBe('installing');
    expect(env?.TRUSTY_SQUIRE_PROFILE_DIR).toBe(dir.profileDir);
    expect(env?.XDG_CONFIG_HOME).toMatch(/\.config$/);
    expect(env?.TRUSTY_SQUIRE_BROKER_SOCKET).toMatch(/broker\.sock$/);
    expect(squireConnectProcessEnv(dir.profileDir).TRUSTY_SQUIRE_PROFILE_DIR).toBe(dir.profileDir);
    expect(squireConnectProcessEnv(dir.profileDir).TRUSTY_SQUIRE_BROKER_SOCKET).toMatch(
      /broker\.sock$/,
    );
    dir.cleanup();
  });
});

describe('vault reads through the Squire MCP', () => {
  it('shapes vault metadata without secret values', async () => {
    const { client, calls } = mockSquire({
      list_credentials: () => ({
        credentials: [
          {
            reference: 'cred_1',
            service: 'openai',
            label: 'Work key',
            field_names: ['api_key'],
            allowed_hosts: ['api.openai.com'],
            created_at: 1700000000,
            stale: false,
            state: 'active',
          },
        ],
      }),
    });
    const vault = await readVault(client);
    expect(vault[0]).toMatchObject({ reference: 'cred_1', service: 'openai', label: 'Work key' });
    expect(JSON.stringify(vault)).not.toContain('api_key_value');
    expect(calls[0]?.tool).toBe('list_credentials');
  });

  it('reads the ledger view for one connection', async () => {
    const { client, calls } = mockSquire({
      audit_log: () => ({
        entries: [
          {
            id: 'e1',
            timestamp: 1700000100,
            action: 'credential_used',
            status: 200,
            bytes: 512,
            anomaly: false,
          },
          { id: 'e2', timestamp: 1700000200, action: 'rate_limited', anomaly: true, anomaly_reason: '429' },
        ],
      }),
    });
    const ledger = await readConnectionLedger(client, 'cred_1');
    expect(calls[0]).toEqual({ tool: 'audit_log', args: { reference: 'cred_1', view: 'ledger' } });
    expect(ledger).toHaveLength(2);
    expect(ledger[1]?.anomaly).toBe(true);
    expect(ledger[1]?.anomalyReason).toBe('429');
  });

  it('revokes every live grant on one connection and counts failures', async () => {
    const { client, calls } = mockSquire({
      list_app_access: () => ({
        grants: [
          { grant_id: 'g1', credential_ref: 'cred_1', created_at: 1 },
          { grant_id: 'g2', credential_ref: 'cred_1', created_at: 2 },
          { grant_id: 'g3', credential_ref: 'cred_other', created_at: 3 },
          { grant_id: 'g4', credential_ref: 'cred_1', created_at: 4, revoked_at: 9 },
        ],
      }),
      revoke_app_access: (args) => (args?.grant_id === 'g2' ? { revoked: false } : { revoked: true }),
    });
    const result = await revokeGrants(client, 'cred_1');
    expect(result).toEqual({ revoked: 1, failed: 1 });
    const revokeCalls = calls.filter((call) => call.tool === 'revoke_app_access');
    expect(revokeCalls.map((call) => call.args?.grant_id).sort()).toEqual(['g1', 'g2']);
  });

  it('builds grant and ledger shapes directly', () => {
    expect(connectionGrant({ grant_id: 'g1', credential_ref: 'c', rate_limit_per_hour: 10 }))
      .toMatchObject({ grantId: 'g1', rateLimitPerHour: 10 });
    expect(connectionLedgerEntry({ event_id: 'x', kind: 'grant_revoked' })).toMatchObject({
      id: 'x',
      action: 'grant_revoked',
    });
  });

  it('assembles one connection detail with metadata, grants and ledger', async () => {
    const { client } = mockSquire({
      list_credentials: () => ({
        credentials: [{ reference: 'cred_1', service: 'openai', label: 'Work key' }],
      }),
      list_app_access: () => ({ grants: [{ grant_id: 'g1', credential_ref: 'cred_1' }] }),
      audit_log: () => ({ entries: [{ id: 'e1', action: 'credential_used' }] }),
    });
    const detail = await readConnectionDetail(client, 'cred_1');
    expect('error' in detail).toBe(false);
    if (!('error' in detail)) {
      expect(detail.metadata.reference).toBe('cred_1');
      expect(detail.grants).toHaveLength(1);
      expect(detail.ledger).toHaveLength(1);
    }
  });

  it('names an unknown connection instead of guessing', async () => {
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    const detail = await readConnectionDetail(client, 'cred_missing');
    expect('error' in detail && detail.error).toContain('cred_missing');
  });

  it('vault metadata tolerates stale and error states', () => {
    expect(vaultConnectionMeta({ reference: 'c', stale: true, state: 'error' })).toMatchObject({
      stale: true,
      state: 'error',
    });
    expect(readGrants).toBeTypeOf('function');
  });
});
