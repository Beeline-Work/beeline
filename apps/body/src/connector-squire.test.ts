import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  connectBlockedLine,
  connectBrowserLocation,
  connectionGrant,
  connectionLedgerEntry,
  CONNECT_TIMEOUT_MS,
  defaultStreamedRunner,
  installSquire,
  isProcessAlive,
  parseConnectReport,
  readConnectionDetail,
  readConnectionLedger,
  readGrants,
  readVault,
  reclaimSquireProfileClaim,
  releaseSquireConnectSession,
  resolveSquireConnectSpec,
  revokeGrants,
  SQUIRE_CONNECT_PACKAGE,
  squireConnectProcessEnv,
  squireConnectSession,
  squireProfileLockPath,
  vaultConnectionMeta,
  type ShellRunner,
  type SquireConnectReport,
  type StreamedShellRunner,
  type SquireMcpClient,
} from './connector-squire.js';

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

/** One line of Squire's `--json` stream, with the report's zero values. */
function reportLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'needs-sign-in',
    terminal: false,
    reason: null,
    sign_in_url: null,
    account: null,
    holder: { kind: 'none' },
    browser_location: { kind: 'none' },
    ...overrides,
  });
}

/** The typed report as this helper reads it: the last line of a stream. */
function report(overrides: Record<string, unknown> = {}): SquireConnectReport {
  return parseConnectReport(reportLine(overrides))!;
}

/** A live stand-in for the connect process the streamed runner would spawn. */
function spawnLongLivedConnect() {
  const line = reportLine({
    state: 'needs-sign-in',
    sign_in_url: 'https://squire.test/vnc#p=1',
    browser_location: { kind: 'virtual', url: 'https://squire.test/vnc#p=1' },
  });
  return defaultStreamedRunner(process.execPath, [
    '-e',
    `process.stdout.write(${JSON.stringify(`${line}\n`)}); setInterval(() => {}, 30_000)`,
  ]);
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000 });
}

/** A fake streaming runner that resolves immediately with a given result. */
function fakeStreamRunner(result: {
  stdout?: string;
  stderr?: string;
  report?: SquireConnectReport;
}): StreamedShellRunner {
  return async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    report: result.report,
    abort: () => {},
  });
}

