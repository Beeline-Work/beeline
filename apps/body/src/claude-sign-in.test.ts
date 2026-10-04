import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_SIGN_IN_ATTEMPT_TTL_MS } from '@beeline/api-contract/daemon';
import {
  answerClaudeSignInFrame,
  CLAUDE_OAUTH,
  CLAUDE_SIGN_IN_EXPIRED_MESSAGE,
  CLAUDE_SIGN_IN_REJECTED_MESSAGE,
  CLAUDE_SIGN_IN_WRONG_ATTEMPT_MESSAGE,
  ClaudeSignIn,
} from './claude-sign-in.js';

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const NOW = 1_800_000_000_000;

type Call = { url: string; init: RequestInit | undefined };

function claudeFetch(token: { status: number; body: unknown }, calls: Call[]) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === CLAUDE_OAUTH.tokenUrl)
      return new Response(JSON.stringify(token.body), { status: token.status });
    if (String(url) === CLAUDE_OAUTH.profileUrl)
      return new Response(
        JSON.stringify({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }),
        { status: 200 },
      );
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as unknown as typeof fetch;
}

const GRANTED = {
  token_type: 'Bearer',
  access_token: 'sk-ant-oat01-new-access',
  refresh_token: 'sk-ant-ort01-new-refresh',
  expires_in: 28_800,
  scope: CLAUDE_OAUTH.scopes.join(' '),
};

describe('Sign in to Claude on the agent machine', () => {
  let home: string;
  let now: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'claude-sign-in-'));
    now = NOW;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('saves the login atomically at 0600, keeps other logins, and a Room link reads it at once', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    const shared = join(home, '.claude', '.credentials.json');
    await writeFile(
      shared,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'old', refreshToken: 'dead', expiresAt: NOW - 1 },
        mcpOAuth: { server: { token: 'kept' } },
      }),
      { mode: 0o644 },
    );
    // A Room's isolated Claude home links the shared file (agent-home.ts).
    const roomHome = join(home, 'room', 'claude');
    await mkdir(roomHome, { recursive: true });
    await symlink(shared, join(roomHome, '.credentials.json'));

    const calls: Call[] = [];
    const signIn = new ClaudeSignIn({
      operatorHome: home,
      fetch: claudeFetch({ status: 200, body: GRANTED }, calls),
      now: () => now,
    });
    const link = new URL(signIn.start(ATTEMPT));
    const state = link.searchParams.get('state')!;
    await signIn.complete(ATTEMPT, `the-code#${state}`);

    const request = JSON.parse(String(calls[0]!.init!.body)) as Record<string, string>;
    expect(request.code).toBe('the-code');
    expect(request.state).toBe(state);
    expect(createHash('sha256').update(request.code_verifier!).digest('base64url')).toBe(
      link.searchParams.get('code_challenge'),
    );

    const saved = JSON.parse(await readFile(join(roomHome, '.credentials.json'), 'utf8'));
    expect(saved).toEqual({
      claudeAiOauth: {
        accessToken: GRANTED.access_token,
        refreshToken: GRANTED.refresh_token,
        expiresAt: NOW + GRANTED.expires_in * 1000,
        scopes: [...CLAUDE_OAUTH.scopes],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
      mcpOAuth: { server: { token: 'kept' } },
    });
    expect((await stat(shared)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(home, '.claude'))).toEqual(['.credentials.json']);
    // The attempt is spent: a second paste cannot replay it.
    await expect(signIn.complete(ATTEMPT, `the-code#${state}`)).rejects.toThrow(
      CLAUDE_SIGN_IN_EXPIRED_MESSAGE,
    );
  });

  it('creates the shared Claude directory and file when none exists yet', async () => {
    const signIn = new ClaudeSignIn({
      operatorHome: home,
      fetch: claudeFetch({ status: 200, body: GRANTED }, []),
      now: () => now,
    });
    signIn.start(ATTEMPT);
    await signIn.complete(ATTEMPT, 'bare-code');
    const shared = join(home, '.claude', '.credentials.json');
    expect(JSON.parse(await readFile(shared, 'utf8')).claudeAiOauth.accessToken).toBe(
      GRANTED.access_token,
    );
    expect((await stat(shared)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.claude'))).mode & 0o777).toBe(0o700);
  });

  it('rejects a bad code, writes nothing, and lets the owner paste again', async () => {
    const token = { status: 400, body: { error: 'invalid_grant' } };
    const signIn = new ClaudeSignIn({ operatorHome: home, fetch: claudeFetch(token, []), now: () => now });
    signIn.start(ATTEMPT);
    await expect(signIn.complete(ATTEMPT, 'typo')).rejects.toThrow(CLAUDE_SIGN_IN_REJECTED_MESSAGE);
    await expect(stat(join(home, '.claude', '.credentials.json'))).rejects.toThrow();
    token.status = 200;
    token.body = GRANTED as never;
    await signIn.complete(ATTEMPT, 'right-code');
    expect(
      JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth
        .refreshToken,
    ).toBe(GRANTED.refresh_token);
  });

  it('refuses an expired attempt and a code from another sign-in', async () => {
    const calls: Call[] = [];
    const signIn = new ClaudeSignIn({
      operatorHome: home,
      fetch: claudeFetch({ status: 200, body: GRANTED }, calls),
      now: () => now,
    });
    signIn.start(ATTEMPT);
    await expect(signIn.complete(ATTEMPT, 'code#someone-elses-state')).rejects.toThrow(
      CLAUDE_SIGN_IN_WRONG_ATTEMPT_MESSAGE,
    );
    now += CLAUDE_SIGN_IN_ATTEMPT_TTL_MS + 1;
    await expect(signIn.complete(ATTEMPT, 'code')).rejects.toThrow(CLAUDE_SIGN_IN_EXPIRED_MESSAGE);
    await expect(signIn.complete('never-started', 'code')).rejects.toThrow(
      CLAUDE_SIGN_IN_EXPIRED_MESSAGE,
    );
    expect(calls).toEqual([]);
  });

  it('reports each step to the server and never logs or reports the code', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const signIn = new ClaudeSignIn({
      operatorHome: home,
      fetch: claudeFetch({ status: 401, body: {} }, []),
      now: () => now,
    });
    await answerClaudeSignInFrame({ execute }, 'agent', signIn, {
      type: 'claude-sign-in',
      step: 'start',
      attemptId: ATTEMPT,
    }, (line) => logs.push(line));
    expect(execute).toHaveBeenLastCalledWith('reportClaudeSignIn', {
      agentId: 'agent',
      attemptId: ATTEMPT,
      authorizeUrl: expect.stringMatching(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/),
    });
    await answerClaudeSignInFrame({ execute }, 'agent', signIn, {
      type: 'claude-sign-in',
      step: 'code',
      attemptId: ATTEMPT,
      code: 'secret-pasted-code',
    }, (line) => logs.push(line));
    expect(execute).toHaveBeenLastCalledWith('reportClaudeSignIn', {
      agentId: 'agent',
      attemptId: ATTEMPT,
      outcome: 'failed',
      error: CLAUDE_SIGN_IN_REJECTED_MESSAGE,
    });
    expect(JSON.stringify([execute.mock.calls, logs])).not.toContain('secret-pasted-code');
  });
});
