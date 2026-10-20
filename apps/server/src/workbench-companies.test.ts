import { describe, expect, it } from 'vitest';
import type { WorkbenchConnectionView, WorkbenchView, WorkbenchAppView } from '@beeline/api-contract/workbench';
import { projectWorkbenchCompanies, companySearchResults, classifyConnectionState, worstConnectionState } from './workbench-companies.js';
import { resolveCompany } from './company-registry.js';
const origin = 'https://server.example';
const key = (id: string, service: string, hosts: readonly string[], label = 'default'): WorkbenchConnectionView => ({
  connectionId: id, reference: `vault:${id}`, connectorId: 'squire:personal', service, label, allowedHosts: hosts,
  fieldNames: ['token'], faviconDomain: null, state: 'active', createdAt: 1,
});
const app = (id: string, name: string, domain: string, transport: WorkbenchAppView['transport'] = 'composio'): WorkbenchAppView => ({
  appId: id, appKey: id, name, domain, transport, route: transport === 'registry-mcp' ? 'workbench' : transport,
  status: 'connected', accountLabel: 'Owner', workspaceName: 'Work', useCount: 0, createdAt: 1,
});
const base = (connections: WorkbenchView['connections'] = [], apps: WorkbenchView['apps'] = []): WorkbenchView => ({
  workspaceId: 'ws', catalog: [], connectors: [], connections, apps,
  helpers: [{ id: 'personal', name: 'Personal laptop', online: true, squireEligible: true, squire: { status: 'connected', reportedAt: 1 } },
    { id: 'free', name: 'Fly free server', online: true, squireEligible: false }],
});
const messy: WorkbenchView[] = [
  base([...Array.from({ length: 7 }, (_, n) => key(`sentry-${n}`, n % 2 ? 'sentry' : 'x-y-z', ['o123.ingest.sentry.io'], n ? `beeline-service-${n} (org-id)` : 'default')),
    key('fly-one', 'fly-free-agents', ['api.machines.dev']), key('fly-two', 'totally unrelated', ['api.fly.io']),
    key('squire-key', 'trusty-squire-operator', []), key('google-key', 'google-photos-picker-oauth', ['photospicker.googleapis.com'])],
    [app('gmail', 'Gmail', 'mail.google.com'), app('googledrive', 'Drive', 'drive.google.com')]),
  base([key('a', 'Google', ['us.i.posthog.com'], 'x-y-z'), key('b', 'not-the-company', ['eu.i.posthog.com']),
    key('c', 'other', ['api.example.co.uk']), key('d', 'local-signing', []),
    { ...key('e', '', []), keyName: 'SENTRY_AUTH_TOKEN' }, { ...key('f', '', []), loginHosts: ['github.com'] }],
    [app('analytics', 'Analytics', 'app.posthog.com', 'registry-mcp')]),
  { ...base([{ ...key('expired', 'misc', ['api.stripe.com']), expiresAt: 2 }, key('active', 'stripe', ['stripe.com'])],
      [{ ...app('googlecalendar', 'Calendar', 'calendar.google.com'), status: 'error' }, app('billing', 'Billing', 'dashboard.stripe.com', 'registry-mcp')]),
    helpers: [{ id: 'offline', name: 'Travel computer', online: false, squireEligible: true, squire: { status: 'connected', reportedAt: 1 } }] },
];

