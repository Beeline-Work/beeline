import type { FastifyRequest } from 'fastify';
import type { AuthRouteContext } from './server-context.js';
export function registerServerGithubEventsRoutes(context: AuthRouteContext): void {
  const {
    app,
    options,
    now,
    tenantFor,
    wakeGitHubRepoEventWaiters,
    waitForGitHubRepoEvent,
    completeActivatedRoomLinks,
    roomAuthorityCache,
    noStore,
    githubRepositoryFromPayload,
    githubInstallationId,
    verifyGitHubWebhookSignature,
    publicUrl,
    ProtocolError,
    GITHUB_REPO_EVENT_TYPES,
    GITHUB_REPO_EVENT_FETCH_LIMIT,
    GITHUB_REPO_EVENT_MAX_WAIT_MS,
    GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS,
    extractGitHubRepoEvent,
    resolveGitHubRepositoryAccess,
    verifyNip98Header,
  } = context;
  app.post('/auth/github/room-events', async (request, reply) => {
    if (!options.authorizeGitHubRoomToken) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub repository access is unavailable');
    }
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_request', 'expected Room event request');
    }
    const body = request.body as Record<string, unknown>;
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
    const roomId = typeof body.room_id === 'string' ? body.room_id : '';
    const relayAuthorizations = Array.isArray(body.relay_authorizations)
      ? body.relay_authorizations.filter((value): value is string => typeof value === 'string')
      : [];
    if (
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !roomId ||
      roomId.length > 200 ||
      relayAuthorizations.length !== 16 ||
      relayAuthorizations.some((value) => !value || value.length > 4_096)
    ) {
      throw new ProtocolError(400, 'invalid_request', 'invalid Room event request');
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
    for (const relayAuthorization of relayAuthorizations) {
      const relayAuth = verifyNip98Header(
        relayAuthorization,
        `${tenant.origin}/query`,
        'POST',
        now(),
      );
      if (!relayAuth.ok || relayAuth.pubkey !== pubkey) {
        throw new ProtocolError(
          401,
          'unauthorized_relay_read',
          relayAuth.ok ? 'relay NIP-98 signer mismatch' : relayAuth.reason,
        );
      }
    }
    const authNow = now();
    if (
      !(await options.store.claimNip98Event(
        auth.eventId,
        new Date(authNow.getTime() + 120_000),
        authNow,
      ))
    ) {
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    }
    // Omitted `since` is the bootstrap read: "start from now" — the response
    // carries no backlog, just the cursor to begin from. An explicit `since`
    // releases everything stored after it (delivered late to a daemon that
    // was offline when the events arrived), oldest first.
    const sinceRaw = body.since;
    let since: number | undefined =
      typeof sinceRaw === 'number' && Number.isSafeInteger(sinceRaw) && sinceRaw >= 0
        ? sinceRaw
        : undefined;
    const waitMsRaw = body.wait_ms;
    const waitMs = Math.max(
      0,
      Math.min(
        GITHUB_REPO_EVENT_MAX_WAIT_MS,
        typeof waitMsRaw === 'number' && Number.isSafeInteger(waitMsRaw) ? waitMsRaw : 0,
      ),
    );

    const cacheKey = `${tenant.community}:${roomId}:${pubkey}`;
    const cachedAuthority = roomAuthorityCache.get(cacheKey);
    const authority =
      cachedAuthority && cachedAuthority.expiresAt > authNow.getTime()
        ? {
            authorized: true as const,
            authorizedBy: cachedAuthority.authorizedBy,
            ...(cachedAuthority.currentAuthorizedBy
              ? { currentAuthorizedBy: cachedAuthority.currentAuthorizedBy }
              : {}),
            fullName: cachedAuthority.fullName,
            ...(cachedAuthority.githubInstallationId !== undefined
              ? { githubInstallationId: cachedAuthority.githubInstallationId }
              : {}),
          }
        : await options.authorizeGitHubRoomToken(tenant, {
            agentPubkey: pubkey,
            roomId,
            relayAuthorizations,
          });
    if (!authority.authorized) {
      roomAuthorityCache.delete(cacheKey);
      request.log.warn(
        { authorityReason: authority.reason, roomId, agentPubkey: pubkey },
        'GitHub Room events authority refused request',
      );
      if (authority.reason === 'agent_not_room_member') {
        throw new ProtocolError(
          403,
          'room_membership_required',
          'agent is not a member of this Room',
        );
      }
      throw new ProtocolError(
        403,
        authority.reason === 'tenant_room_community_mismatch'
          ? 'room_repository_unauthorized'
          : 'room_repository_unresolvable',
        'agent is not authorized for this Room repository',
      );
    }
    roomAuthorityCache.set(cacheKey, {
      authorizedBy: authority.authorizedBy,
      ...(authority.currentAuthorizedBy
        ? { currentAuthorizedBy: authority.currentAuthorizedBy }
        : {}),
      fullName: authority.fullName,
      ...(authority.githubInstallationId !== undefined
        ? { githubInstallationId: authority.githubInstallationId }
        : {}),
      expiresAt: authNow.getTime() + GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS,
    });

    // Webhooks store events under the repository's CURRENT full_name; a Room
    // bound before a transfer/rename asks with the old one. Resolve
    // best-effort so the read uses the current address; an unresolvable name
    // just reads (and finds nothing) under the bound name as before.
    let eventsFullName = authority.fullName;
    try {
      const resolved = await resolveGitHubRepositoryAccess(
        { app: options.github!.app, store: options.store },
        tenant.community,
        authority.currentAuthorizedBy ?? authority.authorizedBy,
        authority.fullName,
        authNow,
      );
      if (resolved.resolvedFullName) eventsFullName = resolved.resolvedFullName;
    } catch (error) {
      request.log.warn({ err: error, roomId }, 'Room repository rename resolution failed');
    }

    let events =
      since === undefined
        ? []
        : await options.store.githubRepoEvents(
            eventsFullName,
            since,
            GITHUB_REPO_EVENT_FETCH_LIMIT,
          );
    if (since !== undefined && events.length === 0 && waitMs > 0) {
      await waitForGitHubRepoEvent(eventsFullName, waitMs);
      events = await options.store.githubRepoEvents(
        eventsFullName,
        since,
        GITHUB_REPO_EVENT_FETCH_LIMIT,
      );
    }
    const head = await options.store.latestGitHubRepoEventId(eventsFullName);
    noStore(reply);
    return reply.send({
      full_name: eventsFullName,
      head,
      cursor: events.length > 0 ? events[events.length - 1]!.id : head,
      events: events.map((eventRecord) => ({
        id: eventRecord.id,
        type: eventRecord.eventType,
        action: eventRecord.action,
        actor: eventRecord.actor,
        summary: eventRecord.summary,
        received_at: eventRecord.receivedAt,
        ...(eventRecord.number !== undefined ? { number: eventRecord.number } : {}),
        ...(eventRecord.title ? { title: eventRecord.title } : {}),
        ...(eventRecord.url ? { url: eventRecord.url } : {}),
      })),
    });
  });

  app.post('/auth/github/webhook', async (request, reply) => {
    if (!options.github?.webhookSecret) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub webhook is not configured');
    }
    const webhookTenant = tenantFor(request);
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (
      !rawBody ||
      !verifyGitHubWebhookSignature(
        options.github.webhookSecret,
        rawBody,
        request.headers['x-hub-signature-256'],
      )
    ) {
      throw new ProtocolError(401, 'invalid_signature', 'invalid GitHub webhook signature');
    }
    const deliveryId = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    if (typeof deliveryId !== 'string' || !deliveryId || typeof event !== 'string') {
      throw new ProtocolError(400, 'invalid_webhook', 'missing GitHub webhook headers');
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub webhook body');
    }
    const body = request.body as Record<string, unknown>;
    const isRepoActivityEvent = GITHUB_REPO_EVENT_TYPES.has(event);
    if (event !== 'installation' && event !== 'installation_repositories' && !isRepoActivityEvent) {
      return reply.code(202).send({ accepted: true, ignored: true });
    }
    if (!(await options.store.claimGitHubWebhookDelivery(deliveryId, now()))) {
      return reply.code(202).send({ accepted: true, duplicate: true });
    }
    if (isRepoActivityEvent) {
      try {
        const record = extractGitHubRepoEvent(event, body);
        if (record) {
          await options.store.saveGitHubRepoEvents([{ ...record, deliveryId }], now());
          wakeGitHubRepoEventWaiters(record.fullName);
        }
      } catch (error) {
        await options.store.releaseGitHubWebhookDelivery(deliveryId);
        throw error;
      }
      return reply.code(202).send({ accepted: true });
    }
    try {
      const installationId = githubInstallationId(body.installation);
      const action = typeof body.action === 'string' ? body.action : '';
      if (event === 'installation') {
        if (action === 'deleted') {
          await options.store.markGitHubInstallationStatus(installationId, 'revoked', now());
        } else if (action === 'suspend') {
          await options.store.markGitHubInstallationStatus(installationId, 'suspended', now());
        } else if (action === 'unsuspend') {
          await options.store.markGitHubInstallationStatus(installationId, 'active', now());
        }
      } else if (event === 'installation_repositories') {
        const addedRaw = Array.isArray(body.repositories_added) ? body.repositories_added : [];
        const removedRaw = Array.isArray(body.repositories_removed)
          ? body.repositories_removed
          : [];
        const added = addedRaw.map((repository) =>
          githubRepositoryFromPayload(repository, installationId),
        );
        const removedIds = removedRaw.map((repository) => {
          if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
            throw new ProtocolError(400, 'invalid_webhook', 'invalid removed repository payload');
          }
          const id = (repository as Record<string, unknown>).id;
          if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
            throw new ProtocolError(400, 'invalid_webhook', 'invalid removed repository payload');
          }
          return id;
        });
        await options.store.applyGitHubRepositoryChanges(installationId, added, removedIds, now());
        // Repositories just added to an installation complete any pending
        // Room link waiting on them. Inside the delivery's try block: a
        // failure releases the delivery so GitHub redelivers and the
        // idempotent activation re-runs.
        await completeActivatedRoomLinks(
          webhookTenant.community,
          added.map((repository) => repository.fullName),
        );
      }
    } catch (error) {
      await options.store.releaseGitHubWebhookDelivery(deliveryId);
      throw error;
    }
    return reply.code(202).send({ accepted: true });
  });
}
