import { describe, expect, it, vi } from 'vitest';
import { ComposioApps, composioToolkitForApp } from './composio-apps.js';

const PERSON = 'a'.repeat(64);
const ACCOUNT = 'ca_fixture';
const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('managed app provider boundary', () => {
  it('reads the toolkit description and HTTPS logo from provider metadata', async () => {
    const transport = vi.fn(async () => json({ slug: 'gmail', enabled: true,
      composio_managed_auth_schemes: ['OAUTH2'],
      meta: { description: 'Read and send Gmail messages.', logo: 'https://cdn.composio.dev/gmail.png',
        app_url: 'https://mail.google.com/mail/' } }));
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    expect(await provider.toolkit('gmail')).toMatchObject({
      description: 'Read and send Gmail messages.', logo: 'https://cdn.composio.dev/gmail.png',
      appUrl: 'https://mail.google.com',
    });
    expect(await provider.supportsOAuth('gmail')).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('identifies the provider request that rejects Gmail sign-in', async () => {
    const transport = vi.fn(async () => json({}, 403));
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    await expect(provider.link(PERSON, 'gmail')).rejects.toThrow(
      'App provider request failed (403) at GET /auth_configs');
  });

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
});
