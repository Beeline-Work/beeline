import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, isIPv4, isIPv6, type Server } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
  ConnectorAssignment,
  ConnectorStep,
  RegistryMcpRoute,
} from '@beeline/api-contract/daemon';
import {
  MCP_RESOURCE_GATE_KEY,
  MCP_RESOURCE_GATE_TRANSPORT,
  MCP_RESOURCE_TARGET_KEY,
  NON_CONSUMING,
} from './resource-mcp-facade.js';
import { MCP_ROUTE_CLASS_KEY, MCP_ROUTE_HOST } from './mcp-route-class.js';

export const REGISTRY_MCP_BROKER_FLAG = '--registry-mcp-broker';

type RegistryApi = {
  execute(name: string, input: Record<string, unknown>): Promise<Record<string, any>>;
};

type PendingState = {
  status: 'pending';
  connectorId: string;
  serverName: string;
  version: string;
  remoteUrl: string;
  /**
   * The canonical RFC 8707 resource indicator the protected-resource metadata
   * published. The authorization request, the code exchange and every refresh
   * must carry the SAME value or the provider answers `invalid_target`, so it
   * is resolved once and stored rather than re-derived from the manifest.
   */
  resourceIndicator: string;
  state: string;
  redirectUri: string;
  verifier: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  attemptId: string;
};

type ConnectedState = {
  status: 'connected';
  connectorId: string;
  serverName: string;
  version: string;
  remoteUrl: string;
  resourceIndicator?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
};

type RegistryState = PendingState | ConnectedState;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
      return url.toString();
  } catch {
    // Invalid discovery metadata is unsupported, never a reason to log it.
  }
  return undefined;
}

/**
 * RFC 8414 inserts the well-known segment BEFORE an issuer's path, so an
 * issuer of `https://host/tenant1` publishes at
 * `https://host/.well-known/oauth-authorization-server/tenant1`. Resolving the
 * well-known path against the origin alone reports a conformant provider as
 * not supporting standard OAuth. The MCP spec also permits OpenID discovery.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, url).toString(),
    new URL(`/.well-known/openid-configuration${path}`, url).toString(),
  ];
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * A remote connector may not point its login at the operator's own machine.
 * LAN (10/8, 172.16/12, 192.168/16) and tailnet (100.64/10) addresses stay
 * reachable; only this host's own loopback is refused, and only when the
 * connector's own server is somewhere else. A connector that IS on loopback
 * (a local development remote) keeps using loopback for itself.
 */
export const OWN_MACHINE_REFUSAL = "the connector's login points at your own machine, refused.";

class OwnMachineRefusal extends Error {
  constructor() {
    super(OWN_MACHINE_REFUSAL);
  }
}

export type HostLookup = (hostname: string) => Promise<readonly string[]>;

const resolveHostAddresses: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

function isLoopbackAddress(value: string): boolean {
  const address = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  const mapped = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIPv4(mapped)) return mapped.split('.')[0] === '127';
  return isIPv6(address) && (address === '::1' || /^(?:0{1,4}:){7}0{0,3}1$/.test(address));
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host);
}

/** Post-DNS: a name that resolves onto this machine's loopback is this machine. */
export async function ownMachine(
  hostname: string,
  resolveHost: HostLookup = resolveHostAddresses,
): Promise<boolean> {
  if (isLoopbackHost(hostname)) return true;
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isIPv4(literal) || isIPv6(literal)) return false;
  try {
    return (await resolveHost(hostname)).some(isLoopbackAddress);
  } catch {
    return false;
  }
}

async function assertNotOwnMachine(
  url: string,
  remoteIsOwnMachine: boolean,
  resolveHost: HostLookup,
): Promise<string> {
  if (!remoteIsOwnMachine && (await ownMachine(new URL(url).hostname, resolveHost)))
    throw new OwnMachineRefusal();
  return url;
}

/**
 * Where provider grants live. `bwrap-sandbox.ts` masks this path by name, but
 * `--ro-bind / /` is a LIVE view: a store that does not exist when a session
 * is planned gets no mask, and the first connect then writes access and
 * refresh tokens into a directory the running harness can read. The daemon
 * therefore creates it before any turn can start ({@link
 * RegistryMcpHostBroker.start}), so the mask is always in force.
 */