describe('parseConnectReport', () => {
  it('reads the machine channel and keeps the account providers distinction', () => {
    const read = parseConnectReport(
      reportLine({
        state: 'connected',
        terminal: true,
        reason: 'cached_cookie_evidence',
        account: { id: '01KS0BKRYTVE9T9FAQQ31A4MK3', providers: null },
      }),
    );
    expect(read?.state).toBe('connected');
    expect(read?.terminal).toBe(true);
    expect(read?.reason).toBe('cached_cookie_evidence');
    // null means "could not read the profile at all" and is NOT emptied.
    expect(read?.account?.providers).toBeNull();
  });

  it('keeps an empty provider list empty rather than null', () => {
    expect(
      parseConnectReport(reportLine({ account: { id: 'a', providers: [] } }))?.account?.providers,
    ).toEqual([]);
  });

  it('is undefined for prose, an empty line, or a non-report object', () => {
    expect(parseConnectReport('Opening the Trusty Squire install page')).toBeUndefined();
    expect(parseConnectReport('')).toBeUndefined();
    expect(parseConnectReport('{"hello":"world"}')).toBeUndefined();
  });

  it('names an unrecognised state verbatim instead of coercing it', () => {
    const read = parseConnectReport(reportLine({ state: 'quantum-superposition' }));
    expect(read?.state).toBe('quantum-superposition');
    expect(connectBlockedLine(read!)).toContain('quantum-superposition');
  });

  it('renders a typed blocked reason, never Squire prose', () => {
    expect(
      connectBlockedLine(report({ state: 'busy', reason: 'profile_unverifiable' })),
    ).toBe("the bot's Chrome profile could not be verified");
    expect(
      connectBlockedLine(report({ state: 'no-browser', reason: 'install_expired' })),
    ).toBe('the sign-in page expired before it was used');
  });

  it('names a live holder from the report, with the pid', () => {
    const blocked = report({
      state: 'busy',
      holder: { kind: 'other', code: 'singleton_lock', pid: 4242 },
    });
    expect(connectBlockedLine(blocked)).toContain('4242');
    expect(connectBlockedLine(blocked)).toContain('Finish or close that Trusty Squire session');
  });

  it('names the typed block, not the broker Chrome holding the profile', () => {
    // Squire snapshots a holder onto every line, and on this helper the
    // shared broker's own Chrome holds the profile while the ceremony runs —
    // reading it first told the person to close the browser every other
    // agent is using.
    const brokerHolder = { kind: 'other', code: 'singleton_lock', pid: 4242 };
    expect(
      connectBlockedLine(
        report({
          state: 'no-browser',
          terminal: true,
          holder: brokerHolder,
          browser_location: { kind: 'unreachable', reason: 'no x11vnc' },
        }),
      ),
    ).toBe('the sign-in page could not be shown on this machine');
    expect(
      connectBlockedLine(
        report({
          state: 'no-browser',
          terminal: true,
          reason: 'account_mismatch',
          holder: brokerHolder,
        }),
      ),
    ).toBe('this machine is bound to a different account');
  });

  it('has nothing to say for a connected report or an outstanding sign-in', () => {
    expect(connectBlockedLine(report({ state: 'connected', terminal: true }))).toBeUndefined();
    expect(
      connectBlockedLine(
        report({
          state: 'needs-sign-in',
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'host_screen' },
        }),
      ),
    ).toBeUndefined();
  });

  it('says a sign-in nobody is waiting on any more is blocked', () => {
    // The run ENDED still needing a sign-in: nothing is listening for the
    // human on the other side of that page.
    expect(
      connectBlockedLine(
        report({
          state: 'needs-sign-in',
          terminal: true,
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'host_screen' },
        }),
      ),
    ).toBe('the connect run ended before the sign-in was completed');
    // Nowhere to send anyone: the placement says the page could not be shown.
    expect(
      connectBlockedLine(
        report({
          state: 'needs-sign-in',
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'unreachable', reason: 'no x11vnc' },
        }),
      ),
    ).toBe('the sign-in page could not be shown on this machine');
  });

  it('carries the browser location by kind, never inventing one', () => {
    expect(connectBrowserLocation({ kind: 'host_screen', display: ':0' })).toEqual({
      kind: 'host_screen',
    });
    expect(connectBrowserLocation({ kind: 'virtual', url: 'https://tunnel.test/#p=x' })).toEqual({
      kind: 'virtual',
      url: 'https://tunnel.test/#p=x',
    });
    expect(connectBrowserLocation({ kind: 'unreachable', reason: 'no display' })).toEqual({
      kind: 'unreachable',
      reason: 'no display',
    });
    expect(connectBrowserLocation({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(connectBrowserLocation('elsewhere')).toBeUndefined();
  });
});

describe('defaultStreamedRunner', () => {
  it('never publishes a report a chunk boundary cut in half', async () => {
    // The runner reads complete lines only. Writing the JSON line in two
    // pieces with no newline between them is an ordinary pipe split, and the
    // first piece is not a report at all.
    const line = reportLine({
      state: 'needs-sign-in',
      sign_in_url: 'https://tunnel.test/#p=hunter22',
      browser_location: { kind: 'host_screen' },
    });
    const cut = Math.floor(line.length / 2);
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        `process.stdout.write(${JSON.stringify(line.slice(0, cut))});`,
        'setTimeout(() => {',
        `  process.stdout.write(${JSON.stringify(`${line.slice(cut)}\n`)});`,
        '}, 120);',
        'setInterval(() => {}, 30_000);',
      ].join(''),
    ]);
    expect(result.report?.state).toBe('needs-sign-in');
    expect(result.report?.sign_in_url).toBe('https://tunnel.test/#p=hunter22');
    result.abort();
    releaseSquireConnectSession();
  });

  it('still reads a report a child printed with no trailing newline', async () => {
    // The buffers are complete once the child is gone, so its last line is a
    // whole one; dropping it would lose the only report connect ever printed.
    const line = reportLine({ state: 'connected', terminal: true });
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      `process.stdout.write(${JSON.stringify(line)})`,
    ]);
    expect(result.report?.state).toBe('connected');
    expect(result.report?.terminal).toBe(true);
    releaseSquireConnectSession();
  });

  it('keeps reaping an abandoned ceremony after its report is published', async () => {
    // Nothing downstream reaps the connect once the connector row leaves
    // `installing`, so the runner's own bound is what keeps the display rig
    // from living for the daemon's lifetime.
    const sleep = ((real) => (ms: number) => new Promise((done) => real(done, ms)))(setTimeout);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = await defaultStreamedRunner(process.execPath, [
        '-e',
        `process.stdout.write(${JSON.stringify(`${reportLine({ state: 'needs-sign-in', sign_in_url: 'https://tunnel.test/#p=hunter22', browser_location: { kind: 'host_screen' } })}\n`)});` +
          'setInterval(() => {}, 30_000);',
      ]);
      expect(result.report?.sign_in_url).toBe('https://tunnel.test/#p=hunter22');
      const pid = squireConnectSession()?.pid;
      expect(isProcessAlive(pid)).toBe(true);

      vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
      for (let attempt = 0; attempt < 200 && isProcessAlive(pid); attempt += 1) await sleep(10);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      vi.useRealTimers();
      releaseSquireConnectSession();
    }
  });

  it('waits for the report Squire prints after its human banner', async () => {
    const line = reportLine({
      state: 'needs-sign-in',
      sign_in_url: 'https://tunnel.test/#p=hunter2',
      browser_location: { kind: 'host_screen' },
    });
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        'process.stdout.write("Opening the Trusty Squire install page in a browser.\\n");',
        'setTimeout(() => {',
        `  process.stdout.write(${JSON.stringify(`${line}\n`)});`,
        '}, 120);',
        'setInterval(() => {}, 30_000);',
      ].join(''),
    ]);
    expect(result.report?.sign_in_url).toBe('https://tunnel.test/#p=hunter2');
    result.abort();
    releaseSquireConnectSession();
  });

  it('publishes the placement Squire reports on a later line, not the first one', async () => {
    // Squire writes the sign-in line before the ceremony browser is placed
    // and writes it again once the placement is known — always before it
    // starts waiting on the human. Settling on the first line publishes a
    // page with nowhere attached to it.
    const first = reportLine({
      state: 'needs-sign-in',
      sign_in_url: 'https://trustysquire.ai/install?token=secret',
    });
    const placed = reportLine({
      state: 'needs-sign-in',
      sign_in_url: 'https://trustysquire.ai/install?token=secret',
      browser_location: { kind: 'virtual', url: 'https://tunnel.test/vnc.html#p=hunter22' },
    });
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        `process.stdout.write(${JSON.stringify(`${first}\n`)});`,
        'setTimeout(() => {',
        `  process.stdout.write(${JSON.stringify(`${placed}\n`)});`,
        '}, 120);',
        'setInterval(() => {}, 30_000);',
      ].join(''),
    ]);
    // Still alive: the placement, not the exit, is what published the page.
    expect(isProcessAlive(result.pid)).toBe(true);
    expect(result.report?.sign_in_url).toBe('https://trustysquire.ai/install?token=secret');
    expect(connectBrowserLocation(result.report?.browser_location)).toEqual({
      kind: 'virtual',
      url: 'https://tunnel.test/vnc.html#p=hunter22',
    });
    result.abort();
    releaseSquireConnectSession();
  });

  it('waits out an unreachable placement for the line that says what blocked it', async () => {
    // A headless host with nothing that can show the ceremony reports the
    // placement as `unreachable` and then ends the run; publishing that
    // non-terminal line would hand a person a page for a connect that is
    // already over.
    const unreachable = reportLine({
      state: 'needs-sign-in',
      sign_in_url: 'https://trustysquire.ai/install?token=secret',
      browser_location: { kind: 'unreachable', reason: 'no x11vnc' },
    });
    const blocked = reportLine({
      state: 'no-browser',
      terminal: true,
      sign_in_url: 'https://trustysquire.ai/install?token=secret',
      browser_location: { kind: 'unreachable', reason: 'no x11vnc' },
    });
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        `process.stdout.write(${JSON.stringify(`${unreachable}\n`)});`,
        'setTimeout(() => {',
        `  process.stdout.write(${JSON.stringify(`${blocked}\n`)});`,
        '}, 120);',
        'setInterval(() => {}, 30_000);',
      ].join(''),
    ]);
    expect(result.report?.state).toBe('no-browser');
    expect(connectBlockedLine(result.report!)).toBe(
      'the sign-in page could not be shown on this machine',
    );
    result.abort();
    releaseSquireConnectSession();
  });

  it('never reads a sign-in surface out of stderr prose', async () => {
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      'process.stderr.write("Open this on any device: https://tunnel.test/#p=hunter22\\n");',
    ]);
    expect(result.report).toBeUndefined();
    expect(result.stderr).toContain('tunnel.test');
    releaseSquireConnectSession();
  });
});

