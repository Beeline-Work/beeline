import { describe, expect, it, vi } from 'vitest';
import { ComposioApps, composioToolkitForApp } from './composio-apps.js';

const PERSON = 'a'.repeat(64);
const ACCOUNT = 'ca_fixture';
const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('managed app provider boundary', () => {
  it('uses an identity id and v3 Connect Links for a managed OAuth toolkit', async () => {
    const calls: { path: string; body?: Record<string, unknown> }[] = [];
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.endsWith('/auth_configs')) return json({ items: [{ id: 'ac_fixture',
        toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', is_composio_managed: true,
        status: 'ENABLED' }] });
      if (path.endsWith('/connected_accounts/link')) return json({
        redirect_url: 'https://app.composio.dev/connect/fixture',
        connected_account_id: ACCOUNT, expires_at: new Date(Date.now() + 600_000).toISOString(),
      }, 201);
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const link = await provider.link(PERSON, 'gmail');
    expect(link.accountId).toBe(ACCOUNT);
    expect(calls.at(-1)).toEqual({ path: '/api/v3/connected_accounts/link',
      body: { auth_config_id: 'ac_fixture', user_id: PERSON } });
    expect(JSON.stringify(calls)).not.toContain('@');
  });

  it('verifies the returning signed-in identity through the single-use completion API', async () => {
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe('/api/v3.1/connected_accounts/complete_auth');
      const body = JSON.parse(String(init?.body)) as { user_id: string; session_uri: string };
      if (body.user_id !== PERSON) return json({}, 400);
      expect(body.session_uri).toBe('session-fixture');
      return json({ connected_account_id: ACCOUNT, toolkit_slug: 'gmail' });
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    await expect(provider.completeAuth('session-fixture', 'b'.repeat(64)))
      .rejects.toThrow('App provider request failed (400)');
    await expect(provider.completeAuth('session-fixture', PERSON)).resolves.toEqual({
      accountId: ACCOUNT, toolkit: 'gmail',
    });
  });

  it('pins execution to one account, person and toolkit and removes secret-shaped fields', async () => {
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/connected_accounts/${ACCOUNT}`)) return json({
        id: ACCOUNT, user_id: PERSON, status: 'ACTIVE', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/SLACK_POST_MESSAGE')) return json({
        slug: 'SLACK_POST_MESSAGE', version: '20260928_00', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/execute/SLACK_POST_MESSAGE')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          connected_account_id: ACCOUNT, user_id: PERSON,
          arguments: { channel: 'announcements', text: 'Hello' },
          version: '20260928_00',
        });
        return json({ data: { ok: true, access_token: 'hidden', nested: { apiKey: 'hidden' } } });
      }
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    await expect(provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'slack',
      tool: 'SLACK_POST_MESSAGE', arguments: { channel: 'announcements', text: 'Hello' } }))
      .resolves.toEqual({ ok: true, nested: {} });
  });

  const LINKED = { redirect_url: 'https://app.composio.dev/connect/fixture',
    connected_account_id: ACCOUNT, expires_at: new Date(Date.now() + 600_000).toISOString() };
  const config = (id: string, overrides: Record<string, unknown> = {}) => ({ id,
    toolkit: { slug: 'youtube' }, auth_scheme: 'OAUTH2', is_composio_managed: false,
    status: 'ENABLED', ...overrides });
  const managed = config('ac_managed', { is_composio_managed: true });

  function authFixture(items: unknown[], toolkit: Record<string, unknown> = { slug: 'youtube' }) {
    const calls: { method: string; url: URL; body?: Record<string, unknown> }[] = [];
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      calls.push({ method, url: parsed, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (parsed.pathname === '/api/v3/toolkits/youtube') return json(toolkit);
      if (parsed.pathname === '/api/v3/toolkits/missing') return json({}, 404);
      if (parsed.pathname === '/api/v3/auth_configs' && method === 'GET') return json({ items });
      if (parsed.pathname === '/api/v3/auth_configs' && method === 'POST') return json({ auth_config: {
        id: 'ac_created', auth_scheme: 'OAUTH2', is_composio_managed: true } }, 201);
      if (parsed.pathname === '/api/v3/connected_accounts/link') return json(LINKED, 201);
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const linkedWith = async () => {
      await provider.link(PERSON, 'youtube');
      return calls.find((call) => call.url.pathname.endsWith('/connected_accounts/link'))?.body?.auth_config_id;
    };
    return { provider, calls, linkedWith };
  }

  it('links through an enabled custom OAuth2 config before the managed one', async () => {
    const fixture = authFixture([managed,
      config('ac_older', { created_at: '2026-09-01T00:00:00Z' }),
      config('ac_custom', { created_at: '2026-09-29T00:00:00Z' })]);
    await expect(fixture.linkedWith()).resolves.toBe('ac_custom');
    const listed = fixture.calls.find((call) => call.url.pathname === '/api/v3/auth_configs');
    expect(listed?.url.searchParams.get('toolkit_slug')).toBe('youtube');
    expect(listed?.url.searchParams.has('is_composio_managed')).toBe(false);
    expect(fixture.calls.some((call) => call.method === 'POST' &&
      call.url.pathname === '/api/v3/auth_configs')).toBe(false);
  });

  it('never selects disabled or non-OAuth2 custom configs and falls back to managed', async () => {
    const fixture = authFixture([config('ac_disabled', { status: 'DISABLED' }),
      config('ac_api_key', { auth_scheme: 'API_KEY' }),
      config('ac_other_toolkit', { toolkit: { slug: 'gmail' } }), managed]);
    await expect(fixture.linkedWith()).resolves.toBe('ac_managed');
  });

  it('creates managed OAuth only when neither a custom nor a managed config is enabled', async () => {
    const fixture = authFixture([config('ac_disabled', { status: 'DISABLED' }),
      config('ac_api_key', { auth_scheme: 'API_KEY' })]);
    await expect(fixture.linkedWith()).resolves.toBe('ac_created');
    expect(fixture.calls.find((call) => call.method === 'POST' &&
      call.url.pathname === '/api/v3/auth_configs')?.body).toEqual({ toolkit: { slug: 'youtube' },
      auth_config: { type: 'use_composio_managed_auth', credentials: {}, restrict_to_following_tools: [] } });
  });

  it('reports OAuth support from managed schemes or an enabled custom OAuth2 config', async () => {
    const managedToolkit = authFixture([], { slug: 'youtube', composio_managed_auth_schemes: ['OAUTH2'] });
    await expect(managedToolkit.provider.supportsOAuth('youtube')).resolves.toBe(true);
    expect(managedToolkit.calls.map((call) => call.url.pathname)).toEqual(['/api/v3/toolkits/youtube']);
    await expect(authFixture([config('ac_custom')]).provider.supportsOAuth('youtube')).resolves.toBe(true);
    await expect(authFixture([config('ac_disabled', { status: 'DISABLED' }),
      config('ac_api_key', { auth_scheme: 'API_KEY' })]).provider.supportsOAuth('youtube')).resolves.toBe(false);
    await expect(authFixture([config('ac_custom')]).provider.supportsOAuth('missing')).resolves.toBe(false);
  });

  it('maps Google product names to separate managed OAuth toolkits', () => {
    expect(['Gmail', 'Calendar', 'Drive', 'Docs', 'Sheets'].map((name) =>
      composioToolkitForApp(name.toLowerCase()))).toEqual([
      'gmail', 'googlecalendar', 'googledrive', 'googledocs', 'googlesheets',
    ]);
  });

  it('surfaces a provider message from a non-2xx JSON body and keeps the status', async () => {
    const transport = vi.fn(async () => json({
      error: "Quota exceeded for quota metric 'Video Uploads' and limit 'Video Uploads per day'",
    }, 429));
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const error = await provider.account(ACCOUNT, PERSON, 'youtube').catch((e: unknown) => e);
    expect((error as Error).message).toContain('Quota exceeded for quota metric');
    expect((error as { status?: number }).status).toBe(429);
  });

  it('surfaces a plain-text non-2xx body', async () => {
    const transport = vi.fn(async () => new Response('quota limit reached for this upload', { status: 429 }));
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const error = await provider.account(ACCOUNT, PERSON, 'youtube').catch((e: unknown) => e);
    expect((error as Error).message).toContain('quota limit reached for this upload');
    expect((error as { status?: number }).status).toBe(429);
  });

  it('treats a missing connected account as not connected instead of throwing', async () => {
    const body = 'Connected account "ca_gone" not found';
    const transport = vi.fn(async () => json({ error: body }, 404));
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    await expect(provider.account('ca_gone', PERSON, 'youtube')).resolves.toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('surfaces a provider reason from a flagged execution error', async () => {
    const transport = vi.fn(async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/connected_accounts/${ACCOUNT}`)) return json({
        id: ACCOUNT, user_id: PERSON, status: 'ACTIVE', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/SLACK_POST_MESSAGE')) return json({
        slug: 'SLACK_POST_MESSAGE', version: '20260928_00', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/execute/SLACK_POST_MESSAGE'))
        return json({ error: 'some provider reason' });
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const error = await provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'slack',
      tool: 'SLACK_POST_MESSAGE', arguments: { channel: 'announcements' } }).catch((e: unknown) => e);
    expect((error as Error).message).toBe('App tool execution failed: some provider reason');
  });

  it('surfaces a nested flagged error message and strips secret-shaped values', async () => {
    const transport = vi.fn(async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/connected_accounts/${ACCOUNT}`)) return json({
        id: ACCOUNT, user_id: PERSON, status: 'ACTIVE', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/SLACK_POST_MESSAGE')) return json({
        slug: 'SLACK_POST_MESSAGE', version: '20260928_00', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/execute/SLACK_POST_MESSAGE'))
        return json({ error: { message: 'nested reason', secret_key: 'x-secret-value' } });
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const error = await provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'slack',
      tool: 'SLACK_POST_MESSAGE', arguments: { channel: 'announcements' } }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('nested reason');
    expect((error as Error).message).not.toContain('x-secret-value');
  });

  it('keeps the fixed execution message when a flag is set without an error detail', async () => {
    const transport = vi.fn(async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(`/connected_accounts/${ACCOUNT}`)) return json({
        id: ACCOUNT, user_id: PERSON, status: 'ACTIVE', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/SLACK_POST_MESSAGE')) return json({
        slug: 'SLACK_POST_MESSAGE', version: '20260928_00', toolkit: { slug: 'slack' },
      });
      if (path.endsWith('/tools/execute/SLACK_POST_MESSAGE')) return json({ successful: false });
      throw new Error('unexpected request');
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const error = await provider.execute({ accountId: ACCOUNT, userId: PERSON, toolkit: 'slack',
      tool: 'SLACK_POST_MESSAGE', arguments: { channel: 'announcements' } }).catch((e: unknown) => e);
    expect((error as Error).message).toBe('App tool execution failed');
  });
});
