/**
 * Apps: the ONE front door for connecting a third-party app to a person's
 * Workbench, for a person (Workbench → Connect an app) and an agent
 * (`connect_app`) alike.
 *
 * The server resolves the route in a fixed order and records the choice
 * (`apps/server/src/app-connections.ts`):
 *
 *   1. `workbench`      — the app is already connected in this Workbench; reuse it.
 *   2. `registry-mcp`   — the app publishes an OFFICIAL hosted MCP server in the
 *                         Registry; connect it through the self-serve Registry flow.
 *   3. `squire-api`     — Trusty Squire signs up / signs in, vaults an API key, and
 *                         the app's API is called through Squire.
 *   4. `squire-browser` — Squire drives the app in a browser, only once the API
 *                         route has established that no API exists.
 *
 * Whichever route serves the app, it is ONE Workbench row and ONE permission
 * decision: every use is authorized against `app:<key>` and recorded in the
 * same usage ledger.
 */

/** What serves a connected app. */
export const APP_TRANSPORTS = ['registry-mcp', 'squire-api', 'squire-browser'] as const;
export type AppTransport = (typeof APP_TRANSPORTS)[number];

/** Every route the resolver can choose, in resolution order. */
export const APP_ROUTES = ['workbench', ...APP_TRANSPORTS] as const;
export type AppRoute = (typeof APP_ROUTES)[number];

export function isAppTransport(value: unknown): value is AppTransport {
  return typeof value === 'string' && (APP_TRANSPORTS as readonly string[]).includes(value);
}

/** The one derived state a Workbench app row shows. */
export type AppConnectionStatus = 'connecting' | 'connected' | 'error';

export const APP_KEY_MAX_LENGTH = 63;
export const APP_INPUT_MAX_LENGTH = 200;

/** The single grant target every route of one app is authorized against. */
export const APP_RESOURCE_TARGET_PREFIX = 'app:';

export function appResourceTarget(key: string): string {
  return `${APP_RESOURCE_TARGET_PREFIX}${key}`;
}

/**
 * Second-level labels under which the brand sits one label further left
 * (`example.co.uk` → `example`). No public-suffix list travels to every
 * client, so this is the same small table the phone already uses.
 */
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

function alnum(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, APP_KEY_MAX_LENGTH);
}

function hostOf(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const host = trimmed.split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
}

/** The registrable domain of a host: `api.linear.app` → `linear.app`. */
export function registrableDomain(host: string): string | undefined {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  if (labels.every((label) => /^\d+$/.test(label))) return undefined;
  const penultimate = labels[labels.length - 2]!;
  const keep = labels.length >= 3 && SECOND_LEVEL_SUFFIXES.has(penultimate) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** The brand label of a registrable domain: `linear.app` → `linear`. */
function brandOfDomain(domain: string): string | undefined {
  const key = alnum(domain.split('.')[0] ?? '');
  return key || undefined;
}

export type AppIdentity = {
  /** Stable brand key: every route, grant and usage row of the app shares it. */
  readonly key: string;
  /** The registrable domain, when the input named one. */
  readonly domain?: string;
};

/**
 * Normalize what a person or agent typed — `Linear`, `linear.app`,
 * `https://api.linear.app/graphql` — to the app's brand key. A name keeps
 * letters and digits only, so `Hugging Face` and `huggingface.co` agree.
 */
export function appIdentity(input: string): AppIdentity | undefined {
  const text = input.trim();
  if (!text || text.length > APP_INPUT_MAX_LENGTH) return undefined;
  const host = hostOf(text);
  if (host) {
    const domain = registrableDomain(host);
    const key = domain ? brandOfDomain(domain) : undefined;
    return key && domain ? { key, domain } : undefined;
  }
  const key = alnum(text);
  return key ? { key } : undefined;
}

/** The app key a host or URL belongs to, e.g. for a Squire call's target. */
export function appKeyForHost(value: string): string | undefined {
  const host = hostOf(value);
  const domain = host ? registrableDomain(host) : undefined;
  return domain ? brandOfDomain(domain) : undefined;
}

/**
 * The app a Registry server name belongs to, read ONLY from its verified
 * namespace: a reverse-DNS namespace (`app.linear/…`, `com.notion/…`) names
 * the domain that published it, and `io.github.<owner>/…` names a GitHub
 * owner. Anything else belongs to no app.
 */
export function registryServerAppKey(serverName: string): string | undefined {
  const namespace = serverName.trim().toLowerCase().split('/')[0] ?? '';
  if (!namespace || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(namespace)) return undefined;
  if (namespace.startsWith('io.github.')) {
    const owner = alnum(namespace.slice('io.github.'.length));
    return owner || undefined;
  }
  const domain = registrableDomain(namespace.split('.').reverse().join('.'));
  return domain ? brandOfDomain(domain) : undefined;
}

type RegistryCandidate = {
  readonly name: string;
  readonly version: string;
  readonly remotes: readonly { readonly type: string; readonly url: string }[];
};

/**
 * A Registry entry is the app's OFFICIAL hosted server only when its verified
 * namespace belongs to the app AND it publishes a streamable-http remote this
 * installer can connect. A community server for the same product never
 * qualifies, however well it matches the search.
 */
export function isOfficialHostedServer(candidate: RegistryCandidate, appKey: string): boolean {
  return (
    registryServerAppKey(candidate.name) === appKey &&
    candidate.remotes.some((remote) => remote.type === 'streamable-http')
  );
}

/** The deterministic pick among official candidates: lowest server name wins. */
export function selectOfficialHostedServer<Candidate extends RegistryCandidate>(
  candidates: readonly Candidate[],
  appKey: string,
): Candidate | undefined {
  return candidates
    .filter((candidate) => isOfficialHostedServer(candidate, appKey))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
}

/**
 * The app keys a Trusty Squire tool call is FOR, read from its non-secret
 * arguments: the credential's service, and every page or API URL it points
 * at. A call that names an app is authorized as that app, so the Squire route
 * can never be a way around the app's one permission decision.
 */
export function squireCallAppKeys(args: Record<string, unknown> | undefined): readonly string[] {
  if (!args) return [];
  const keys = new Set<string>();
  const service = args.service;
  if (typeof service === 'string') {
    const identity = appIdentity(service);
    if (identity) keys.add(identity.key);
  }
  const urls: unknown[] = [args.url, args.signin_url];
  const http = args.http;
  if (http && typeof http === 'object' && !Array.isArray(http))
    urls.push((http as Record<string, unknown>).url);
  for (const url of urls) {
    if (typeof url !== 'string' || url.length > 2_048) continue;
    const key = appKeyForHost(url);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/** A result the agent-facing `connect_app` tool returns. */
export type ConnectAppStatus =
  | 'connected'
  | 'connecting'
  | 'needs_sign_in'
  | 'needs_squire'
  | 'error'
  | 'unavailable';
