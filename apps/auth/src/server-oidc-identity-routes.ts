import type { GitHubIdentity } from './github.js';
import type { AuthRouteContext } from './server-context.js';
import { agentConnectApprovedPage } from './server-agent-connect-routes.js';
import { verifyPhoneGitHubTicket } from './phone-github-ticket.js';
export function registerServerOidcIdentityRoutes(context: AuthRouteContext): void {
  const {
    app,
    options,
    now,
    flowTtlMs,
    ticketTtlMs,
    isAllowedAppRedirect,
    cookieSecurity,
    flowCookieName,
    encryptGitHubToken,
    tenantFor,
    nativeCompletion,
    deliverNativeCompletion,
    issueBindChallenge,
    provisionManagedIdentity,
    completeGitHubInstallation,
    noStore,
    managedIdentityJson,
    nativeReturnPage,
    requiredQueryString,
    flowCookie,
    publicUrl,
    ProtocolError,
    GITHUB_SIGN_IN_DEEP_LINK,
    GITHUB_INSTALLATION_DEEP_LINK,
    sha256Bytes,
    OIDC_BIND_KIND,
    OIDC_BIND_MARKER,
    randomToken,
    sha256,
    verifyBindEvent,
    verifyNip98Header,
    completeAgentConnectApproval,
  } = context;
  app.get('/health', async () => ({ ok: true }));

  /** Public feature discovery. Missing GitHub config deliberately means dark. */
  app.get('/auth/capabilities', async (request, reply) => {
    tenantFor(request);
    noStore(reply);
    return reply.send({ github: Boolean(options.github), oidc: true });
  });

  /** One-use bridge from the existing native GitHub ceremony to monolith sessions. */
  app.post('/auth/github/phone-exchange', async (request, reply) => {
    const tenant = tenantFor(request);
    const body = request.body as Record<string, unknown>;
    if (typeof body.ticket !== 'string') {
      throw new ProtocolError(400, 'invalid_ticket', 'GitHub exchange ticket is invalid');
    }
    const result = await verifyPhoneGitHubTicket(
      options.store,
      tenant.community,
      body.ticket,
      now(),
    );
    noStore(reply);
    if (result.status === 'invalid') {
      throw new ProtocolError(400, 'invalid_ticket', 'GitHub exchange ticket is invalid');
    }
    if (result.status !== 'verified') {
      return reply.code(401).send({ error: `github_ticket_${result.status}` });
    }
    return reply.send(result.identity);
  });

  app.get('/auth/github/mobile-callback', async (request, reply) => {
    const tenant = tenantFor(request);
    const callback = new URL(publicUrl(tenant, request));
    const target = new URL(
      callback.searchParams.get('installed') === '1'
        ? GITHUB_INSTALLATION_DEEP_LINK
        : GITHUB_SIGN_IN_DEEP_LINK,
    );
    target.search = callback.search;
    noStore(reply);
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    return reply.type('text/html; charset=utf-8').send(nativeReturnPage(target));
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
        !isAllowedAppRedirect(appRedirect, associatedRedirect)
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

  app.get('/auth/github/start', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub sign-in is not configured');
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const appRedirect = query.app_redirect;
    const appState = query.app_state;
    const deviceUserCode = query.device_user_code;
    if (deviceUserCode !== undefined && (appRedirect !== undefined || appState !== undefined)) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'device approval cannot be combined with a native app redirect',
      );
    }
    if ((appRedirect === undefined) !== (appState === undefined)) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'app redirect and state must be supplied together',
      );
    }
    let appRedirectUri: string | null = null;
    let boundAppState: string | null = null;
    let deviceCodeHash: string | null = null;
    if (appRedirect !== undefined && appState !== undefined) {
      const associatedRedirect = `${tenant.origin}/auth/github/mobile-callback`;
      if (
        typeof appRedirect !== 'string' ||
        !isAllowedAppRedirect(appRedirect, associatedRedirect)
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
    if (deviceUserCode !== undefined) {
      if (typeof deviceUserCode !== 'string') {
        throw new ProtocolError(400, 'invalid_request', 'device connection code is invalid');
      }
      const device = await options.store.findAgentConnectDeviceByUserCode(
        deviceUserCode.toUpperCase(),
      );
      if (
        !device ||
        device.tenantCommunity !== tenant.community ||
        device.expiresAt.getTime() < now().getTime() ||
        device.approvedAt
      ) {
        throw new ProtocolError(404, 'unknown_device', 'device connection not found');
      }
      deviceCodeHash = device.deviceCodeHash;
    }
    const issuedAt = now();
    const state = randomToken();
    const verifier = randomToken();
    const browserSession = randomToken();
    const codeChallenge = Buffer.from(sha256Bytes(verifier)).toString('base64url');
    const redirectUri = `${tenant.origin}/auth/github/callback`;
    await options.store.createFlow(sha256(state), {
      community: tenant.community,
      issuer: 'https://github.com',
      audience: options.github.oauth.config.clientId,
      nonce: randomToken(),
      pkceVerifier: verifier,
      browserSessionHash: sha256(browserSession),
      redirectUri,
      appRedirectUri,
      appState: boundAppState,
      deviceCodeHash,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    noStore(reply);
    reply.header(
      'set-cookie',
      `${flowCookieName}=${browserSession}; Path=/; Max-Age=${Math.floor(flowTtlMs / 1_000)};${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    return reply.redirect(
      options.github.oauth.authorizationUrl({ state, codeChallenge, redirectUri }),
      302,
    );
  });

  app.get('/auth/github/callback', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub sign-in is not configured');
    const query = request.query as Record<string, unknown>;
    // Request-user-authorization-on-install makes this the GitHub App's only
    // post-install callback too. Repository selection updates carry the
    // installation id/setup action instead of an ordinary sign-in code.
    if (query.installation_id !== undefined || query.setup_action !== undefined) {
      return completeGitHubInstallation(request, reply);
    }
    const tenant = tenantFor(request);
    const state = requiredQueryString(query.state, 'state');
    const browserSession = flowCookie(request, flowCookieName);
    const flow = await options.store.consumeFlow(sha256(state), sha256(browserSession), now());
    if (!flow)
      throw new ProtocolError(
        400,
        'invalid_oauth_flow',
        'GitHub flow is missing, expired, or already used',
      );
    reply.header(
      'set-cookie',
      `${flowCookieName}=; Path=/; Max-Age=0;${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    if (
      flow.community !== tenant.community ||
      flow.issuer !== 'https://github.com' ||
      flow.audience !== options.github.oauth.config.clientId ||
      flow.redirectUri !== `${tenant.origin}/auth/github/callback`
    ) {
      throw new ProtocolError(400, 'invalid_oauth_flow', 'GitHub flow tenant or provider mismatch');
    }
    if (typeof query.error === 'string') {
      const completion = nativeCompletion(flow, {
        error: 'github_denied',
        message: 'GitHub authorization was canceled or denied',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'github_denied', 'GitHub denied the authorization request');
    }
    const code = requiredQueryString(query.code, 'code');
    let identity: GitHubIdentity;
    try {
      identity = await options.github.oauth.exchangeCode(code, flow.redirectUri, flow.pkceVerifier);
    } catch {
      const completion = nativeCompletion(flow, {
        error: 'invalid_github_proof',
        message: 'GitHub authorization expired or could not be verified',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'invalid_github_proof', 'GitHub code exchange failed');
    }
    await options.store.saveGitHubUserToken(
      tenant.community,
      identity.subject,
      encryptGitHubToken(identity.accessToken),
      now(),
    );
    if (flow.deviceCodeHash) {
      await completeAgentConnectApproval(tenant, flow, identity);
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply.type('text/html; charset=utf-8').send(agentConnectApprovedPage());
    }
    return issueBindChallenge(tenant, flow, identity, reply);
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
      if (completion) return deliverNativeCompletion(reply, completion);
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
      if (completion) return deliverNativeCompletion(reply, completion);
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
    if (completion) return deliverNativeCompletion(reply, completion);
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
      const links = await options.store.linksForPubkey(ticket.community, verification.event.pubkey);
      const actuallyLinked = links.some(
        (link) =>
          link.issuer === ticket.issuer &&
          link.audience === ticket.audience &&
          link.subject === ticket.subject,
      );
      if (actuallyLinked) {
        const identity = await provisionManagedIdentity(ticket, verification.event.pubkey);
        noStore(reply);
        return reply.send({
          linked: true,
          idempotent: true,
          pubkey: verification.event.pubkey,
          ...(identity ? { identity: managedIdentityJson(identity) } : {}),
        });
      }
      throw new ProtocolError(
        409,
        'identity_conflict',
        'identity is already bound to another public key',
      );
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
        const links = await options.store.linksForPubkey(
          raced.community,
          verification.event.pubkey,
        );
        const actuallyLinked = links.some(
          (link) =>
            link.issuer === raced.issuer &&
            link.audience === raced.audience &&
            link.subject === raced.subject,
        );
        if (actuallyLinked) {
          const identity = await provisionManagedIdentity(raced, verification.event.pubkey);
          noStore(reply);
          return reply.send({
            linked: true,
            idempotent: true,
            pubkey: verification.event.pubkey,
            ...(identity ? { identity: managedIdentityJson(identity) } : {}),
          });
        }
        throw new ProtocolError(
          409,
          'identity_conflict',
          'identity is already bound to another public key',
        );
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
    const identity = await provisionManagedIdentity(ticket, result.link.pubkey);
    noStore(reply);
    return reply.status(result.status === 'linked' ? 201 : 200).send({
      linked: true,
      idempotent: result.status === 'idempotent',
      pubkey: result.link.pubkey,
      ...(identity ? { identity: managedIdentityJson(identity) } : {}),
    });
  });

  app.post('/auth/oidc/recover', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_recovery', 'expected recovery request object');
    }
    const body = request.body as Record<string, unknown>;
    if (body.confirm_replace !== true) {
      throw new ProtocolError(
        400,
        'recovery_confirmation_required',
        'explicit device-key replacement confirmation is required',
      );
    }
    const ticketValue = body.ticket;
    if (typeof ticketValue !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticketValue)) {
      throw new ProtocolError(400, 'invalid_recovery', 'invalid recovery ticket');
    }
    const ticketHash = sha256(ticketValue);
    const ticket = await options.store.findTicket(ticketHash);
    if (!ticket || ticket.community !== tenant.community) {
      throw new ProtocolError(404, 'unknown_ticket', 'recovery ticket not found');
    }
    if (ticket.expiresAt.getTime() < now().getTime()) {
      throw new ProtocolError(410, 'ticket_expired', 'recovery ticket expired');
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
      throw new ProtocolError(400, 'invalid_bind_event', verification.reason);
    }

    const result = await options.store.recoverConsumedTicketLink(
      ticketHash,
      verification.event.pubkey,
      now(),
    );
    if (result.status === 'missing')
      throw new ProtocolError(404, 'recovery_not_available', 'conflicting identity link not found');
    if (result.status === 'unused')
      throw new ProtocolError(
        409,
        'recovery_not_available',
        'normal device bind must be attempted first',
      );
    if (result.status === 'not_eligible')
      throw new ProtocolError(
        409,
        'recovery_not_available',
        'device bind did not produce a conflict',
      );
    if (result.status === 'wrong_key')
      throw new ProtocolError(409, 'ticket_used', 'recovery ticket belongs to another device key');
    if (result.status === 'expired')
      throw new ProtocolError(410, 'ticket_expired', 'recovery ticket expired');
    if (!('link' in result)) throw new Error('unexpected recovery transaction result');

    const identity = await provisionManagedIdentity(ticket, result.link.pubkey);
    noStore(reply);
    return reply.send({
      linked: true,
      replaced: result.status === 'replaced',
      pubkey: result.link.pubkey,
      ...(identity ? { identity: managedIdentityJson(identity) } : {}),
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

  app.get<{ Params: { pubkey: string } }>('/auth/identity/:pubkey', async (request, reply) => {
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
    const identity = await options.store.managedIdentity(tenant.community, pubkey);
    noStore(reply);
    return reply.send({ identity: identity ? managedIdentityJson(identity) : null });
  });

  app.post<{ Params: { pubkey: string } }>(
    '/auth/identity/:pubkey/github-handle',
    async (request, reply) => {
      const tenant = tenantFor(request);
      const pubkey = request.params.pubkey;
      if (!/^[0-9a-f]{64}$/.test(pubkey))
        throw new ProtocolError(400, 'invalid_pubkey', 'invalid public key');
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        (request.body as Record<string, unknown>).confirm_rename !== true
      ) {
        throw new ProtocolError(400, 'rename_confirmation_required', 'confirm the handle rename');
      }
      const auth = verifyNip98Header(
        request.headers.authorization,
        publicUrl(tenant, request),
        'POST',
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
      const result = await options.store.adoptGitHubHandle(tenant.community, pubkey, authNow);
      if (result.status === 'unavailable') {
        throw new ProtocolError(409, 'rename_not_available', 'GitHub handle rename is unavailable');
      }
      noStore(reply);
      return reply.send({ renamed: true, identity: managedIdentityJson(result.identity) });
    },
  );

  /**
   * The key-succession chain BELOW this key: the device keys that previously
   * held this identity, oldest first. Served only to the key itself (NIP-98
   * signer must equal the requested pubkey) so a successor client can
   * rediscover the Workspaces its predecessor's key authored/joined and
   * migrate its own memberships in — zero re-inviting after a replace.
   */
  app.get<{ Params: { pubkey: string } }>(
    '/auth/oidc/predecessors/:pubkey',
    async (request, reply) => {
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
      const predecessors = await options.store.successionPredecessors(tenant.community, pubkey);
      noStore(reply);
      return reply.send({ predecessors });
    },
  );

  /**
   * Resolve a historical device key to the current key of that identity.
   * Any authenticated tenant actor may ask: paired agents need this narrow
   * answer to authorize human-authored soul overlays after device recovery.
   * The endpoint reveals no link/profile data and an unrelated key resolves
   * to itself, preserving the registry's fail-closed equality semantics.
   */
  app.get<{ Params: { pubkey: string } }>('/auth/oidc/current/:pubkey', async (request, reply) => {
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
    if (!auth.ok) throw new ProtocolError(401, 'unauthorized', auth.reason);
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    const currentPubkey = await options.store.resolveCurrentPubkey(tenant.community, pubkey);
    noStore(reply);
    return reply.send({ current_pubkey: currentPubkey });
  });
}