describe('installSquire', () => {
  it('refuses a sign-in button for a ceremony whose page could not be shown', async () => {
    // The runner's safety timeout and a process that dies without its
    // terminal line both hand this report straight to installSquire.
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'unreachable', reason: 'no x11vnc' },
        }),
      }),
      mcp: client,
    });
    expect(result.status).toBe('error');
    expect(result.signIn).toBeUndefined();
    expect(result.errorMessage).toBe('the sign-in page could not be shown on this machine');
  });

  it('refuses a sign-in button for a run that already ended', async () => {
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          terminal: true,
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'host_screen' },
        }),
      }),
      mcp: client,
    });
    expect(result.status).toBe('error');
    expect(result.signIn).toBeUndefined();
    expect(result.errorMessage).toBe('the connect run ended before the sign-in was completed');
  });

  it('reports an unshowable ceremony as blocked, never as an outstanding sign-in', async () => {
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'no-browser',
          terminal: true,
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'unreachable', reason: 'no x11vnc' },
        }),
      }),
      mcp: client,
    });
    expect(result.status).toBe('error');
    expect(result.signIn).toBeUndefined();
    expect(result.errorMessage).toBe('the sign-in page could not be shown on this machine');
  });

  it('stays installing while the ceremony it printed is outstanding', async () => {
    const { client, calls } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'host_screen' },
        }),
      }),
      mcp: client,
    });
    // The vault answered, but the human still has a page to sign in on: a
    // `connected` verdict completes the row in one write and navigates the
    // connect screen off the surface they have to press.
    expect(result.status).toBe('installing');
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=secret',
      browserLocation: { kind: 'host_screen' },
    });
    expect(result.steps.map((step) => step.label)).toEqual([
      'helper reached',
      'trusty-squire installed',
      'waiting for sign-in',
      'paired to workspace',
    ]);
    expect(result.steps.find((step) => step.label === 'waiting for sign-in')?.status).toBe(
      'pending',
    );
    expect(calls[0]).toEqual({
      tool: 'list_credentials',
      args: { fields: 'summary' },
    });
  });

  it('verifies the resolved version, then runs connect with --json', async () => {
    const streamInvocations: string[][] = [];
    const { run, invocations } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.16' },
    ]);
    await installSquire({
      workspaceId: 'ws-1',
      streamRun: async (_cmd, args) => {
        streamInvocations.push(['npx', ...args]);
        return {
          stdout: '',
          stderr: '',
          report: report({
            state: 'needs-sign-in',
            sign_in_url: 'https://tunnel.test/#p=hunter22',
          }),
          abort: () => {},
        };
      },
      run,
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    // Verification (registry read + npx probe) happens BEFORE connect runs.
    expect(invocations).toEqual([
      ['npm', 'view', '@trusty-squire/mcp@latest', 'version'],
      ['npx', '-y', '@trusty-squire/mcp@latest', '--version'],
    ]);
    expect(streamInvocations).toEqual([
      ['npx', '-y', '@trusty-squire/mcp@latest', 'connect', '--target=codex', '--json'],
    ]);
  });

  it('fails with its own words when connect reports nothing, never stderr', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({ stderr: 'some connect error --force-relogin' }),
    });
    expect(result.status).toBe('error');
    const said = `${result.errorMessage ?? ''} ${result.steps
      .map((step) => step.reason ?? '')
      .join(' ')}`;
    expect(said).toContain('did not report a connect result');
    expect(said).not.toContain('some connect error');
    expect(said).not.toContain('force-relogin');
  });

  it('reports a connected report as connected, with no prose involved', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'connected',
          terminal: true,
          reason: 'cached_cookie_evidence',
          account: { id: 'account-1', providers: ['google', 'github'] },
        }),
      }),
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(result.status).toBe('connected');
    expect(result.signIn).toBeUndefined();
    expect(result.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(result.steps.map((step) => step.reason ?? '').join(' ')).not.toContain('force-relogin');
  });

  it('does not report an unverifiable profile as connected, and never quotes a cookie-clear hint', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({ state: 'busy', reason: 'profile_unverifiable' }),
      }),
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(result.status).toBe('error');
    const said = `${result.errorMessage ?? ''} ${result.steps.map((step) => step.reason ?? '').join(' ')}`;
    expect(said).not.toContain('force-relogin');
    expect(said).toContain('could not be verified');
  });

  it('names the holder when another session has the browser', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'busy',
          holder: { kind: 'other', code: 'operation_lease', pid: 777 },
        }),
      }),
    });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('777');
    expect(result.errorMessage).toContain('Finish or close that Trusty Squire session');
  });

  it('opens the noVNC ceremony on the phone before the pairing probe', async () => {
    const failing: SquireMcpClient = {
      async call() {
        throw new Error('squire unreachable');
      },
    };
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'virtual', url: 'https://tunnel.example/vnc.html#p=x' },
        }),
      }),
      mcp: failing,
    });
    expect(result.status).toBe('installing');
    expect(result.signIn?.url).toBe('https://tunnel.example/vnc.html#p=x');
    expect(result.signIn?.browserLocation).toEqual({
      kind: 'virtual',
      url: 'https://tunnel.example/vnc.html#p=x',
    });
    expect(
      result.steps.find((step) => step.label === 'paired to workspace')?.reason,
    ).toContain('squire unreachable');
  });

  it('emits the waiting-for-sign-in step via onProgress before the connect process would exit', async () => {
    const progressSteps: string[][] = [];
    const { client } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          sign_in_url: 'https://trustysquire.ai/install?token=secret',
          browser_location: { kind: 'host_screen' },
        }),
      }),
      onProgress(steps) {
        progressSteps.push(steps.map((s) => s.label));
      },
      mcp: client,
    });
    // The step reaches the phone while the ceremony is still outstanding —
    // one snapshot carries it with the pairing probe still to come.
    const waiting = progressSteps.find((labels) => labels.includes('waiting for sign-in'));
    expect(waiting).toBeDefined();
    expect(waiting).not.toContain('paired to workspace');
    expect(result.status).toBe('installing');
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=secret',
      browserLocation: { kind: 'host_screen' },
    });
    expect(result.steps.find((s) => s.label === 'waiting for sign-in')?.status).toBe('pending');
  });
});

