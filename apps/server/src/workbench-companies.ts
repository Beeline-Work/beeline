import { isAppApiCredential } from './app-api-credential.js';
import type {
  CompanyItem, CompanySuggestion, ConnectorViewState, WorkbenchCompany, WorkbenchCompanyIndex, WorkbenchView, WorkbenchAppSearchResult,
} from '@beeline/api-contract/workbench';
import { COHORT_SQL } from './operator-dashboard-cohort.js';
import type { SqlDatabase } from './database.js';
import { companyLogo } from './company-logos.js';
import { COMPANY_APPS, COMPANY_REGISTRY, companyHost, resolveCompany, type CompanyProvider } from './company-registry.js';

type MutableItem = { -readonly [K in keyof CompanyItem]: CompanyItem[K] };
type MutableCompany = { -readonly [K in keyof Omit<WorkbenchCompany, 'items' | 'machines' | 'alsoAvailable'>]: WorkbenchCompany[K] } & {
  items: MutableItem[]; machines: WorkbenchCompany['machines']; alsoAvailable: CompanySuggestion[];
};
/** Vault credentials do not establish a managed app connection or its auth scheme.
 * Keep discovery available; connect checks the provider's OAuth config. */
function hasAccountRoute(row: Pick<WorkbenchCompany, 'items'>, view: WorkbenchView, oauth = false): boolean {
  const api = !oauth && row.items.some(item => item.target.kind === 'key' &&
    isAppApiCredential(view.connections.find(key => key.connectionId === item.id) ?? {}));
  return api || row.items.some(item => {
    const target = item.target;
    return target.kind !== 'key' && (target.kind !== 'app' ||
      view.apps?.find(app => app.appId === target.appId)?.transport !== 'squire-api');
  });
}
const collator = new Intl.Collator('en', { sensitivity: 'base' });
const sectionRank = { attention: 0, signin: 1, apps: 2, keys: 3 };
const popularityCache = new WeakMap<SqlDatabase, { until: number; value: Promise<ReadonlyMap<string, number>> }>();

