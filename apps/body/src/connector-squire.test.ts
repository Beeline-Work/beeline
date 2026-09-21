import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  connectionGrant,
  connectionLedgerEntry,
  CONNECT_TIMEOUT_MS,
  defaultStreamedRunner,
  installSquire,
  isProcessAlive,
  isSquireBrowserSessionFailure,
  parseConnectAlreadyConnected,
  parseConnectOutput,
  readConnectionDetail,
  readConnectionLedger,
  readGrants,
  readVault,
  reclaimSquireProfileClaim,
  nameSquireConnectClaim,
  readVaultFromSession,
  releaseSquireConnectSession,
  resolveSquireConnectSpec,
  SQUIRE_ACCOUNT_UNPROVEN,
  takeSquireConnectClaim,
  revokeGrants,
  squireConnectProcessEnv,
  squireConnectSession,
  squireProfileLockPath,
  unframeBoxedOutput,
  vaultConnectionMeta,
  type ShellRunner,
  type StreamedShellRunner,
  type SquireMcpClient,
} from './connector-squire.js';
import {
  credentialFromSession,
  noteSquireVaultAuth,
  publishedSquireVisibility,
  publishSquireVisibility,
  resetSquireConnectFacts,
} from './squire-connect-state.js';

// The host home owns the shared profile, the connect claim, and the session
// file, so every default path in this file is re-rooted at a scratch home.
let previousHome: string | undefined;
let isolatedHome: string;
beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'squire-home-'));
  previousHome = process.env.HOME;
  process.env.HOME = isolatedHome;
  resetSquireConnectFacts();
});
afterEach(() => {
  resetSquireConnectFacts();
  releaseSquireConnectSession();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

/** The session file a real `connect` writes once the account is signed in. */
function writeHostSession(accountId = 'acct_9'): void {
  const dir = join(isolatedHome, '.config', 'trusty-squire');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({
      api_base_url: 'https://vault.test',
      account_id: accountId,
      agent_session_token: 'tok',
    }),
  );
}

/** The account vault's answer for the session token (never a real host). */
function vaultAnswers(status = 200): typeof fetch {
  return (async () =>
    new Response(status === 200 ? JSON.stringify({ credentials: [] }) : '', {
      status,
    })) as unknown as typeof fetch;
}

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
  signIn?: { method: 'streamed-page'; url: string };
}): StreamedShellRunner {
  return async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signIn: result.signIn,
    abort: () => {},
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

  it('is undefined when connect printed no URL', () => {
    expect(parseConnectOutput('nothing useful here')).toBeUndefined();
  });

  it('reports the hosted install page as a streamed page', () => {
    const signIn = parseConnectOutput(
      'Open this in your browser to finish: https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqmXeQUojqvHNwnpta3vv5p\n',
    );
    expect(signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqmXeQUojqvHNwnpta3vv5p',
    });
  });

  it('ignores a marketing trustysquire.ai origin printed before the ceremony URL', () => {
    const signIn = parseConnectOutput(
      'Docs: https://trustysquire.ai\nOpen this: https://trustysquire.ai/install?token=secret\n',
    );
    expect(signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=secret',
    });
  });

  it('prefers a known ceremony surface over an earlier unknown URL', () => {
    const signIn = parseConnectOutput(
      'Visit https://trustysquire.ai for help\nOpen this: https://tunnel.test/#p=hunter22\n',
    );
    expect(signIn).toEqual({ method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' });
  });

  it('falls OPEN to the best remaining candidate when no known surface matched', () => {
    // The day Squire serves its ceremony from a surface nobody anticipated,
    // the picker still hands the person a page instead of returning nothing.
    expect(parseConnectOutput('Visit https://trustysquire.ai for help\n')).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai',
    });
    expect(parseConnectOutput('Sign in: https://squire.example/oauth/authorize?state=abc\n')).toEqual({
      method: 'streamed-page',
      url: 'https://squire.example/oauth/authorize?state=abc',
    });
  });

  it('takes the bare install confirm page', () => {
    expect(parseConnectOutput('Open https://trustysquire.ai/install\n')).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install',
    });
  });

  it('keeps the negative npm and Cloudflare exclusions, which fail open', () => {
    // npm's update notifier writes this to the connect child's stderr, and a
    // failed tunnel rig puts Cloudflare's docs link in the stderr tail Squire
    // quotes back. These are NEGATIVE rules: with them as the only candidates
    // there is nothing worth falling back to, but a known surface among them
    // still wins outright (tested above).
    expect(
      parseConnectOutput(
        'npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.9.2\n',
      ),
    ).toBeUndefined();
    expect(
      parseConnectOutput(
        'cloudflared: see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps for details\n',
      ),
    ).toBeUndefined();
    // A github.com URL that is NOT npm's changelog stays a fallback candidate.
    expect(parseConnectOutput('See https://github.com/trusty-squire/mcp for docs\n')).toEqual({
      method: 'streamed-page',
      url: 'https://github.com/trusty-squire/mcp',
    });
  });

  it('takes the real ceremony out of a stream that carries foreign URLs first', () => {
    expect(
      parseConnectOutput(
        'npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.9.2\n' +
          'Open this on any device: https://tunnel.test/#p=hunter22\n',
      ),
    ).toEqual({ method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' });
  });

  it('does not read the install-page banner as a sign-in surface', () => {
    expect(
      parseConnectOutput(
        'Opening the Trusty Squire install page in a browser. The page walks you through signing in with Google.\n',
      ),
    ).toBeUndefined();
  });

  it('takes only the VERIFIED short-circuit for connected', () => {
    expect(
      parseConnectAlreadyConnected(
        'Already connected (google + github). Codex config refreshed.\n',
      ),
    ).toBe(true);
    // Squire refreshed the config but says in its own words that it will not
    // call this connected; reporting it green would strand an expired session
    // with no way back to a ceremony.
    expect(
      parseConnectAlreadyConnected(
        "This machine is bound to your account, but I couldn't verify a live provider session " +
          'in the bot\u2019s Chrome profile (profile busy), so I won\u2019t call this connected. ' +
          'Your agent config was refreshed.\n',
      ),
    ).toBe(false);
    expect(parseConnectAlreadyConnected('Opening the Trusty Squire install page\n')).toBe(false);
  });

  // Squire's `printRemoteLoginBanner` output, captured verbatim from the real
  // boxen render at its piped 78-column width. That rendered frame is the only
  // place connect prints the tunnel, so it is the byte contract this parser
  // reads. SQUIRE_PADDING is Squire's own explicit `{left:1,right:1}`;
  // BOXEN_SHORTHAND_PADDING is boxen's `padding: 1`, which is THREE columns —
  // the URL wraps at a different column, and a rejoin that assumed one space
  // published `…/#p=hunter2`, a URL the phone accepts and cannot load.
  const SQUIRE_PADDING = {
    url: "https://terminology-alberta-dictionaries-kde-extra.trycloudflare.com/#p=hunter22",
    banner: [
      "┌ Sign in to Trusty Squire ──────────────────────────────────────────────────┐",
      "│ Open this on any device, any network:                                      │",
      "│                                                                            │",
      "│ https://terminology-alberta-dictionaries-kde-extra.trycloudflare.com/#p=hu │",
      "│ nter22                                                                     │",
      "│                                                                            │",
      "│ If asked for a VNC password:  hunter22                                     │",
      "│                                                                            │",
      "│ Remote login for Trusty Squire                                             │",
      "└────────────────────────────────────────────────────────────────────────────┘",
    ].join('\n'),
  };
  const BOXEN_SHORTHAND_PADDING = {
    url: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.trycloudflare.com/#p=hunter22",
    banner: [
      "┌ Sign in to Trusty Squire ──────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│   Open this on any device, any network:                                    │",
      "│                                                                            │",
      "│   https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.trycloudflare.com/#p=hunter2   │",
      "│   2                                                                        │",
      "│                                                                            │",
      "│   If asked for a VNC password:  hunter22                                   │",
      "│                                                                            │",
      "│   Remote login for Trusty Squire                                           │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
    ].join('\n'),
  };

  it('rejoins a ceremony URL boxen hard-wrapped across two frame rows', () => {
    for (const render of [SQUIRE_PADDING, BOXEN_SHORTHAND_PADDING]) {
      expect(parseConnectOutput(`${render.banner}\n`)).toEqual({
        method: 'streamed-page',
        url: render.url,
      });
    }
  });

  it('publishes nothing from a frame whose closing border has not arrived', () => {
    // The runner re-reads the whole buffer per chunk, so every prefix of the
    // banner is a real delivery state. None of them may yield a URL: the row
    // holding the wrapped head parses as a valid `#p=` tunnel on its own.
    for (const render of [SQUIRE_PADDING, BOXEN_SHORTHAND_PADDING]) {
      const rows = render.banner.split('\n');
      for (let count = 1; count < rows.length; count += 1) {
        expect(parseConnectOutput(`${rows.slice(0, count).join('\n')}\n`)).toBeUndefined();
      }
      expect(parseConnectOutput(`${render.banner}\n`)).toEqual({
        method: 'streamed-page',
        url: render.url,
      });
    }
  });

  it('keeps a frame\u2019s other rows as their own lines', () => {
    for (const render of [SQUIRE_PADDING, BOXEN_SHORTHAND_PADDING]) {
      const lines = unframeBoxedOutput(render.banner)
        .split('\n')
        .map((line) => line.trim());
      expect(lines).toContain('If asked for a VNC password:  hunter22');
      expect(lines).toContain('Remote login for Trusty Squire');
      expect(lines).toContain(render.url);
    }
  });

  it('leaves an unterminated URL alone until the rest of the chunk arrives', () => {
    const partial = 'Open this on any device: https://tunnel.test/#p=hunt';
    expect(parseConnectOutput(partial)).toBeUndefined();
    expect(parseConnectOutput(`${partial}er22\n`)).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.test/#p=hunter22',
    });
  });
});