export function registryMcpStateRoot(home = homedir()): string {
  return join(home, '.beeline', 'registry-mcp');
}

export function registryMcpStatePath(connectorId: string, home = homedir()): string {
  if (!/^[0-9a-f-]{20,}$/i.test(connectorId)) throw new Error('Registry connector id is invalid');
  return join(registryMcpStateRoot(home), `${connectorId}.json`);
}

function readState(path: string): RegistryState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RegistryState;
    return parsed?.status === 'pending' || parsed?.status === 'connected' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeState(path: string, state: RegistryState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function challengeParameter(header: string | null, key: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|[,\\s])${key}=(?:"([^"]+)"|([^,\\s]+))`, 'i'));
  return match?.[1] ?? match?.[2];
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 256 * 1024) throw new Error('provider metadata is too large');
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const result = record(parsed);
  if (!result) throw new Error('provider metadata is invalid');
  return result;
}

const CONNECTOR_STEPS = [
  { key: 'discover', label: 'Discover remote authentication' },
  { key: 'connect', label: 'Connect provider account' },
] as const;

/** `failed` marks the step named by `active`; whatever ran before it is done. */
function steps(active: 'discover' | 'connect' | 'done', failed?: string): ConnectorStep[] {
  const activeIndex = CONNECTOR_STEPS.findIndex((step) => step.key === active);
  return CONNECTOR_STEPS.map((step, index) => {
    if (activeIndex < 0 || index < activeIndex) return { label: step.label, status: 'done' };
    if (index > activeIndex) return { label: step.label, status: 'pending' };
    return failed
      ? { label: step.label, status: 'failed', reason: failed }
      : { label: step.label, status: 'running' };
  });
}

export type RegistryInstallResult =
  | { status: 'connected'; steps: readonly ConnectorStep[] }
  | {
      status: 'installing';
      steps: readonly ConnectorStep[];
      authorizationUrl: string;
      attemptId: string;
    }
  | { status: 'error'; steps: readonly ConnectorStep[]; errorMessage: string };

