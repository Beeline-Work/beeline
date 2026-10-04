/**
 * Contract for Claude's OAuth login, which is not a public API. These tests
 * pin the exact request this helper sends and the response fields it reads,
 * so a change on either side fails here, loudly, before it reaches an owner.
 * When Claude Code is installed next to this Node, its bundled OAuth config
 * must still name the same endpoints, client and scopes.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH,
  ClaudeSignIn,
  ClaudeSignInShapeError,
  parseClaudeTokenResponse,
} from './claude-sign-in.js';

/** The token answer's shape as Claude Code 2.1.280 reads it. */
const TOKEN_RESPONSE = {
  token_type: 'Bearer',
  access_token: 'sk-ant-oat01-access',
  refresh_token: 'sk-ant-ort01-refresh',
  expires_in: 28_800,
  scope: 'user:inference user:profile user:sessions:claude_code',
  account: { uuid: 'account-uuid', email_address: 'owner@example.com' },
  organization: { uuid: 'org-uuid', name: 'Org' },
};

describe("Claude's OAuth login contract", () => {
  it('builds the authorize link Claude Code builds for a manual-paste login', () => {
    const signIn = new ClaudeSignIn({ operatorHome: tmpdir(), fetch: vi.fn() as never });
    const url = new URL(signIn.start('00000000-0000-4000-8000-000000000001'));
    expect(`${url.origin}${url.pathname}`).toBe('https://claude.com/cai/oauth/authorize');
    expect([...url.searchParams.keys()]).toEqual([
      'code',
      'client_id',
      'response_type',
      'redirect_uri',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'state',
    ]);
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')!.split(' ')).toContain('user:inference');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('posts exactly the token exchange body Claude Code posts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-contract-'));
    try {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return String(url) === CLAUDE_OAUTH.tokenUrl
          ? new Response(JSON.stringify(TOKEN_RESPONSE), { status: 200 })
          : new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;
      const signIn = new ClaudeSignIn({ operatorHome: home, fetch: fetchImpl });
      signIn.start('00000000-0000-4000-8000-000000000001');
      await signIn.complete('00000000-0000-4000-8000-000000000001', 'the-code');
      const token = calls[0]!;
      expect(token.url).toBe('https://platform.claude.com/v1/oauth/token');
      expect(token.init?.method).toBe('POST');
      expect(new Headers(token.init?.headers).get('content-type')).toBe('application/json');
      const body = JSON.parse(String(token.init?.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'state'].sort(),
      );
      expect(body).toMatchObject({
        grant_type: 'authorization_code',
        code: 'the-code',
        client_id: CLAUDE_OAUTH.clientId,
        redirect_uri: CLAUDE_OAUTH.redirectUri,
      });
      // The profile read is best effort: a 404 leaves the plan unknown, not the login.
      const saved = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'));
      expect(saved.claudeAiOauth).toMatchObject({ subscriptionType: null, rateLimitTier: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads the token answer Claude Code reads', () => {
    expect(parseClaudeTokenResponse(TOKEN_RESPONSE, 1_000)).toEqual({
      accessToken: 'sk-ant-oat01-access',
      refreshToken: 'sk-ant-ort01-refresh',
      expiresAt: 1_000 + 28_800_000,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    });
  });

  it.each([
    ['access_token', 'missing access_token'],
    ['refresh_token', 'missing refresh_token'],
    ['expires_in', 'missing expires_in'],
    ['scope', 'the login does not grant user:inference'],
  ])('fails loudly, naming the field, when %s disappears', (field, detail) => {
    const changed: Record<string, unknown> = { ...TOKEN_RESPONSE };
    delete changed[field];
    expect(() => parseClaudeTokenResponse(changed, 0)).toThrow(ClaudeSignInShapeError);
    expect(() => parseClaudeTokenResponse(changed, 0)).toThrow(detail);
  });

  it('tells the owner, and saves nothing, when the answer changes shape at runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-contract-'));
    try {
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ accessToken: 'renamed', expiresIn: 1 }), { status: 200 }),
      ) as unknown as typeof fetch;
      const signIn = new ClaudeSignIn({ operatorHome: home, fetch: fetchImpl });
      signIn.start('00000000-0000-4000-8000-000000000001');
      await expect(
        signIn.complete('00000000-0000-4000-8000-000000000001', 'the-code'),
      ).rejects.toThrow(
        "Claude's sign-in answer changed shape (missing access_token). Nothing was saved",
      );
      await expect(stat(join(home, '.claude', '.credentials.json'))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  const installedClaude = join(
    dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  it.skipIf(!existsSync(installedClaude))(
    "matches the installed Claude Code's own OAuth config",
    async () => {
      const bundle = (await readFile(installedClaude)).toString('latin1');
      expect(bundle).toContain(`CLAUDE_AI_AUTHORIZE_URL:"${CLAUDE_OAUTH.authorizeUrl}"`);
      expect(bundle).toContain(`TOKEN_URL:"${CLAUDE_OAUTH.tokenUrl}"`);
      expect(bundle).toContain(`MANUAL_REDIRECT_URL:"${CLAUDE_OAUTH.redirectUri}"`);
      expect(bundle).toContain(`CLIENT_ID:"${CLAUDE_OAUTH.clientId}"`);
      expect(bundle).toContain('grant_type:"authorization_code",code:');
      expect(bundle).toContain('/api/oauth/profile');
      for (const scope of CLAUDE_OAUTH.scopes) expect(bundle).toContain(`"${scope}"`);
    },
    30_000,
  );
});
