import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { AuthStore } from './store.js';
import { OidcClient } from './oidc.js';
import {
  isValidNip05Name,
  normalizeHost,
  OIDC_BIND_KIND,
  OIDC_BIND_MARKER,
  randomToken,
  sha256,
  verifyBindEvent,
  verifyNip98Header,
} from './protocol.js';

const DEFAULT_FLOW_TTL_MS = 5 * 60_000;
const DEFAULT_TICKET_TTL_MS = 2 * 60_000;
const FLOW_COOKIE = '__Host-beeline_oidc_flow';

export interface AuthTenant {
  host: string;
  community: string;
  origin: string;
}

export interface AuthServerOptions {
  store: AuthStore;
  oidc: OidcClient;
  tenants: AuthTenant[];
  now?: () => Date;
  flowTtlMs?: number;
  ticketTtlMs?: number;
  logger?: boolean;
  /** Exact native completion URLs; never accept an arbitrary OAuth open redirect. */
  nativeRedirectUris?: string[];
  /** Local device emulators only. Production browser-session cookies stay Secure. */
  secureCookies?: boolean;
}

class ProtocolError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function noStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
  reply.header('referrer-policy', 'no-referrer');
}

function requiredQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) {
    throw new ProtocolError(400, 'invalid_request', `missing or invalid ${name}`);
  }
  return value;
}

function flowCookie(request: FastifyRequest, cookieName = FLOW_COOKIE): string {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1)
    throw new ProtocolError(400, 'invalid_oidc_flow', 'OIDC browser session is missing');
  const value = matches[0]!.slice(cookieName.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ProtocolError(400, 'invalid_oidc_flow', 'OIDC browser session is invalid');
  }
  return value;
}

function publicUrl(tenant: AuthTenant, request: FastifyRequest): string {
  const path = request.raw.url;
  if (!path?.startsWith('/'))
    throw new ProtocolError(400, 'invalid_request', 'invalid request URL');
  return `${tenant.origin}${path}`;
}