export async function installRegistryMcp(input: {
  api: RegistryApi;
  agentId: string;
  assignment: Extract<ConnectorAssignment, { kind: 'install' }>;
  home?: string;
  transport?: typeof fetch;
  resolveHost?: HostLookup;
}): Promise<RegistryInstallResult> {
  const { assignment } = input;
  const manifest = assignment.registryManifest;
  const serverName = assignment.registryServerName;
  const version = assignment.registryVersion;
  const remote = manifest?.remotes.find((entry) => entry.type === 'streamable-http');
  if (!manifest || !serverName || !version || !remote)
    return {
      status: 'error',
      steps: steps('discover', 'Registry remote configuration is incomplete'),
      errorMessage: 'Registry remote configuration is incomplete',
    };
  const transport = input.transport ?? fetch;
  const resolveHost = input.resolveHost ?? resolveHostAddresses;
  const remoteUrl = remote.url;
  const pinnedName = serverName;
  const pinnedVersion = version;
  const remoteIsOwnMachine = await ownMachine(new URL(remoteUrl).hostname, resolveHost);
  const path = registryMcpStatePath(assignment.connectorId, input.home);
  const stored = readState(path);
  if (
    stored?.status === 'connected' &&
    stored.serverName === serverName &&
    stored.version === version &&
    stored.remoteUrl === remote.url
  )
    return { status: 'connected', steps: steps('done') };

  if (
    stored?.status === 'pending' &&
    stored.serverName === serverName &&
    stored.version === version
  ) {
    const claimed = await input.api.execute('claimRegistryMcpOAuthCode', {
      agentId: input.agentId,
      connectorId: assignment.connectorId,
      state: stored.state,
    });
    if (claimed.status !== 'ready' || typeof claimed.code !== 'string') {
      // A gone attempt row is not "the person has not signed in yet": re-posting
      // its dead URL forever is the wedge, so fall through to fresh discovery.
      if (claimed.status === 'expired') return discover();
      return {
        status: 'installing',
        steps: steps('connect'),
        authorizationUrl: stored.authorizationUrl,
        attemptId: stored.attemptId,
      };
    }
    try {
      const response = await transport(stored.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: claimed.code,
          redirect_uri: stored.redirectUri,
          client_id: stored.clientId,
          code_verifier: stored.verifier,
          resource: stored.resourceIndicator,
          ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error('token exchange refused');
      const token = await jsonResponse(response);
      if (typeof token.access_token !== 'string') throw new Error('access token missing');
      writeState(path, {
        status: 'connected',
        connectorId: assignment.connectorId,
        serverName,
        version,
        remoteUrl: remote.url,
        resourceIndicator: stored.resourceIndicator,
        accessToken: token.access_token,
        ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
        ...(typeof token.expires_in === 'number'
          ? { expiresAt: Date.now() + Math.max(0, token.expires_in) * 1_000 }
          : {}),
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
        ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
      });
      return { status: 'connected', steps: steps('done') };
    } catch {
      const message = 'Provider authorization could not be completed; retry the connection';
      return { status: 'error', steps: steps('connect', message), errorMessage: message };
    }
  }

  return discover();

  async function discover(): Promise<RegistryInstallResult> {
    try {
      const initialize = await transport(remoteUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'Beeline', version: '1' },
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (initialize.ok) {
        writeState(path, {
          status: 'connected',
          connectorId: assignment.connectorId,
          serverName: pinnedName,
          version: pinnedVersion,
          remoteUrl: remoteUrl,
        });
        return { status: 'connected', steps: steps('done') };
      }
      if (initialize.status !== 401) throw new Error('remote refused initialization');
      const resourceMetadataUrl = safeUrl(
        challengeParameter(initialize.headers.get('www-authenticate'), 'resource_metadata'),
      );
      if (!resourceMetadataUrl) throw new Error('protected-resource metadata is missing');
      await assertNotOwnMachine(resourceMetadataUrl, remoteIsOwnMachine, resolveHost);
      const resourceResponse = await transport(resourceMetadataUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resourceResponse.ok) throw new Error('protected-resource metadata is unavailable');
      const resource = await jsonResponse(resourceResponse);
      const authorizationServer = Array.isArray(resource.authorization_servers)
        ? safeUrl(resource.authorization_servers[0])
        : undefined;
      if (!authorizationServer) throw new Error('authorization server metadata is missing');
      await assertNotOwnMachine(authorizationServer, remoteIsOwnMachine, resolveHost);
      let metadataResponse: Response | undefined;
      for (const metadataUrl of authorizationServerMetadataUrls(authorizationServer)) {
        const candidate = await transport(metadataUrl, { signal: AbortSignal.timeout(10_000) });
        if (candidate.ok) {
          metadataResponse = candidate;
          break;
        }
      }
      if (!metadataResponse) throw new Error('authorization server metadata is unavailable');
      const metadata = await jsonResponse(metadataResponse);
      const authorizationEndpoint = safeUrl(metadata.authorization_endpoint);
      const tokenEndpoint = safeUrl(metadata.token_endpoint);
      const registrationEndpoint = safeUrl(metadata.registration_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint)
        throw new Error('dynamic client registration is not supported');
      for (const endpoint of [authorizationEndpoint, tokenEndpoint, registrationEndpoint])
        await assertNotOwnMachine(endpoint, remoteIsOwnMachine, resolveHost);
      if (
        Array.isArray(metadata.code_challenge_methods_supported) &&
        !metadata.code_challenge_methods_supported.includes('S256')
      )
        throw new Error('S256 PKCE is not supported');
      const rendezvous = await input.api.execute('beginRegistryMcpOAuth', {
        agentId: input.agentId,
        connectorId: assignment.connectorId,
      });
      if (typeof rendezvous.state !== 'string' || typeof rendezvous.redirectUri !== 'string')
        throw new Error('OAuth callback is unavailable');
      const registration = await transport(registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Beeline',
          redirect_uris: [rendezvous.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!registration.ok) throw new Error('dynamic client registration was refused');
      const client = await jsonResponse(registration);
      if (typeof client.client_id !== 'string')
        throw new Error('dynamic client registration returned no client id');
      const verifier = base64url(randomBytes(48));
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      const resourceIndicator = safeUrl(resource.resource) ?? remoteUrl;
      const scope = Array.isArray(resource.scopes_supported)
        ? resource.scopes_supported
            .filter((item): item is string => typeof item === 'string')
            .join(' ')
        : challengeParameter(initialize.headers.get('www-authenticate'), 'scope');
      const authorizationUrl = new URL(authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: rendezvous.redirectUri,
        state: rendezvous.state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(scope ? { scope } : {}),
        resource: resourceIndicator,
      }).toString();
      const attemptId = base64url(randomBytes(18));
      writeState(path, {
        status: 'pending',
        connectorId: assignment.connectorId,
        serverName: pinnedName,
        version: pinnedVersion,
        remoteUrl: remoteUrl,
        resourceIndicator,
        state: rendezvous.state,
        redirectUri: rendezvous.redirectUri,
        verifier,
        tokenEndpoint,
        clientId: client.client_id,
        ...(typeof client.client_secret === 'string' ? { clientSecret: client.client_secret } : {}),
        authorizationUrl: authorizationUrl.toString(),
        attemptId,
      });
      return {
        status: 'installing',
        steps: steps('connect'),
        authorizationUrl: authorizationUrl.toString(),
        attemptId,
      };
    } catch (error) {
      const message =
        error instanceof OwnMachineRefusal
          ? error.message
          : 'This remote does not support standard dynamic-registration OAuth with S256 PKCE';
      return { status: 'error', steps: steps('discover', message), errorMessage: message };
    }
  }
}

export function registryMcpBrokerLaunch(
  connectorId: string,
  turnContextPath: string,
  brokerSocket = process.env.BEELINE_REGISTRY_MCP_BROKER_SOCKET,
): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const socketPath = brokerSocket;
  if (!socketPath) throw new Error('Registry MCP broker is unavailable');
  const env = {
    BEELINE_REGISTRY_MCP_BROKER_SOCKET: socketPath,
    BEELINE_REGISTRY_MCP_CONNECTOR: connectorId,
    BEELINE_TURN_CONTEXT_FILE: turnContextPath,
  };
  const meta = import.meta.url;
  if (meta.startsWith('beeline:')) {
    if (!process.argv[1]) throw new Error('Registry MCP broker entry is unavailable');
    return { command: process.execPath, args: [process.argv[1], REGISTRY_MCP_BROKER_FLAG], env };
  }
  const js = fileURLToPath(new URL('./registry-mcp.js', meta));
  if (existsSync(js)) return { command: process.execPath, args: [js], env };
  const ts = fileURLToPath(new URL('./registry-mcp.ts', meta));
  return {
    command: process.execPath,
    args: ['--import', createRequire(meta).resolve('tsx'), ts],
    env,
  };
}