describe('defaultStreamedRunner', () => {
  it('never publishes a URL a chunk boundary cut in half', async () => {
    // The runner re-reads its buffers on every chunk. Writing the ceremony in
    // two pieces with no newline between them is an ordinary pipe split, and
    // the first piece is a perfectly valid `/install` URL with a short token.
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        'process.stdout.write("Open this: https://trustysquire.ai/install?token=q2Xt");',
        'setTimeout(() => {',
        '  process.stdout.write("G7fnTfe7wKqm\\n");',
        '}, 120);',
        'setInterval(() => {}, 30_000);',
      ].join(''),
    ]);
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqm',
    });
    result.abort();
    releaseSquireConnectSession();
  });

  it('still reads a ceremony a child printed with no trailing newline', async () => {
    // The buffers are complete once the child is gone, so its last line is a
    // whole one; dropping it would lose the only URL connect ever printed.
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      'process.stdout.write("Open this: https://tunnel.test/#p=hunter22");',
    ]);
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.test/#p=hunter22',
    });
    releaseSquireConnectSession();
  });

  it('keeps reaping an abandoned ceremony after its URL is published', async () => {
    // Nothing downstream reaps the connect once the connector row leaves
    // `installing`, so the runner's own bound is what keeps the display rig
    // from living for the daemon's lifetime.
    const sleep = ((real) => (ms: number) => new Promise((done) => real(done, ms)))(setTimeout);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = await defaultStreamedRunner(process.execPath, [
        '-e',
        'console.log("Open this on any device: https://tunnel.test/#p=hunter22");' +
          'setInterval(() => {}, 30_000);',
      ]);
      expect(result.signIn?.url).toBe('https://tunnel.test/#p=hunter22');
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

  it('waits for the ceremony URL Squire prints after its install-page banner', async () => {
    const result = await defaultStreamedRunner(process.execPath, [
      '-e',
      [
        'console.log("Opening the Trusty Squire install page in a browser.");',
        'setTimeout(() => {',
        '  console.log("Open this on any device: https://tunnel.test/#p=hunter2");',
        '}, 120);',
        'setInterval(() => {}, 30_000);',
      ].join(''),
    ]);
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.test/#p=hunter2',
    });
    // The ceremony is published and its process is still running: the result
    // names that process, which is what keeps the shared claim held.
    expect(isProcessAlive(result.pid)).toBe(true);
    result.abort();
    releaseSquireConnectSession();
  });
});