export function buildAuthServer(options: AuthServerOptions): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS;
  const ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  const nativeRedirectUris = new Set(options.nativeRedirectUris ?? []);
  const cookieSecurity = options.secureCookies === false ? '' : ' Secure;';
  const flowCookieName = options.secureCookies === false ? 'beeline_oidc_flow' : FLOW_COOKIE;
  if (flowTtlMs < 30_000 || flowTtlMs > 10 * 60_000)
    throw new Error('flow TTL is outside safe bounds');
  if (ticketTtlMs < 30_000 || ticketTtlMs > 5 * 60_000)
    throw new Error('ticket TTL is outside safe bounds');

  const tenants = new Map<string, AuthTenant>();
  for (const configured of options.tenants) {
    const host = normalizeHost(configured.host);
    if (!configured.community || configured.community.length > 512)
      throw new Error('invalid tenant community');
    const origin = new URL(configured.origin);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    ) {
      throw new Error('tenant origin must be an origin without a path');
    }
    const normalizedOrigin = origin.origin;
    if (normalizeHost(origin.host) !== host) throw new Error('tenant origin and Host must match');
    if (tenants.has(host)) throw new Error(`duplicate auth tenant Host: ${host}`);
    tenants.set(host, { host, community: configured.community, origin: normalizedOrigin });
  }
  if (tenants.size === 0) throw new Error('at least one auth tenant is required');

  const tenantFor = (request: FastifyRequest): AuthTenant => {
    let host: string;
    try {
      host = normalizeHost(request.headers.host ?? '');
    } catch {
      throw new ProtocolError(400, 'invalid_host', 'invalid Host header');
    }
    const tenant = tenants.get(host);
    if (!tenant) throw new ProtocolError(404, 'unknown_tenant', 'unknown tenant Host');
    return tenant;
  };

  const nativeCompletion = (
    flow: { appRedirectUri: string | null; appState: string | null },
    values: Record<string, string | number>,
  ): URL | null => {
    if (!flow.appRedirectUri || !flow.appState) return null;
    const target = new URL(flow.appRedirectUri);
    target.searchParams.set('state', flow.appState);
    for (const [name, value] of Object.entries(values))
      target.searchParams.set(name, String(value));
    return target;
  };

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProtocolError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
      void reply.status(413).send({ error: 'request_too_large' });
      return;
    }
    void reply.status(500).send({ error: 'internal_error' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/.well-known/nostr.json', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const name = typeof query.name === 'string' ? query.name : null;
    const names: Record<string, string> = {};
    if (name && isValidNip05Name(name)) {
      const pubkey = await options.store.resolveNip05Name(name);
      if (pubkey) names[name] = pubkey;
    }
    reply.header('access-control-allow-origin', '*');
    return reply.type('application/json').send({ names });
  });

  app.get('/auth/oidc/start', async (request, reply) => {
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const appRedirect = query.app_redirect;
    const appState = query.app_state;
    if ((appRedirect === undefined) !== (appState === undefined)) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'app redirect and state must be supplied together',
      );
    }
    let appRedirectUri: string | null = null;
    let boundAppState: string | null = null;
    if (appRedirect !== undefined && appState !== undefined) {
      const associatedRedirect = `${tenant.origin}/auth/oidc/mobile-callback`;
      if (
        typeof appRedirect !== 'string' ||
        (appRedirect !== associatedRedirect && !nativeRedirectUris.has(appRedirect))
      ) {
        throw new ProtocolError(
          400,
          'invalid_request',
          'native completion redirect is not allowed',
        );
      }
      if (typeof appState !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(appState)) {
        throw new ProtocolError(400, 'invalid_request', 'native completion state is invalid');
      }
      appRedirectUri = appRedirect;
      boundAppState = appState;
    }
    const issuedAt = now();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const browserSession = randomToken();
    const codeChallenge = Buffer.from(sha256Bytes(verifier)).toString('base64url');
    const redirectUri = `${tenant.origin}/auth/oidc/callback`;
    await options.store.createFlow(sha256(state), {
      community: tenant.community,
      issuer: options.oidc.config.issuer,
      audience: options.oidc.config.clientId,
      nonce,
      pkceVerifier: verifier,
      browserSessionHash: sha256(browserSession),
      redirectUri,
      appRedirectUri,
      appState: boundAppState,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    noStore(reply);
    reply.header(
      'set-cookie',
      `${flowCookieName}=${browserSession}; Path=/; Max-Age=${Math.floor(flowTtlMs / 1_000)};${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    return reply.redirect(
      options.oidc.authorizationUrl({ state, nonce, codeChallenge, redirectUri }),
      302,
    );
  });

  app.get('/auth/oidc/callback', async (request, reply) => {
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const state = requiredQueryString(query.state, 'state');
    const browserSession = flowCookie(request, flowCookieName);
    const flow = await options.store.consumeFlow(sha256(state), sha256(browserSession), now());
    if (!flow)
      throw new ProtocolError(
        400,
        'invalid_oidc_flow',
        'OIDC flow is missing, expired, or already used',
      );
    reply.header(
      'set-cookie',
      `${flowCookieName}=; Path=/; Max-Age=0;${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    if (
      flow.community !== tenant.community ||
      flow.issuer !== options.oidc.config.issuer ||
      flow.audience !== options.oidc.config.clientId ||
      flow.redirectUri !== `${tenant.origin}/auth/oidc/callback`
    ) {
      throw new ProtocolError(400, 'invalid_oidc_flow', 'OIDC flow tenant or provider mismatch');
    }
    if (typeof query.error === 'string') {
      const completion = nativeCompletion(flow, {
        error: 'oidc_denied',
        message: 'Google authorization was canceled or denied',
      });
      if (completion) return reply.redirect(completion.toString(), 302);
      throw new ProtocolError(401, 'oidc_denied', 'OIDC provider denied the authorization request');
    }
    const code = requiredQueryString(query.code, 'code');

    let identity;
    try {
      const idToken = await options.oidc.exchangeCode(code, flow.pkceVerifier, flow.redirectUri);
      identity = await options.oidc.verifyIdToken(idToken, flow.nonce);
    } catch {
      const completion = nativeCompletion(flow, {
        error: 'invalid_oidc_proof',
        message: 'Google authorization expired or could not be verified',
      });
      if (completion) return reply.redirect(completion.toString(), 302);
      throw new ProtocolError(
        401,
        'invalid_oidc_proof',
        'OIDC code exchange or ID token validation failed',
      );
    }

    const ticket = randomToken();
    const challenge = randomToken();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ticketTtlMs);
    await options.store.createTicket(sha256(ticket), {
      challenge,
      community: tenant.community,
      issuer: identity.issuer,
      audience: identity.audience,
      subject: identity.subject,
      createdAt: issuedAt,
      expiresAt,
      attemptCount: 0,
      consumedAt: null,
      boundPubkey: null,
    });
    noStore(reply);
    const bindChallenge = {
      protocol: 1,
      kind: OIDC_BIND_KIND,
      marker: OIDC_BIND_MARKER,
      ticket,
      challenge,
      provider: identity.issuer,
      audience: identity.audience,
      subject: identity.subject,
      community: tenant.community,
      issued_at: Math.floor(issuedAt.getTime() / 1_000),
      expires_at: Math.floor(expiresAt.getTime() / 1_000),
    } as const;
    const completion = nativeCompletion(flow, bindChallenge);
    if (completion) return reply.redirect(completion.toString(), 302);
    return reply.send(bindChallenge);
  });

  app.post('/auth/oidc/bind', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_bind', 'expected bind request object');
    }
    const body = request.body as Record<string, unknown>;
    const ticketValue = body.ticket;
    if (typeof ticketValue !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticketValue)) {
      throw new ProtocolError(400, 'invalid_bind', 'invalid bind ticket');
    }
    const ticketHash = sha256(ticketValue);
    const ticket = await options.store.findTicket(ticketHash);
    if (!ticket || ticket.community !== tenant.community) {
      throw new ProtocolError(404, 'unknown_ticket', 'bind ticket not found');
    }
    if (ticket.expiresAt.getTime() < now().getTime()) {
      throw new ProtocolError(410, 'ticket_expired', 'bind ticket expired');
    }

    const verification = verifyBindEvent(
      body.event,
      {
        protocol: 1,
        ticket: ticketValue,
        challenge: ticket.challenge,
        issuer: ticket.issuer,
        audience: ticket.audience,
        subject: ticket.subject,
        community: ticket.community,
        issuedAt: ticket.createdAt,
        expiresAt: ticket.expiresAt,
      },
      now(),
    );
    if (!verification.ok) {
      if (ticket.consumedAt)
        throw new ProtocolError(409, 'ticket_used', 'bind ticket already used');
      await options.store.recordFailedTicketAttempt(ticketHash, now());
      throw new ProtocolError(400, 'invalid_bind_event', verification.reason);
    }
    if (ticket.consumedAt) {
      if (ticket.boundPubkey !== verification.event.pubkey) {
        throw new ProtocolError(409, 'ticket_used', 'bind ticket already used');
      }
      noStore(reply);
      return reply.send({ linked: true, idempotent: true, pubkey: verification.event.pubkey });
    }

    const result = await options.store.consumeTicketAndLink(
      ticketHash,
      verification.event.pubkey,
      now(),
    );
    if (result.status === 'missing')
      throw new ProtocolError(404, 'unknown_ticket', 'bind ticket not found');
    if (result.status === 'used') {
      const raced = await options.store.findTicket(ticketHash);
      if (raced?.boundPubkey === verification.event.pubkey) {
        noStore(reply);
        return reply.send({ linked: true, idempotent: true, pubkey: verification.event.pubkey });
      }
      throw new ProtocolError(409, 'ticket_used', 'bind ticket already used');
    }
    if (result.status === 'expired')
      throw new ProtocolError(410, 'ticket_expired', 'bind ticket expired');
    if (result.status === 'conflict') {
      throw new ProtocolError(
        409,
        'identity_conflict',
        'identity is already bound to another public key',
      );
    }
    if (!('link' in result)) throw new Error('unexpected bind transaction result');
    noStore(reply);
    return reply.status(result.status === 'linked' ? 201 : 200).send({
      linked: true,
      idempotent: result.status === 'idempotent',
      pubkey: result.link.pubkey,
    });
  });

  app.get<{ Params: { pubkey: string } }>('/auth/oidc/links/:pubkey', async (request, reply) => {
    const tenant = tenantFor(request);
    const pubkey = request.params.pubkey;
    if (!/^[0-9a-f]{64}$/.test(pubkey))
      throw new ProtocolError(400, 'invalid_pubkey', 'invalid public key');
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'GET',
      now(),
    );
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
    }
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    const links = await options.store.linksForPubkey(tenant.community, pubkey);
    noStore(reply);
    return reply.send({
      links: links.map((link) => ({
        community: link.community,
        provider: link.issuer,
        audience: link.audience,
        subject: link.subject,
        pubkey: link.pubkey,
        created_at: link.createdAt.toISOString(),
      })),
    });
  });

  app.post('/nip05/claim', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected claim request object');
    }
    const body = request.body as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== 'string' || !isValidNip05Name(name)) {
      throw new ProtocolError(
        400,
        'invalid_name',
        'handle must be 1-30 lowercase letters, numbers, dashes, or underscores, and not reserved',
      );
    }
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'POST',
      now(),
    );
    if (!auth.ok) throw new ProtocolError(401, 'unauthorized', auth.reason);
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    const outcome = await options.store.claimNip05Name(name, auth.pubkey, authNow);
    if (outcome === 'taken') throw new ProtocolError(409, 'name_taken', 'handle is already claimed');
    noStore(reply);
    return reply.status(outcome === 'claimed' ? 201 : 200).send({
      claimed: true,
      idempotent: outcome === 'idempotent',
      name,
      pubkey: auth.pubkey,
    });
  });

  return app;
}

function sha256Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(sha256(value), 'hex'));
}