/** Aggregated once per five minutes, including built-in installs; no customer identities leave SQL. */
export function companyPopularity(db: SqlDatabase): Promise<ReadonlyMap<string, number>> {
  const held = popularityCache.get(db);
  if (held && held.until > Date.now()) return held.value;
  const aliases = COMPANY_APPS.map(app => ({ app_key: app.appKey, provider_id: resolveCompany({ domain: app.domain }).id }));
  const value = db.query<{ provider_id: string; owners: number }>(
    `WITH ${COHORT_SQL}, catalog AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(app_key text,provider_id text)),
     installs AS (
       SELECT COALESCE(c.provider_id,a.app_key) provider_id,a.owner_identity_id owner_id
       FROM workspace_apps a LEFT JOIN catalog c ON c.app_key=a.app_key
       WHERE a.state='active' AND a.transport<>'squire-api'
       UNION ALL
       SELECT CASE WHEN connector_type LIKE 'google-%' THEN 'google'
         WHEN connector_type='wallet' THEN 'coinbase' ELSE connector_type END,owner_identity_id
       FROM workspace_connectors WHERE status='connected' AND connector_type IN
         ('google-gmail','google-calendar','google-drive','google-youtube','tailscale','link')
       UNION ALL
       SELECT 'coinbase',identity_id FROM wallet_bindings
       WHERE delegation_standing OR delegation_expires_at>now()
     )
     SELECT provider_id,count(DISTINCT owner_id)::int owners FROM installs
     JOIN identities i ON i.id=owner_id JOIN production_identities eligible ON eligible.id=i.id WHERE i.kind='human'
     GROUP BY provider_id`, [JSON.stringify(aliases)],
  ).then(result => new Map(result.rows.map(row => [row.provider_id, Number(row.owners)])),
    () => new Map<string, number>());
  popularityCache.set(db, { until: Date.now() + 5 * 60_000, value });
  return value;
}
function humanize(value: string): string {
  const acronyms: Record<string, string> = { api: 'API', dsn: 'DSN', oauth: 'OAuth', sdk: 'SDK', imap: 'IMAP', ios: 'iOS', asc: 'ASC', p12: 'P12', macos: 'macOS', vapid: 'VAPID' };
  return value.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((word, i) => acronyms[word.toLowerCase()] ?? (i ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(' ');
}
function credentialTitle(label: string, service: string | null, provider: CompanyProvider): string {
  if (label && !/^(default|prod)$/i.test(label.trim())) return humanize(label);
  const title = humanize(service ?? '');
  return title && title.toLowerCase() !== provider.name.toLowerCase() ? title : provider.id === 'other' ? 'Saved credential' : `${provider.name} key`;
}
/** Beeline's own wallet keys kept in the operator's vault. Hidden from lists and counts, never deleted. */
const PLATFORM_KEY_SERVICES = new Set(['coinbase-cdp']);
export function isPlatformKey(key: { readonly label: string; readonly service: string | null }): boolean {
  return PLATFORM_KEY_SERVICES.has((key.service ?? '').trim().toLowerCase()) && /^beeline(?:$|[-_\s])/i.test(key.label.trim());
}
const STATE_RANK: Record<ConnectorViewState, number> = { connected: 0, connect: 1, error: 2 };
// Only refusals a reconnect cannot fix: 403 forbidden, 410 gone, 451 legal block. 401, 429, 5xx and other codes stay Connect.
const PROVIDER_REFUSAL = /App provider request failed \((?:403|410|451)\)|provider refused/i;
// Authentication failures are fixable by a reconnect, even when a refusal code wraps them.
const AUTH_FIXABLE = /expired|revoked|sign[- ]?in|re-?auth|unauthori[sz]ed|token|credential|log ?in/i;
const APP_REMOVED = /removed upstream|was removed|app removed/i;
const COMPUTER_OFFLINE = /computer offline|helper (is )?offline|machine offline/i;

/** One classifier for company top rows and app rows. Unknown failures are Connect. */
export function classifyConnectionState(input: {
  readonly status?: string | null;
  readonly errorMessage?: string | null;
  readonly neverAuthorised?: boolean;
  readonly computerOffline?: boolean;
}): { readonly state: ConnectorViewState; readonly label?: string } {
  // A verified offline hosting computer overrides a stored connected status.
  if (input.computerOffline) return { state: 'error', label: 'Computer offline' };
  if (input.status === 'connected' || input.status === 'active') return { state: 'connected' };
  const message = input.errorMessage?.trim() || undefined;
  if (COMPUTER_OFFLINE.test(message ?? '')) {
    return { state: 'error', label: message && !/^offline$/i.test(message) ? message : 'Computer offline' };
  }
  if (message && PROVIDER_REFUSAL.test(message) && !AUTH_FIXABLE.test(message)) return { state: 'error', label: message };
  if (message && APP_REMOVED.test(message)) return { state: 'error', label: message };
  if (input.neverAuthorised) return { state: 'connect' };
  return { state: 'connect' };
}

export function worstConnectionState(states: readonly ConnectorViewState[]): ConnectorViewState {
  return states.reduce<ConnectorViewState>((worst, state) => STATE_RANK[state] > STATE_RANK[worst] ? state : worst, 'connected');
}

function suggestion(app: typeof COMPANY_APPS[number], origin: string): CompanySuggestion {
  const p = resolveCompany({ domain: app.domain });
  return { appKey: app.appKey, appName: app.name, name: app.name, purpose: app.purpose, providerId: p.id,
    providerName: p.name, domain: p.domain, logo: companyLogo(p, origin),
    flow: app.appKey === 'trusty-squire' ? 'squire' : app.appKey === 'tailscale' ? 'tailscale'
      : app.appKey === 'wallet' ? 'wallet' : app.appKey === 'link' ? 'link' : 'app' };
}
export function companySuggestions(rows: readonly WorkbenchCompany[], origin: string,
  popularity: ReadonlyMap<string, number> = new Map()): CompanySuggestion[] {
  const owned = new Set(rows.filter(r => r.kind !== 'sign-in-service' || r.machines.some(m => m.status !== 'not-added'))
    .map(r => r.kind === 'sign-in-service' ? 'squire' : r.id));
  const seen = new Set<string>();
  return COMPANY_APPS.flatMap((app, curated) => {
    const item = suggestion(app, origin);
    if (owned.has(item.providerId) || seen.has(item.providerId)) return [];
    seen.add(item.providerId);
    return [{ curated, item: { ...item, name: item.providerName,
      purpose: item.providerId === 'google' ? 'Gmail, Calendar, Drive and more' : item.purpose } }];
  }).sort((a, b) => a.item.providerId === 'squire' ? -1 : b.item.providerId === 'squire' ? 1
    : (popularity.get(b.item.providerId) ?? 0) - (popularity.get(a.item.providerId) ?? 0) || a.curated - b.curated)
    .map(row => row.item);
}

/** The only grouping/order/title authority consumed by Connectors, details, search and summary. */
export function projectWorkbenchCompanies(view: WorkbenchView, origin: string,
  popularity: ReadonlyMap<string, number> = new Map(), now = Date.now() / 1000, oauthApps: ReadonlySet<string> = new Set()): WorkbenchCompanyIndex {
  const companies = new Map<string, MutableCompany>();
  const appKeys = new Map<string, Set<string>>();
  function group(provider: CompanyProvider): MutableCompany {
    let row = companies.get(provider.id);
    if (!row) {
      row = { id: provider.id, name: provider.name, domain: provider.domain,
        kind: provider.id === 'other' ? 'other' : 'company', logo: companyLogo(provider, origin), section: 'keys',
        subtitle: '', items: [], machines: [], alsoAvailable: [] };
      companies.set(provider.id, row);
    }
    return row;
  }
  const seen = new Set<string>();
  for (const key of view.connections) {
    if (seen.has(key.reference) || isPlatformKey(key)) continue;
    seen.add(key.reference);
    const provider = resolveCompany({ allowedHosts: key.allowedHosts, loginHosts: key.loginHosts,
      service: key.service, keyName: key.keyName });
    const row = group(provider);
    const status = key.state === 'error' ? 'Failed' : key.expiresAt && key.expiresAt <= now ? 'Expired'
      : key.expiresAt && key.expiresAt < now + 3 * 86400 ? 'Expiring' : undefined;
    const title = credentialTitle(key.label, key.service, provider);
    row.items.push({ id: key.connectionId, kind: key.credentialKind === 'session' || key.credentialKind === 'login' ? 'login' : 'key',
      title, subtitle: provider.domain ?? (humanize(key.service ?? '') || 'Saved credential'),
      target: { kind: 'key', connectionId: key.connectionId }, state: status ? 'error' : 'connected', status, attention: Boolean(status) });
  }
  for (const app of view.apps ?? []) {
    if (app.transport === 'squire-api') continue; // Backing key is already the one credential placement.
    const provider = resolveCompany({ domain: app.domain, appKey: app.appKey });
    const row = group(provider);
    const helper = app.helperId ? view.helpers.find(item => item.id === app.helperId) : undefined;
    const classified = classifyConnectionState({
      status: app.status,
      errorMessage: app.errorMessage,
      neverAuthorised: app.status === 'error' && !app.errorMessage,
      computerOffline: helper ? !helper.online : false,
    });
    const companyMcp = view.connectors.some(connector => connector.connectorId === app.connectorId
      && connector.registryServerName?.endsWith('/company-mcp'));
    row.items.push({ id: app.appId, kind: 'connection', title: humanize(app.name),
      subtitle: app.transport === 'composio' ? 'via Composio' : app.transport === 'registry-mcp' ? companyMcp ? `via ${provider.name.replace(/\.[a-z]+$/i, '')} MCP` : 'MCP server' : 'via Trusty Squire',
      target: { kind: 'app', appId: app.appId }, state: classified.state,
      status: classified.state === 'error' ? classified.label : app.status === 'connecting' ? 'Connecting' : undefined,
      attention: classified.state !== 'connected' });
    const held = appKeys.get(provider.id) ?? new Set<string>(); held.add(app.appKey); appKeys.set(provider.id, held);
  }
  // Built-ins are live connections, never extra company rows or copies of stored keys.
  const builtin = (providerId: string, id: string, title: string, target: CompanyItem['target'], failed?: boolean, appKey?: string, errorMessage?: string) => {
    const provider = COMPANY_REGISTRY.find(p => p.id === providerId)!;
    const row = group(provider);
    if (appKey) { const held = appKeys.get(provider.id) ?? new Set<string>(); held.add(appKey); appKeys.set(provider.id, held); }
    const classified = classifyConnectionState({
      status: failed ? 'error' : 'connected',
      errorMessage,
      neverAuthorised: failed && !errorMessage,
    });
    row.items.push({ id, kind: 'connection', title, subtitle: 'built in', target, state: classified.state,
      status: classified.state === 'error' ? classified.label : undefined, attention: classified.state !== 'connected' });
  };
  const googleRows = view.connectors.filter(c => c.connectorType.startsWith('google-'));
  const google = googleRows.find(c => c.status.status === 'error') ?? googleRows.find(c => c.status.status === 'connected');
  if (view.googleAccount?.connected || google)
    builtin('google', 'builtin:google', 'Google sign-in', { kind: 'connector', connectorId: 'google' }, google?.status.status === 'error');
  const tailscale = view.connectors.find(c => c.connectorType === 'tailscale' && ['connected', 'error'].includes(c.status.status));
  if (tailscale) builtin('tailscale', 'builtin:tailscale', 'Tailscale', { kind: 'connector', connectorId: 'tailscale' }, tailscale.status.status === 'error', 'tailscale');
  if (view.wallet && (view.wallet.delegationActive || view.wallet.delegationExpiresAt !== null)) builtin('coinbase', 'builtin:wallet', 'Coinbase wallet', { kind: 'wallet' },
    Boolean(!view.wallet.delegationActive && view.wallet.delegationExpiresAt), 'wallet',
    !view.wallet.delegationActive && view.wallet.delegationExpiresAt ? 'Expired' : undefined);
  if (view.linkAccount?.connected) builtin('link', 'builtin:link', 'Link', { kind: 'link' }, undefined, 'link');
  const machines = view.helpers.filter(h => h.squireEligible === true);
  if (machines.length) {
    const provider = COMPANY_REGISTRY.find(p => p.id === 'squire')!;
    const trouble = machines.filter(m => m.squire?.status === 'error' || (m.squire?.status === 'connected' && !m.online));
    companies.set('squire-signin', { id: 'squire-signin', name: provider.name, domain: provider.domain,
      kind: 'sign-in-service', logo: companyLogo(provider, origin), section: trouble.length ? 'attention' : 'signin',
      subtitle: `${machines.length} ${machines.length === 1 ? 'computer' : 'computers'}`, items: [], alsoAvailable: [],
      machines: machines.map(m => ({ id: m.id, name: m.name, online: m.online,
        status: m.squire?.status ?? 'not-added', error: m.squire?.errorMessage,
        signedInAs: m.squire?.signedInAs, reconnecting: m.squire?.reconnecting,
        statusText: m.squire?.reconnecting ? 'Waiting for sign-in' : m.squire?.googleSessionExpired ? 'Google sign-in expired' : m.squire?.status === 'error' ? 'Sign-in unavailable'
          : m.squire?.status !== 'connected' ? 'Google sign-in needed' : !m.online ? 'Computer offline'
          : m.squire.signedInAs ?? 'Google signed in' })),
      status: machines.some(m => m.squire?.reconnecting) ? 'Waiting for sign-in' : machines.some(m => m.squire?.googleSessionExpired) ? 'Google sign-in expired' : trouble.length ? 'Sign-in unavailable'
        : machines.some(m => m.squire?.status === 'connected') ? 'Google signed in' : 'Google sign-in needed',
      attention: trouble.length ? `${trouble.length} ${trouble.length === 1 ? 'computer needs' : 'computers need'} attention` : undefined });
  }
  for (const row of companies.values()) {
    if (row.kind === 'sign-in-service') continue;
    // Label collisions need specific hosts only when they would otherwise be indistinguishable.
    for (const item of row.items.filter(i => i.target.kind === 'key')) {
      const siblings = row.items.filter(i => i.title === item.title && i.target.kind === 'key');
      const records = siblings.map(i => view.connections.find(k => k.connectionId === i.id)!).filter(Boolean);
      const hosts = records.map(k => companyHost(k.allowedHosts[0] ?? k.loginHosts?.[0]));
      if (new Set(hosts.filter(Boolean)).size > 1) {
        const key = view.connections.find(k => k.connectionId === item.id)!;
        item.subtitle = companyHost(key.allowedHosts[0] ?? key.loginHosts?.[0]) ?? item.subtitle;
      }
    }
    const itemState = (item: MutableItem): ConnectorViewState => item.state ?? (item.attention ? 'error' : 'connected');
    const broken = row.items.filter(i => itemState(i) !== 'connected')
      .sort((a, b) => STATE_RANK[itemState(b)] - STATE_RANK[itemState(a)] || (a.status ?? '').localeCompare(b.status ?? ''));
    row.section = row.kind === 'other' ? 'keys' : broken.length ? 'attention'
      : row.items.some(i => i.kind !== 'key') ? 'apps' : 'keys';
    row.state = worstConnectionState(row.items.map(itemState));
    row.status = row.state === 'error' ? broken[0]?.status : undefined;
    row.attention = broken.length ? `${broken.length} ${broken.length === 1 ? 'connection needs' : 'connections need'} attention` : undefined;
    row.subtitle = (['connection', 'login', 'key'] as const).flatMap(kind => {
      const n = row.items.filter(i => i.kind === kind).length;
      return n ? [`${n} ${kind === 'connection' ? 'app' : kind}${n === 1 ? '' : 's'}`] : [];
    }).join(' · ');
    const existing = appKeys.get(row.id);
    row.alsoAvailable = COMPANY_APPS.filter(app => resolveCompany({ domain: app.domain }).id === row.id
      && (app.appKey !== row.id && app.name.toLowerCase() !== row.name.toLowerCase()
        || !hasAccountRoute(row, view, oauthApps.has(app.appKey)))
      && (!existing?.has(app.appKey) || !hasAccountRoute(row, view, oauthApps.has(app.appKey))) && row.id !== 'squire').map(app => suggestion(app, origin));
    row.items.sort((a, b) => ({ connection: 0, login: 1, key: 2 })[a.kind] - ({ connection: 0, login: 1, key: 2 })[b.kind]
      || collator.compare(a.title, b.title) || a.id.localeCompare(b.id));
  }
  for (const client of view.aiClients ?? []) {
    companies.set(`rooms:${client.clientId}`, {
      id: `rooms:${client.clientId}`, roomsClientId: client.clientId, name: client.name,
      kind: 'company', logo: client.logo ? { kind: 'image', uri: client.logo, plate: 'light' } : { kind: 'monogram' },
      section: 'apps', subtitle: 'Reads and posts',
      state: 'connected', items: [], machines: [], alsoAvailable: [],
    });
  }
  const rows = [...companies.values()].sort((a, b) => sectionRank[a.section] - sectionRank[b.section]
    || (a.id === 'other' ? 1 : b.id === 'other' ? -1 : 0) || collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  const hasConnections = rows.some(r => r.roomsClientId || r.items.length || r.machines.some(m => m.status !== 'not-added'));
  const broken = rows.filter(r => r.attention).length;
  const count = hasConnections ? rows.length : 0;
  return { version: 1, rows, hasConnections, suggestions: companySuggestions(rows, origin, popularity),
    summary: { value: `${count} ${count === 1 ? 'connection' : 'connections'}`, attention: broken ? `${broken} ${broken === 1 ? 'company needs' : 'companies need'} attention` : undefined } };
}

/** Typed search still navigates existing companies; default discovery never repeats them. */
export function companySearchResults(view: WorkbenchView, candidates: WorkbenchAppSearchResult,
  query: string, origin: string): WorkbenchAppSearchResult {
  const index = view.companies!; const q = query.toLowerCase();
  const seen = new Set(index.rows.filter(row => hasAccountRoute(row, view))
    .map(r => r.kind === 'sign-in-service' ? 'squire' : r.id));
  const existing: WorkbenchAppSearchResult[number][] = index.rows.filter(r => r.name.toLowerCase().includes(q)
    || r.items.some(i => i.title.toLowerCase().includes(q) || i.title.toLowerCase().includes(humanize(query).toLowerCase())) || r.alsoAvailable.some(a => a.appName.toLowerCase().includes(q)))
    .map(r => ({ appKey: r.id, name: r.name, domain: r.domain, companyId: r.id, mark: r.logo, description: r.subtitle }));
  const catalog = COMPANY_APPS.filter(a => a.name.toLowerCase().includes(q) || a.domain.includes(q));
  const offered = new Set<string>();
  const results = [...candidates, ...catalog].flatMap(app => {
    const provider = resolveCompany({ domain: app.domain, appKey: app.appKey });
    if (provider.id === 'other' || offered.has(provider.id)) return [];
    const owned = index.rows.find(row => row.id === provider.id);
    const available = owned && !hasAccountRoute(owned, view, true)
      && owned.alsoAvailable.some(option => option.appKey === app.appKey);
    if (seen.has(provider.id) && !available && !('registryServerName' in app && app.registryServerName)) return [];
    seen.add(provider.id); offered.add(provider.id);
    const option: CompanySuggestion = { appKey: app.appKey, appName: app.name, name: provider.name,
      purpose: 'description' in app && typeof app.description === 'string' ? app.description : 'purpose' in app ? app.purpose : `Connect to ${provider.name}`,
      providerId: provider.id, providerName: provider.name, domain: provider.domain, logo: companyLogo(provider, origin),
      alternativeRoutes: ['squire-api', ...('registryServerName' in app && app.registryServerName && candidates.some(c => !c.registryServerName && c.appKey === app.appKey) ? ['composio' as const] : [])],
      ...('registryServerName' in app && app.registryServerName ? { registryServerName: app.registryServerName, registryVersion: app.registryVersion } : {}),
      flow: app.appKey === 'trusty-squire' ? 'squire' : app.appKey === 'tailscale' ? 'tailscale' : app.appKey === 'wallet' ? 'wallet' : app.appKey === 'link' ? 'link' : 'app' };
    const result = { ...app, name: provider.name, mark: option.logo, company: option };
    const position = existing.findIndex(row => row.companyId === provider.id);
    if (position >= 0) { existing[position] = result; return []; }
    return [result];
  });
  return [...existing, ...results];
}