describe('server-owned Connectors company projection', () => {
  for (const [n, view] of messy.entries()) it(`guards deliberately messy account ${n + 1}`, () => {
    const result = projectWorkbenchCompanies(view, origin, new Map(), 10);
    const companies = result.rows.filter(r => r.kind !== 'sign-in-service');
    expect(new Set(companies.map(r => r.id)).size).toBe(companies.length);
    expect(result.rows.some(r => r.name === 'x-y-z' || r.name === 'google-photos-picker-oauth')).toBe(false);
    const placed = result.rows.flatMap(r => r.items.filter(i => i.target.kind === 'key').map(i => i.id));
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toHaveLength(new Set(view.connections.map(k => k.reference)).size);
    const signin = result.rows.find(r => r.kind === 'sign-in-service')!;
    expect(signin.items).toEqual([]);
    expect(signin.subtitle).not.toMatch(/key|credential/i);
    expect(signin.machines.some(m => m.id === 'free')).toBe(false);
    for (const row of result.rows) {
      if (row.domain) expect(row.logo.kind).toBe('image');
      expect(row.items.some(i => /^Key \d+$/.test(i.title))).toBe(false);
      expect(row.alsoAvailable.some(a => a.appKey === row.id || a.name.toLowerCase() === row.name.toLowerCase())).toBe(false);
    }
    expect(new Set(result.suggestions.map(s => s.providerId)).size).toBe(result.suggestions.length);
    const owned = new Set(result.rows.map(r => r.kind === 'sign-in-service' ? 'squire' : r.id));
    expect(result.suggestions.some(s => owned.has(s.providerId))).toBe(false);
    const reordered = projectWorkbenchCompanies({ ...view, connections: [...view.connections].reverse(), apps: [...(view.apps ?? [])].reverse() }, origin, new Map(), 10);
    expect(reordered.rows).toEqual(result.rows);
  });
  it('keeps one company for seven keys, and distinct Squire credentials out of the sign-in service', () => {
    const result = projectWorkbenchCompanies(messy[0]!, origin);
    expect(result.rows.find(r => r.id === 'sentry')?.items).toHaveLength(7);
    expect(result.rows.find(r => r.id === 'fly')?.items).toHaveLength(2);
    expect(result.rows.find(r => r.id === 'squire')).toMatchObject({ section: 'keys', machines: [] });
    expect(result.rows.find(r => r.id === 'squire-signin')).toMatchObject({ items: [], subtitle: '1 computer' });
    expect(result.rows.find(r => r.id === 'sentry')?.items.every(i => i.subtitle === 'sentry.io')).toBe(true);
    expect(result.rows.find(r => r.id === 'sentry')?.items.every(i => !i.title.includes('org-id'))).toBe(true);
  });
  it('uses host evidence first, then service/key names; suffix and boundary matching are exact', () => {
    expect(resolveCompany({ allowedHosts: ['api.stripe.com'], service: 'sentry' }).id).toBe('stripe');
    expect(resolveCompany({ service: 'fly-free-agents' }).id).toBe('fly');
    expect(resolveCompany({ service: 'google-photos-picker-oauth' }).id).toBe('google');
    expect(resolveCompany({ keyName: 'OPENROUTER_API_KEY' }).id).toBe('openrouter');
    expect(resolveCompany({ allowedHosts: [], loginHosts: ['github.com'] }).id).toBe('github');
    expect(resolveCompany({ allowedHosts: ['api.example.co.uk'] }).id).toBe('example.co.uk');
    expect(resolveCompany({ allowedHosts: ['github.com.evil.example'] }).id).not.toBe('github');
    expect(resolveCompany({ service: 'flytrap' }).id).toBe('other');
  });
  it('deduplicates replicated vault references globally, even when labels or host reports disagree', () => {
    const a = key('canonical', 'sentry', ['sentry.io']);
    const result = projectWorkbenchCompanies(base([a, { ...key('replica', 'stripe', ['stripe.com']), reference: a.reference }],
      [app('backing', 'Sentry API', 'sentry.io', 'squire-api')]), origin);
    expect(result.rows.flatMap(r => r.items).map(i => i.id)).toEqual(['canonical']);
  });
  it('does not turn missing metadata into attention; Other stays last', () => {
    const result = projectWorkbenchCompanies(messy[1]!, origin);
    expect(result.rows.filter(r => r.section === 'attention')).toEqual([]);
    expect(result.rows.at(-1)).toMatchObject({ id: 'other', section: 'keys', attention: undefined });
  });
  it('moves a failing company once, preserving healthy keys and live MCP connections inside it', () => {
    const result = projectWorkbenchCompanies(messy[2]!, origin, new Map(), 10);
    expect(result.rows.filter(r => r.section === 'attention').map(r => r.id)).toEqual(['google', 'stripe', 'squire-signin']);
    expect(result.rows.find(r => r.id === 'stripe')?.items).toHaveLength(3);
    expect(result.rows.find(r => r.id === 'stripe')?.items.find(i => i.id === 'billing')?.subtitle).toBe('MCP server');
  });
  it('includes Google sign-in, Tailscale, wallet and Link as live connections', () => {
    const view = { ...base(), googleAccount: { connected: true, pending: false, connectedTypes: [] },
      wallet: { createdAt: 1, delegationActive: true, delegationExpiresAt: null },
      linkAccount: { connected: true, pending: false, ineligible: false },
      connectors: [{ connectorId: 'tailscale-uuid', connectorType: 'tailscale' as const, helperAgentId: 'personal', createdAt: 1,
        status: { connectorId: 'tailscale-uuid', status: 'connected' as const, steps: [] } }] };
    const result = projectWorkbenchCompanies(view, origin);
    const titles = { google: 'Google sign-in', tailscale: 'Tailscale', coinbase: 'Coinbase wallet', link: 'Link' } as const;
    for (const [id, title] of Object.entries(titles)) {
      const row = result.rows.find(r => r.id === id)!;
      expect(row.section).toBe('apps'); expect(row.items[0]?.subtitle).toBe('built in');
      expect(row.items[0]?.title).toBe(title);
    }
    expect(result.rows.find(r => r.id === 'coinbase')!.alsoAvailable.some(a => a.appKey === 'wallet')).toBe(false);
  });
  it('hides Beeline wallet platform keys from lists and counts, and never offers the connected wallet again', () => {
    const view = { ...base([key('server', 'coinbase-cdp', ['api.cdp.coinbase.com'], 'beeline-server'),
      key('secret', 'coinbase-cdp', ['api.cdp.coinbase.com'], 'beeline-wallet-secret'),
      key('mine', 'coinbase-cdp', ['api.cdp.coinbase.com'], 'my-trading')]),
    wallet: { createdAt: 1, delegationActive: true, delegationExpiresAt: null } };
    const coinbase = projectWorkbenchCompanies(view, origin).rows.find(r => r.id === 'coinbase')!;
    expect(coinbase.items.map(i => i.id)).toEqual(['builtin:wallet', 'mine']);
    expect(coinbase.subtitle).toBe('1 app · 1 key');
    expect(coinbase.alsoAvailable.some(a => a.appKey === 'wallet')).toBe(false);
  });
  it('shows failed built-in Google sign-in once in attention, with a usable existing target', () => {
    const view = { ...base(), connectors: [{ connectorId: 'google-uuid', connectorType: 'google-gmail' as const, helperAgentId: 'personal', createdAt: 1,
      status: { connectorId: 'google-uuid', status: 'error' as const, steps: [] } }] };
    const google = projectWorkbenchCompanies(view, origin).rows.find(r => r.id === 'google');
    expect(google).toMatchObject({ section: 'attention', state: 'connect', items: [{ target: { kind: 'connector', connectorId: 'google' } }] });
    expect(google?.status).not.toBe('Offline');
  });
  it('classifies app attention as Connect unless the failure cannot be retried', () => {
    expect(classifyConnectionState({ status: 'error', neverAuthorised: true })).toEqual({ state: 'connect' });
    expect(classifyConnectionState({ status: 'error', errorMessage: 'Sign-in expired' })).toEqual({ state: 'connect' });
    expect(classifyConnectionState({ status: 'error', errorMessage: 'Token revoked' })).toEqual({ state: 'connect' });
    expect(classifyConnectionState({ status: 'error', errorMessage: 'something unclassified' })).toEqual({ state: 'connect' });
    expect(classifyConnectionState({ status: 'error', errorMessage: 'App provider request failed (403)' }))
      .toEqual({ state: 'error', label: 'App provider request failed (403)' });
    expect(classifyConnectionState({ status: 'error', computerOffline: true })).toEqual({ state: 'error', label: 'Computer offline' });
    expect(classifyConnectionState({ status: 'connected' })).toEqual({ state: 'connected' });
  });
  it('shows Error with Computer offline when the hosting computer is offline, even if the app is stored connected', () => {
    expect(classifyConnectionState({ status: 'connected', computerOffline: true })).toEqual({ state: 'error', label: 'Computer offline' });
    const notion = { ...app('notion', 'Notion', 'notion.so', 'squire-browser'), helperId: 'travel' };
    const view = { ...base([], [notion]), helpers: [{ id: 'travel', name: 'Travel computer', online: false, squireEligible: false }] };
    const row = projectWorkbenchCompanies(view, origin).rows.find(r => r.id === 'notion')!;
    expect(row.state).toBe('error');
    expect(row.status).toBe('Computer offline');
    expect(row.items).toEqual([expect.objectContaining({ id: 'notion', state: 'error', status: 'Computer offline', attention: true })]);
  });
  it('company top-row status is the worst app state and never Offline', () => {
    expect(worstConnectionState(['connected', 'connect', 'error'])).toBe('error');
    expect(worstConnectionState(['connected', 'connect'])).toBe('connect');
    const refused = { ...app('gmail', 'Gmail', 'mail.google.com'), status: 'error' as const, errorMessage: 'App provider request failed (403)' };
    const expired = { ...app('googlecalendar', 'Calendar', 'calendar.google.com'), status: 'error' as const, errorMessage: 'Sign-in expired' };
    const healthy = app('googledrive', 'Drive', 'drive.google.com');
    const mixed = projectWorkbenchCompanies(base([], [refused, expired, healthy]), origin).rows.find(r => r.id === 'google')!;
    expect(mixed.state).toBe('error');
    expect(mixed.status).toBe('App provider request failed (403)');
    expect(mixed.status).not.toBe('Offline');
    const neverAuth = projectWorkbenchCompanies(base([], [{ ...app('gmail', 'Gmail', 'mail.google.com'), status: 'error' }]), origin)
      .rows.find(r => r.id === 'google')!;
    expect(neverAuth.state).toBe('connect');
    expect(neverAuth.status).not.toBe('Offline');
    expect(JSON.stringify(neverAuth)).not.toMatch(/Offline/);
  });
  it('ranks empty-account discovery by company popularity, with Squire first and company-level purposes', () => {
    const view = { ...base(), helpers: [] };
    const result = projectWorkbenchCompanies(view, origin, new Map([['meta', 20], ['google', 10]]));
    expect(result.hasConnections).toBe(false);
    expect(result.suggestions.slice(0, 3).map(s => s.providerId)).toEqual(['squire', 'meta', 'google']);
    expect(result.suggestions.find(s => s.providerId === 'google')?.purpose).toBe('Gmail, Calendar, Drive and more');
    expect(result.suggestions.every(s => s.logo.kind === 'image' && Boolean(s.purpose))).toBe(true);
  });
  it('does not count an unconfigured computer as a connection on the empty-account page', () => {
    const view = { ...base(), helpers: [{ id: 'personal', name: 'Laptop', online: true, squireEligible: true,
      squire: { status: 'not-added' as const, reportedAt: 1 } }] };
    const index = projectWorkbenchCompanies(view, origin);
    expect(index.hasConnections).toBe(false);
    expect(index.summary.value).toBe('0 connections');
    expect(index.suggestions[0]?.flow).toBe('squire');
    expect(projectWorkbenchCompanies({ ...base(), helpers: [] }, origin).summary.value).toBe('0 connections');
    expect(projectWorkbenchCompanies({ ...base(), helpers: [], connections: [key('a', 'sentry', ['sentry.io'])] }, origin).summary.value).toBe('1 connection');
  });
  it('keeps missing apps inside the existing company, never a self-suggestion', () => {
    const view = messy[0]!; const result = projectWorkbenchCompanies(view, origin);
    const google = result.rows.find(r => r.id === 'google')!;
    expect(google.alsoAvailable.some(a => a.appKey === 'googlesheets')).toBe(true);
    expect(google.alsoAvailable.some(a => a.appKey === 'gmail' || a.appKey === 'googledrive')).toBe(false);
    expect(result.rows.find(r => r.id === 'sentry')?.alsoAvailable).toEqual([]);
    expect(result.suggestions.some(s => s.providerId === 'google')).toBe(false);
  });
  it('typed search navigates existing company pages and never repeats a company', () => {
    const view = { ...messy[0]!, companies: projectWorkbenchCompanies(messy[0]!, origin) };
    const matches = companySearchResults(view, [], 'Sentry', origin);
    expect(matches[0]).toMatchObject({ companyId: 'sentry', name: 'Sentry' });
    expect(companySearchResults(view, [], 'Google', origin).filter(r => r.companyId === 'google')).toHaveLength(1);
  });
});

it('Reproduction squire-false-card: projects the signed-in account and active reconnect', () => {
  const view = base();
  const project = (reconnecting: boolean) => projectWorkbenchCompanies({ ...view, helpers: [{
    ...view.helpers[0]!, squire: { status: 'connected', reportedAt: 1, signedInAs: 'owner@example.com', reconnecting },
  }] }, origin).rows.find(r => r.kind === 'sign-in-service')!;
  expect(project(false).machines[0]).toMatchObject({ statusText: 'owner@example.com', signedInAs: 'owner@example.com' });
  expect(project(true)).toMatchObject({ status: 'Reconnecting…', machines: [{ reconnecting: true, statusText: 'Reconnecting…' }] });
});