describe('installSquire', () => {
  it('retires an abandoned ceremony instead of handing its dead URL back', async () => {
    // Nothing is running that tunnel any more, so re-serving it would leave
    // the person pressing a dead link until the ceremony's own clock ran out.
    publishSquireVisibility({ kind: 'remote', held: true, url: 'https://tunnel.test/#p=dead' });
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: async () => {
        started += 1;
        return {
          stdout: '',
          stderr: '',
          signIn: { method: 'streamed-page' as const, url: 'https://tunnel.test/#p=fresh' },
          abort: () => {},
        };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(started).toBe(1);
    expect(result.status).toBe('installing');
    expect(result.signIn?.url).toBe('https://tunnel.test/#p=fresh');
  });

  it('starts a fresh connect once the published ceremony is released', async () => {
    // The ceremony died with its connect (the expiry path releases the
    // session), so the next attempt must raise a new one instead of handing
    // the person the dead tunnel forever.
    publishSquireVisibility({ kind: 'remote', held: true, url: 'https://tunnel.test/#p=dead' });
    releaseSquireConnectSession();
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: async () => {
        started += 1;
        return {
          stdout: '',
          stderr: '',
          signIn: { method: 'streamed-page' as const, url: 'https://tunnel.test/#p=fresh' },
          abort: () => {},
        };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(started).toBe(1);
    expect(result.signIn?.url).toBe('https://tunnel.test/#p=fresh');
  });

  it('stays installing while the ceremony it printed is outstanding', async () => {
    const { client, calls } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'Open this in your browser: https://trustysquire.ai/install?token=secret\n',
        signIn: { method: 'streamed-page', url: 'https://trustysquire.ai/install?token=secret' },
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

  it('verifies the resolved version, then runs connect on the @latest spec', async () => {
    const streamInvocations: string[][] = [];
    const { run, invocations } = scriptedRunner([{ stdout: '1.1.14' }, { stdout: '1.1.14' }]);
    await installSquire({
      workspaceId: 'ws-1',
      streamRun: async (_cmd, args) => {
        streamInvocations.push(['npx', ...args]);
        return {
          stdout: 'https://tunnel.test/#p=hunter22',
          stderr: '',
          signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
          abort: () => {},
        };
      },
      run,
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    // Verification (registry read + npx probe) happens BEFORE connect runs.
    expect(invocations).toEqual([
      ['npm', 'view', '@trusty-squire/mcp', 'version'],
      ['npx', '-y', '@trusty-squire/mcp@latest', '--version'],
    ]);
    expect(streamInvocations).toEqual([
      ['npx', '-y', '@trusty-squire/mcp@latest', 'connect', '--target=codex'],
    ]);
  });

  it('fails with a clear reason when the streamed connect command errors with no URL', async () => {
    const result = await installSquire({
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

  it('fails the sign-in step when streamed connect prints no URL', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({ signIn: undefined }),
    });
    expect(result.status).toBe('error');
    expect(
      result.steps.find((step) => step.label === 'trusty-squire installed')?.reason,
    ).toContain('no sign-in URL');
  });

  it('reports Squire\u2019s already-connected short-circuit as connected, not failed', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: vaultAnswers(),
      streamRun: async (...args: Parameters<StreamedShellRunner>) => {
        writeHostSession();
        return fakeStreamRunner({
          stdout:
            'Already connected (google + github). Codex config refreshed.\n' +
            'Pass --force-relogin to switch accounts or to refresh a stale/expired session.\n',
        })(...args);
      },
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(result.status).toBe('connected');
    expect(result.signIn).toBeNull();
    expect(result.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(result.steps.map((step) => step.reason ?? '').join(' ')).not.toContain('force-relogin');
    // `signedInAs` is an email or handle; an opaque account id is not one,
    // so the Workbench line stays absent rather than printing a ULID.
    expect(result.signedInAs).toBeUndefined();
  });

  it('still calls Squire when the session token is alive', async () => {
    // Connect/Retry is the only way to re-establish the bot profile's
    // provider session, and Squire — not this helper — decides whether a
    // ceremony is needed, so a live token must not short-circuit the run.
    writeHostSession();
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: vaultAnswers(),
      streamRun: async (...args: Parameters<StreamedShellRunner>) => {
        started += 1;
        return fakeStreamRunner({
          stdout: 'Already connected (google + github). Codex config refreshed.\n',
        })(...args);
      },
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(started).toBe(1);
    expect(result.status).toBe('connected');
  });

  it('does not call itself paired when this helper\u2019s Squire surface is unreachable', async () => {
    // The session file is shared across every helper on the host, so a live
    // token proves the ACCOUNT, never that THIS helper can reach Squire.
    writeHostSession();
    const unreachable: SquireMcpClient = {
      async call() {
        throw new Error('broker unavailable');
      },
    };
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: vaultAnswers(),
      streamRun: fakeStreamRunner({
        stdout: 'Already connected (google + github). Codex config refreshed.\n',
      }),
      mcp: unreachable,
    });
    expect(result.status).toBe('installing');
    const paired = result.steps.find((step) => step.label === 'paired to workspace');
    expect(paired?.status).toBe('failed');
    expect(paired?.reason).toContain('broker unavailable');
  });

  it('does not report an unverified profile as connected, and never quotes the cookie-clear hint', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stderr:
          "This machine is bound to your account, but I couldn't verify a live provider session " +
          'in the bot\u2019s Chrome profile (profile busy), so I won\u2019t call this connected. ' +
          'Your agent config was refreshed.\n' +
          'Close any other Trusty Squire session and re-run ' +
          'npx @trusty-squire/mcp connect --force-relogin to verify it.\n',
      }),
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(result.status).toBe('error');
    const said = `${result.errorMessage ?? ''} ${result.steps.map((step) => step.reason ?? '').join(' ')}`;
    expect(said).not.toContain('force-relogin');
    expect(said).toContain("couldn't verify a live provider session");
  });

  it('marks the connector connected only once a run prints no ceremony at all', async () => {
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: vaultAnswers(),
      // The human finished on the tunnel the previous run published, so this
      // run prints no URL and leaves a signed-in session behind.
      streamRun: async (...args: Parameters<StreamedShellRunner>) => {
        writeHostSession();
        return fakeStreamRunner({
          stdout: 'Already connected (google + github). Codex config refreshed.\n',
        })(...args);
      },
      mcp: client,
    });
    expect(result.status).toBe('connected');
    expect(result.signIn).toBeNull();
    expect(result.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('calls a session valid when Squire wrote no account id', async () => {
    // Squire stores `account_id: ""` for an unbound account, so a helper that
    // is genuinely signed in must not read as expired and re-connect forever.
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: vaultAnswers(),
      streamRun: async (...args: Parameters<StreamedShellRunner>) => {
        writeHostSession('');
        return fakeStreamRunner({
          stdout: 'Already connected (google + github). Codex config refreshed.\n',
        })(...args);
      },
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(result.status).toBe('connected');
  });

  it('keeps its own live ceremony published while it waits on the account', async () => {
    // A restart-free wait on an unreachable account must not retire the
    // surface this helper's own connect is still serving, nor report that
    // this run found no ceremony.
    const ceremony = await defaultStreamedRunner(process.execPath, [
      '-e',
      'console.log("Open this on any device: https://tunnel.test/#p=mine");' +
        'setInterval(() => {}, 30_000);',
    ]);
    expect(ceremony.signIn?.url).toBe('https://tunnel.test/#p=mine');
    publishSquireVisibility({ kind: 'remote', held: true, url: 'https://tunnel.test/#p=mine' });
    writeHostSession();
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND vault.test');
      }) as unknown as typeof fetch,
      streamRun: async () => {
        started += 1;
        return { stdout: '', stderr: '', abort: () => {} };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(started).toBe(0);
    expect(result.signIn).toBeUndefined();
    expect(publishedSquireVisibility()).toEqual({
      kind: 'remote',
      held: true,
      url: 'https://tunnel.test/#p=mine',
    });
    ceremony.abort();
    releaseSquireConnectSession();
  });

  it('waits on an account that never answered instead of raising another browser', async () => {
    // A 5xx / rate limit / dead network is not a refusal: the session is
    // simply unconfirmed, so nothing may spawn a second connect over it.
    writeHostSession();
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND vault.test');
      }) as unknown as typeof fetch,
      streamRun: async () => {
        started += 1;
        return { stdout: '', stderr: '', abort: () => {} };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(started).toBe(0);
    expect(result.status).toBe('installing');
    const waiting = result.steps.find((step) => step.label === 'waiting for sign-in');
    expect(waiting?.status).toBe('running');
    expect(waiting?.reason).toBe(SQUIRE_ACCOUNT_UNPROVEN);
  });

  it('says why the row is still installing when the account stopped answering', async () => {
    // The connect left a session behind and Squire called it already
    // connected, but the account never answered for it. The row must say so
    // rather than sit on four done steps with nothing to press.
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND vault.test');
      }) as unknown as typeof fetch,
      streamRun: async (...args: Parameters<StreamedShellRunner>) => {
        started += 1;
        writeHostSession();
        return fakeStreamRunner({
          stdout: 'Already connected (google + github). Codex config refreshed.\n',
        })(...args);
      },
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(started).toBe(1);
    expect(result.status).toBe('installing');
    expect(result.errorMessage).toBeUndefined();
    const waiting = result.steps.find((step) => step.label === 'waiting for sign-in');
    expect(waiting?.status).toBe('running');
    expect(waiting?.reason).toBe(SQUIRE_ACCOUNT_UNPROVEN);
  });

  it('sends an expired session back to a fresh ceremony, not to connected', async () => {
    // The session file is still on disk but the account refuses its token,
    // so pressing Connect must raise a new ceremony rather than report a
    // dead account as connected forever.
    writeHostSession();
    let started = 0;
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      fetch: vaultAnswers(401),
      streamRun: async () => {
        started += 1;
        return {
          stdout: '',
          stderr: '',
          signIn: { method: 'streamed-page' as const, url: 'https://tunnel.test/#p=again' },
          abort: () => {},
        };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(started).toBe(1);
    expect(result.status).toBe('installing');
    expect(result.signIn?.url).toBe('https://tunnel.test/#p=again');
  });

  it('does not call a helper connected on Squire\u2019s sentence alone', async () => {
    // Squire says the machine is already connected but left no session this
    // helper owns, so the app's own fact — not the wording — decides.
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'Already connected (google + github). Codex config refreshed.\n',
      }),
      mcp: mockSquire({ list_credentials: () => ({ credentials: [] }) }).client,
    });
    expect(result.status).toBe('installing');
  });

  it('surfaces the signIn URL on the installing result before the pairing probe', async () => {
    const failing: SquireMcpClient = {
      async call() {
        throw new Error('squire unreachable');
      },
    };
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'https://tunnel.example/vnc.html#p=x\n',
        signIn: { method: 'streamed-page', url: 'https://tunnel.example/vnc.html#p=x' },
      }),
      mcp: failing,
    });
    expect(result.status).toBe('installing');
    expect(result.signIn).toBeDefined();
    expect(result.signIn!.url).toBe('https://tunnel.example/vnc.html#p=x');
    expect(result.signIn!.method).toBe('streamed-page');
    expect(
      result.steps.find((step) => step.label === 'paired to workspace')?.reason,
    ).toContain('squire unreachable');
  });

  it('emits the waiting-for-sign-in step via onProgress before the connect process would exit', async () => {
    const progressSteps: string[][] = [];
    let capturedSignIn: { method: string; url: string } | undefined;
    const { client } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    await installSquire({
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
        if (last?.label === 'waiting for sign-in') {
          capturedSignIn = { method: 'streamed-page', url: 'https://vnc.trustysquire.ai/#p=secret' };
        }
      },
      mcp: client,
    });
    // The waiting-for-sign-in step must appear before the final connected result.
    expect(capturedSignIn).toBeDefined();
    // The progress must have emitted the sign-in step label.
    expect(
      progressSteps.some((labels) => labels.includes('waiting for sign-in')),
    ).toBe(true);
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
    const result = await installSquire({
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
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(result.status).not.toBe('error');
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

  it('installSquire releases a live previous claim before spawning connect', async () => {
    await spawnLongLivedConnect();
    const claim = squireConnectSession()!;
    const { run } = scriptedRunner([{ stdout: '1.1.14' }, { stdout: '1.1.14' }]);
    await installSquire({
      workspaceId: 'ws-1',
      streamRun: async () => ({
        stdout: 'https://squire.example/install?token=x',
        stderr: '',
        signIn: { method: 'streamed-page', url: 'https://squire.example/install?token=x' },
        abort: () => {},
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

  it('does not kill a live foreign owner; installSquire waits on it by name', async () => {
    const dir = claimDir();
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeLock(dir.lockPath, holder.pid!);
    // This helper printed a ceremony once; the browser is somebody else's
    // now, so that surface is over and must not be served again.
    publishSquireVisibility({ kind: 'remote', held: true, url: 'https://tunnel.test/#p=mine' });
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
    // A sign-in in progress holds the browser and everyone else waits: the
    // row stays installing rather than erroring on every poll until it ends.
    expect(result.status).toBe('installing');
    expect(result.errorMessage).toBeUndefined();
    expect(result.signIn).toBeUndefined();
    const waiting = result.steps.find((step) => step.label === 'waiting for sign-in');
    expect(waiting?.status).toBe('running');
    expect(waiting?.reason).toContain(String(holder.pid));
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
    const result = await installSquire({
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
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain(String(holder.pid));
    expect(result.errorMessage).toContain('Finish or close that Trusty Squire session');
    expect(result.errorMessage).not.toMatch(/close it first/i);
    expect(existsSync(dir.lockPath)).toBe(true);
    holder.kill();
    dir.cleanup();
  });

  it('clears a dead on-disk lock before connect runs', async () => {
    const dir = claimDir();
    writeLock(dir.lockPath, 2_147_483_647);
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await installSquire({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: fakeStreamRunner({
        stdout: 'https://squire.example/install?token=x',
        signIn: { method: 'streamed-page', url: 'https://squire.example/install?token=x' },
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
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await installSquire({
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

  it('gives the shared profile to one helper when two arrive together', async () => {
    // Squire's own lock lives in each unit's PrivateTmp /tmp, so the claim in
    // the shared profile directory is what the second helper can see at all.
    const dir = claimDir();
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    const first = takeSquireConnectClaim({ profileDir: dir.profileDir });
    expect(first.kind).toBe('taken');
    if (first.kind !== 'taken') throw new Error('claim not taken');
    nameSquireConnectClaim(first.path, holder.pid!);

    const second = takeSquireConnectClaim({ profileDir: dir.profileDir });
    expect(second.kind).toBe('blocked-foreign');

    let streamed = false;
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await installSquire({
      workspaceId: 'ws-2',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: async () => {
        streamed = true;
        return { stdout: '', stderr: '', abort: () => {} };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(streamed).toBe(false);
    expect(result.status).toBe('installing');
    expect(
      result.steps.find((step) => step.label === 'waiting for sign-in')?.reason,
    ).toContain(String(holder.pid));

    holder.kill();
    dir.cleanup();
  });

  it('keeps the shared claim for the whole ceremony it published', async () => {
    const dir = claimDir();
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    const { run } = scriptedRunner([{ stdout: '1.1.15' }, { stdout: '1.1.15' }]);
    const result = await installSquire({
      workspaceId: 'ws-1',
      profileDir: dir.profileDir,
      lockRoot: dir.lockRoot,
      run,
      streamRun: async () => ({
        stdout: '',
        stderr: '',
        pid: holder.pid!,
        signIn: { method: 'streamed-page' as const, url: 'https://tunnel.test/#p=live' },
        abort: () => {},
      }),
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(result.signIn?.url).toBe('https://tunnel.test/#p=live');
    // A sibling helper arriving mid-ceremony must find the browser taken.
    expect(takeSquireConnectClaim({ profileDir: dir.profileDir }).kind).toBe('blocked-foreign');
    holder.kill();
    dir.cleanup();
  });

  it('frees the shared claim once the connect that held it is gone', async () => {
    const dir = claimDir();
    const taken = takeSquireConnectClaim({ profileDir: dir.profileDir });
    if (taken.kind !== 'taken') throw new Error('claim not taken');
    nameSquireConnectClaim(taken.path, 2_147_483_647);
    const again = takeSquireConnectClaim({ profileDir: dir.profileDir });
    expect(again.kind).toBe('taken');
    dir.cleanup();
  });
});

describe('vault reads from the session file', () => {
  function sessionHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'squire-session-'));
    mkdirSync(join(home, 'trusty-squire'));
    writeFileSync(
      join(home, 'trusty-squire', 'session.json'),
      JSON.stringify({
        api_base_url: 'https://vault.test',
        account_id: 'acct_9',
        agent_session_token: 'tok',
      }),
    );
    return home;
  }

  it('lists KEYS from the session token without a broker', async () => {
    const home = sessionHome();
    const vault = await readVaultFromSession({
      configHome: home,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://vault.test/v1/vault/credentials');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        return new Response(
          JSON.stringify({
            credentials: [
              {
                reference: 'cred_groq',
                service: 'groq',
                label: 'Groq API',
                created_at: '2026-09-20T03:24:15.020Z',
              },
            ],
          }),
        );
      },
    });
    expect(vault).toEqual([
      expect.objectContaining({
        reference: 'cred_groq',
        label: 'Groq API',
        // The one mapper parses Squire's ISO-8601 stamp; a flattened 0 would
        // date every key from the row's own insert time instead.
        createdAt: Math.floor(Date.parse('2026-09-20T03:24:15.020Z') / 1000),
      }),
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  it('treats a refused vault read as an expired credential', async () => {
    const home = sessionHome();
    for (const status of [401, 403]) {
      noteSquireVaultAuth('ok');
      expect(
        await readVaultFromSession({
          configHome: home,
          fetch: async () => new Response('', { status }),
        }),
      ).toBeUndefined();
      expect(
        credentialFromSession({
          apiBaseUrl: 'https://vault.test',
          accountId: 'acct_9',
          agentSessionToken: 'tok',
        }),
      ).toEqual({ kind: 'expired' });
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('leaves a proven token alone when the vault only failed to answer', async () => {
    // Squire keeps a session through a blip; so does this reader — only a
    // refusal retires the token.
    const home = sessionHome();
    noteSquireVaultAuth('ok');
    expect(
      await readVaultFromSession({
        configHome: home,
        fetch: async () => new Response('', { status: 500 }),
      }),
    ).toBeUndefined();
    expect(
      credentialFromSession({
        apiBaseUrl: 'https://vault.test',
        accountId: 'acct_9',
        agentSessionToken: 'tok',
      }),
    ).toEqual({ kind: 'valid' });
    rmSync(home, { recursive: true, force: true });
  });

  it('leaves an unrecognised body to the MCP read instead of blanking KEYS', async () => {
    const home = sessionHome();
    expect(
      await readVaultFromSession({
        configHome: home,
        fetch: async () => new Response(JSON.stringify({ data: 'something else' })),
      }),
    ).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not invent KEYS when there is no session', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'squire-session-'));
    expect(await readVaultFromSession({ configHome: empty })).toBeUndefined();
    rmSync(empty, { recursive: true, force: true });
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