describe('version resolution', () => {
  it('tracks the latest dist-tag, never a source-level version pin', () => {
    expect(SQUIRE_CONNECT_PACKAGE).toBe('@trusty-squire/mcp@latest');
  });

  it('accepts the plain latest spec when npx already resolves that release', async () => {
    const { run, invocations } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.16' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution).toEqual({
      npxArgs: ['-y', '@trusty-squire/mcp@latest'],
      resolvedVersion: '1.1.16',
      currentRelease: '1.1.16',
      reResolved: false,
    });
    expect(invocations[0]).toEqual(['npm', 'view', '@trusty-squire/mcp@latest', 'version']);
  });

  it('detects a stale npx copy and re-resolves with --prefer-online', async () => {
    const { run, invocations } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.15' },
      { stdout: '1.1.16' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution).toEqual({
      npxArgs: ['--prefer-online', '-y', '@trusty-squire/mcp@latest'],
      resolvedVersion: '1.1.16',
      currentRelease: '1.1.16',
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

  it('runs the registry-resolved release when the cache refuses to move', async () => {
    const { run } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.15' },
      { stdout: '1.1.15' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution.npxArgs).toEqual(['-y', '@trusty-squire/mcp@1.1.16']);
    expect(resolution.reResolved).toBe(true);
  });

  it('does not block connect when the registry is unreachable', async () => {
    const { run, invocations } = scriptedRunner([
      { code: 1, stdout: 'npm error network down' },
      { stdout: '1.1.15' },
    ]);
    const resolution = await resolveSquireConnectSpec(run);
    expect(resolution).toEqual({
      npxArgs: ['-y', '@trusty-squire/mcp@latest'],
      resolvedVersion: '1.1.15',
      reResolved: false,
    });
    expect(invocations).toHaveLength(2);
  });

  it('carries the re-resolved spec into the connect invocation', async () => {
    const streamInvocations: string[][] = [];
    const { run } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.15' },
      { stdout: '1.1.15' },
    ]);
    const logs: string[] = [];
    const result = await installSquire({
      workspaceId: 'ws-1',
      streamRun: async (_cmd, args) => {
        streamInvocations.push(['npx', ...args]);
        return {
          stdout: '',
          stderr: '',
          report: report({
            state: 'needs-sign-in',
            sign_in_url: 'https://squire.example/install?token=x',
            browser_location: { kind: 'host_screen' },
          }),
          abort: () => {},
        };
      },
      run,
      log: (message) => logs.push(message),
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(result.status).not.toBe('error');
    expect(streamInvocations[0]).toEqual([
      'npx',
      '-y',
      '@trusty-squire/mcp@1.1.16',
      'connect',
      '--target=codex',
      '--json',
    ]);
    expect(result.steps.find((s) => s.label.startsWith('trusty-squire'))?.status).toBe('done');
    expect(logs.join('\n')).toContain('stale copy');
  });
});

describe('connect session claim', () => {
  it('the streamed runner claims the session with the child pid, and abort kills it', async () => {
    const result = await spawnLongLivedConnect();
    expect(result.report?.state).toBe('needs-sign-in');
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

  it('installSquire releases a live previous claim before spawning connect', async () => {
    await spawnLongLivedConnect();
    const claim = squireConnectSession()!;
    const { run } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.16' },
    ]);
    await installSquire({
      workspaceId: 'ws-1',
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          sign_in_url: 'https://squire.example/install?token=x',
          browser_location: { kind: 'host_screen' },
        }),
      }),
      run,
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
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
    const result = await installSquire({
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
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain(String(holder.pid));
    expect(result.errorMessage).toContain('Finish or close that Trusty Squire session');
    expect(existsSync(dir.lockPath)).toBe(true);
    expect(isProcessAlive(holder.pid)).toBe(true);
    holder.kill();
    dir.cleanup();
  });

  it('recognizes the shared broker claim when its vault answers, preserving the browser', async () => {
    const dir = claimDir();
    const broker = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeLock(dir.lockPath, broker.pid!);
    const { client, calls } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    let startedConnect = false;
    try {
      const result = await installSquire({
        workspaceId: 'ws-1',
        profileDir: dir.profileDir,
        lockRoot: dir.lockRoot,
        run: async (command, args) => {
          expect([command, ...args]).toEqual([
            'systemctl', '--user', 'show', '--property=MainPID', '--value',
            'trusty-squire-broker.service',
          ]);
          return { code: 0, stdout: String(broker.pid), stderr: '' };
        },
        streamRun: async () => {
          startedConnect = true;
          return { stdout: '', stderr: '', abort: () => {} };
        },
        mcp: client,
      });
      expect(result.status).toBe('connected');
      expect(result.signIn).toBeUndefined();
      expect(result.steps.map(({ status }) => status)).toEqual(['done', 'done', 'done', 'done']);
      expect(calls).toEqual([{ tool: 'list_credentials', args: { fields: 'summary' } }]);
      expect(startedConnect).toBe(false);
      expect(existsSync(dir.lockPath)).toBe(true);
      expect(isProcessAlive(broker.pid)).toBe(true);
    } finally {
      broker.kill();
      dir.cleanup();
    }
  });

  it('reads the shared broker pid from launchd on macOS', async () => {
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const dir = claimDir();
    const broker = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeLock(dir.lockPath, broker.pid!);
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    try {
      const result = await installSquire({
        workspaceId: 'ws-1',
        profileDir: dir.profileDir,
        lockRoot: dir.lockRoot,
        run: async (command, args) => {
          expect(command).toBe('launchctl');
          expect(args).toEqual([
            'print', `gui/${process.getuid?.()}/app.usebeeline.trusty-squire-broker`,
          ]);
          return { code: 0, stdout: `state = running\npid = ${broker.pid}\n`, stderr: '' };
        },
        mcp: client,
      });
      expect(result.status).toBe('connected');
    } finally {
      if (previousPlatform) Object.defineProperty(process, 'platform', previousPlatform);
      broker.kill();
      dir.cleanup();
    }
  });

  it('keeps a broker claim and reports a failed vault probe', async () => {
    const dir = claimDir();
    const broker = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeLock(dir.lockPath, broker.pid!);
    try {
      const result = await installSquire({
        workspaceId: 'ws-1',
        profileDir: dir.profileDir,
        lockRoot: dir.lockRoot,
        run: async () => ({ code: 0, stdout: String(broker.pid), stderr: '' }),
        mcp: { call: async () => { throw new Error('vault unavailable'); } },
      });
      expect(result.status).toBe('error');
      expect(result.errorMessage).toBe('vault unavailable');
      expect(existsSync(dir.lockPath)).toBe(true);
      expect(isProcessAlive(broker.pid)).toBe(true);
    } finally {
      broker.kill();
      dir.cleanup();
    }
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

  it('releases a live child claim from this helper’s detached connect group on retry', async () => {
    const dir = claimDir();
    const childPidPath = join(dir.lockRoot, 'child-pid');
    const line = reportLine({
      sign_in_url: 'https://squire.test/vnc#p=1',
      browser_location: { kind: 'virtual', url: 'https://squire.test/vnc#p=1' },
    });
    const first = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        'spawn(process.execPath, ["-e", [',
        '  "const { writeFileSync } = require(\'node:fs\');",',
        '  "process.on(\'SIGTERM\', () => {});",',
        '  "writeFileSync(process.argv[1], String(process.pid));",',
        '  "setInterval(() => {}, 30_000);",',
        '].join("\\n"), process.argv[1]], { stdio: "ignore" });',
        `process.stdout.write(${JSON.stringify(`${line}\n`)});`,
        'setInterval(() => {}, 30_000);',
      ].join('\n'),
      childPidPath,
    ]);
    let childPid: number | undefined;
    try {
      await until(() => existsSync(childPidPath));
      childPid = Number(readFileSync(childPidPath, 'utf8'));
      writeLock(dir.lockPath, childPid);
      const { run } = scriptedRunner([{ stdout: '1.1.16' }, { stdout: '1.1.16' }]);
      const result = await installSquire({
        workspaceId: 'ws-1',
        profileDir: dir.profileDir,
        lockRoot: dir.lockRoot,
        run,
        streamRun: fakeStreamRunner({
          report: report({
            state: 'needs-sign-in',
            sign_in_url: 'https://squire.example/install?token=x',
            browser_location: { kind: 'host_screen' },
          }),
        }),
        mcp: mockSquire({ list_credentials: () => ({}) }).client,
      });
      expect(isProcessAlive(childPid)).toBe(true);
      expect(result.status).not.toBe('error');
      expect(existsSync(dir.lockPath)).toBe(false);
      await until(() => !isProcessAlive(first.pid));
    } finally {
      if (childPid !== undefined && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
      first.abort();
      dir.cleanup();
    }
  });

  it('clears a dead on-disk lock before connect runs', async () => {
    const dir = claimDir();
    writeLock(dir.lockPath, 2_147_483_647);
    const { run } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.16' },
    ]);
    const result = await installSquire({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: fakeStreamRunner({
        report: report({
          state: 'needs-sign-in',
          sign_in_url: 'https://squire.example/install?token=x',
          browser_location: { kind: 'host_screen' },
        }),
      }),
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(result.status).not.toBe('error');
    expect(existsSync(dir.lockPath)).toBe(false);
    dir.cleanup();
  });

  it('pins connect to the helper profile so a foreign Codex config cannot steal the claim', async () => {
    const dir = claimDir();
    let env: NodeJS.ProcessEnv | undefined;
    const { run } = scriptedRunner([
      { stdout: '1.1.16' },
      { stdout: '1.1.16' },
    ]);
    const result = await installSquire({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: async (_command, _args, spawnEnv) => {
        env = spawnEnv;
        return {
          stdout: '',
          stderr: '',
          report: report({
            state: 'needs-sign-in',
            sign_in_url: 'https://squire.example/install?token=x',
            browser_location: { kind: 'host_screen' },
          }),
          abort: () => {},
        };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(result.status).not.toBe('error');
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

  it('reads Squire\u2019s ISO-8601 vault created_at as epoch seconds', () => {
    expect(
      vaultConnectionMeta({ reference: 'cred_1', created_at: '2026-09-18T10:00:00.000Z' }).createdAt,
    ).toBe(Math.floor(Date.parse('2026-09-18T10:00:00.000Z') / 1000));
    expect(vaultConnectionMeta({ reference: 'cred_1', created_at: 1_700_000_000 }).createdAt).toBe(
      1_700_000_000,
    );
    expect(vaultConnectionMeta({ reference: 'cred_1', created_at: 'whenever' }).createdAt).toBe(0);
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
