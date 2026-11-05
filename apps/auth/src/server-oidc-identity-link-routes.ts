import type { AuthRouteContext } from './server-context.js';

export function registerOidcIdentityLinkRoutes(context: AuthRouteContext): void {

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
    observeSigninAttempt,
    provisionManagedIdentity,
    completeGitHubInstallation,
    githubInstallReturnPage,
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
    await observeSigninAttempt({ stage: 'ticket_exchanged', ticketHash, at: now() });
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