/**
 * A Registry route is mounted behind the resource façade under its stable
 * `registry-mcp:<serverName>` target, exactly like every other host route.
 * `MCP_RESOURCE_GATE_TRANSPORT` says the TRANSPORT spends the grant: the
 * daemon-owned broker holds the only provider grant and is the one place a
 * call can actually reach the provider — including the call a sandbox makes
 * straight at the socket — so it makes the consuming decision, and the façade
 * asks the same gate without spending. One call, one Once grant.
 */
export function registryMcpHostDeclarations(
  routes: readonly RegistryMcpRoute[] | undefined,
  turnContextPath: string,
  brokerSocket = process.env.BEELINE_REGISTRY_MCP_BROKER_SOCKET,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    (routes ?? []).map((route) => {
      const launch = registryMcpBrokerLaunch(route.connectorId, turnContextPath, brokerSocket);
      return [
        route.routeName,
        {
          command: launch.command,
          args: launch.args,
          env: launch.env,
          [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST,
          [MCP_RESOURCE_TARGET_KEY]: route.target,
          [MCP_RESOURCE_GATE_KEY]: MCP_RESOURCE_GATE_TRANSPORT,
        },
      ];
    }),
  );
}

/** The broker socket is the only host path a Registry route needs inside a sandbox. */
export function registryMcpHostBindPaths(
  routes: readonly RegistryMcpRoute[] | undefined,
  brokerSocket = process.env.BEELINE_REGISTRY_MCP_BROKER_SOCKET,
): string[] {
  return routes?.length && brokerSocket ? [dirname(brokerSocket)] : [];
}

