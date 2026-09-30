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