async function refresh(state: ConnectedState, transport: typeof fetch): Promise<ConnectedState> {
  if (!state.refreshToken || !state.tokenEndpoint || !state.clientId) return state;
  if (!state.expiresAt || state.expiresAt > Date.now() + 60_000) return state;
  const response = await transport(state.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
      client_id: state.clientId,
      ...(state.resourceIndicator ? { resource: state.resourceIndicator } : {}),
      ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('refresh refused');
  const token = await jsonResponse(response);
  if (typeof token.access_token !== 'string') throw new Error('refresh returned no access token');
  return {
    ...state,
    accessToken: token.access_token,
    ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
    ...(typeof token.expires_in === 'number'
      ? { expiresAt: Date.now() + Math.max(0, token.expires_in) * 1_000 }
      : {}),
  };
}

export type RegistryMcpTurnContext = {
  readonly roomId: string;
  readonly requestId: string;
  readonly generationId: string;
};

/** The existing per-call resource gate (`authorizeResourceCall`), nothing new. */
export type RegistryMcpCallAuthorizer = (
  input: RegistryMcpTurnContext & { readonly target: string; readonly consume: boolean },
) => Promise<boolean>;

export const REGISTRY_MCP_APPROVAL_REFUSAL =
  'Resource access requires approval from its owner for this requester, or the resource is unavailable.';

export const REGISTRY_MCP_UNAVAILABLE =
  'Registry MCP provider is unavailable; reconnect it in Workbench.';

class RegistryMcpRefusal extends Error {
  constructor() {
    super(REGISTRY_MCP_APPROVAL_REFUSAL);
  }
}

type BrokerRequest = { connectorId: string; line: string; turn?: RegistryMcpTurnContext };

function readTurnContext(value: unknown): RegistryMcpTurnContext | undefined {
  const turn = value as Partial<RegistryMcpTurnContext> | undefined;
  return turn &&
    typeof turn.roomId === 'string' &&
    turn.roomId.length > 0 &&
    typeof turn.requestId === 'string' &&
    turn.requestId.length > 0 &&
    typeof turn.generationId === 'string' &&
    turn.generationId.length > 0
    ? { roomId: turn.roomId, requestId: turn.requestId, generationId: turn.generationId }
    : undefined;
}

function jsonRpcMethod(line: string): string {
  let method: unknown;
  try {
    method = (JSON.parse(line) as { method?: unknown }).method;
  } catch {
    throw new RegistryMcpRefusal();
  }
  if (typeof method !== 'string') throw new RegistryMcpRefusal();
  return method;
}

function brokerSocketPath(home = homedir()): string {
  return join(home, '.beeline', 'registry-mcp-broker', `${process.pid}.sock`);
}

/**
 * The daemon-owned broker: provider grants never enter a harness process or
 * its configuration. The socket is bound read-write into the sandbox, so this
 * — not the harness's MCP client — is where every call is authorized: the
 * caller names a turn, and the server's own requester-aware resource gate
 * decides. A caller that names no active turn reaches no provider at all.
 */
export class RegistryMcpHostBroker {
  readonly socketPath: string;
  private server?: Server;
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly home = homedir(),
    private readonly transport: typeof fetch = fetch,
    private readonly authorize?: RegistryMcpCallAuthorizer,
    socketPath = brokerSocketPath(home),
  ) {
    this.socketPath = socketPath;
  }

  async request(
    connectorId: string,
    line: string,
    turn: RegistryMcpTurnContext | undefined,
  ): Promise<string[]> {
    if (line.length > 1024 * 1024) throw new Error('Registry MCP request is too large');
    const path = registryMcpStatePath(connectorId, this.home);
    let state = readState(path);
    if (state?.status !== 'connected') throw new Error('Registry MCP connection is unavailable');
    const method = jsonRpcMethod(line);
    await this.authorizeCall(state, method, turn);
    const refreshed = await refresh(state, this.transport);
    if (refreshed !== state) {
      state = refreshed;
      writeState(path, state);
    }
    // An `initialize` opens a NEW provider session, so a cached id is never
    // sent on it.
    const cached = method === 'initialize' ? undefined : this.sessions.get(connectorId);
    const response = await this.transport(state.remoteUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(state.accessToken ? { authorization: `Bearer ${state.accessToken}` } : {}),
        ...(cached ? { 'mcp-session-id': cached } : {}),
      },
      body: line,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      // 404 is the streamable-HTTP signal that this session id is gone. A
      // 401/429/5xx is the provider refusing ONE call, and dropping the id
      // there would leave every later call session-less for the rest of the
      // harness session, which nothing re-initializes.
      if (response.status === 404) this.sessions.delete(connectorId);
      throw new Error('remote refused call');
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessions.set(connectorId, session);
    if (response.status === 202 || response.status === 204) return [];
    const body = await response.text();
    if (response.headers.get('content-type')?.includes('text/event-stream'))
      return body
        .split(/\r?\n/)
        .flatMap((row) => (row.startsWith('data:') ? [row.slice(5).trim()] : []));
    return body.trim() ? [body.trim()] : [];
  }

  /** Reuses the server's own owner/yolo/grant matrix; it adds no rule of its own. */
  private async authorizeCall(
    state: ConnectedState,
    method: string,
    turn: RegistryMcpTurnContext | undefined,
  ): Promise<void> {
    const context = readTurnContext(turn);
    if (!this.authorize || !context) throw new RegistryMcpRefusal();
    const allowed = await this.authorize({
      ...context,
      target: `registry-mcp:${state.serverName}`,
      consume: !NON_CONSUMING.has(method),
    });
    if (!allowed) throw new RegistryMcpRefusal();
  }

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(registryMcpStateRoot(this.home), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) socket.destroy();
      });
      socket.on('end', () => {
        void (async () => {
          try {
            const request = JSON.parse(buffer) as BrokerRequest;
            if (typeof request.connectorId !== 'string' || typeof request.line !== 'string')
              throw new Error('invalid broker request');
            const messages = await this.request(request.connectorId, request.line, request.turn);
            socket.end(`${JSON.stringify({ messages })}\n`);
          } catch (error) {
            socket.end(
              `${JSON.stringify({
                error:
                  error instanceof RegistryMcpRefusal
                    ? REGISTRY_MCP_APPROVAL_REFUSAL
                    : REGISTRY_MCP_UNAVAILABLE,
              })}\n`,
            );
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.socketPath, { force: true });
  }
}

async function brokerRequest(socketPath: string, request: BrokerRequest): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(125_000, () => socket.destroy(new Error('Registry MCP broker timed out')));
    socket.on('connect', () => socket.end(JSON.stringify(request)));
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const parsed = JSON.parse(output) as { messages?: unknown; error?: unknown };
        if (typeof parsed.error === 'string') throw new Error(parsed.error);
        if (
          !Array.isArray(parsed.messages) ||
          !parsed.messages.every((entry) => typeof entry === 'string')
        )
          throw new Error('Registry MCP broker returned an invalid response');
        resolve(parsed.messages);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Stdio MCP bridge. It sees only a local socket capability, never provider
 * credentials, and it names the turn it is running inside so the broker can
 * put the call through the owner's existing resource approval.
 */
export function runRegistryMcpBroker(env: NodeJS.ProcessEnv = process.env): void {
  const socketPath = env.BEELINE_REGISTRY_MCP_BROKER_SOCKET;
  const connectorId = env.BEELINE_REGISTRY_MCP_CONNECTOR;
  const turnContextPath = env.BEELINE_TURN_CONTEXT_FILE;
  if (!socketPath || !connectorId || !turnContextPath)
    throw new Error('Registry MCP broker is unavailable');
  let pending = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    pending = pending.then(async () => {
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      let turn: RegistryMcpTurnContext | undefined;
      try {
        turn = readTurnContext(JSON.parse(readFileSync(turnContextPath, 'utf8')));
      } catch {
        turn = undefined;
      }
      try {
        for (const message of await brokerRequest(socketPath, {
          connectorId,
          line,
          ...(turn ? { turn } : {}),
        }))
          process.stdout.write(`${message}\n`);
      } catch (error) {
        if (request.id !== undefined) {
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32002,
                message: error instanceof Error ? error.message : REGISTRY_MCP_UNAVAILABLE,
              },
            })}\n`,
          );
        }
      }
    });
  });
}

if (/registry-mcp\.(?:js|ts)$/.test(process.argv[1] ?? '')) runRegistryMcpBroker();
