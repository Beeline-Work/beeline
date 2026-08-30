import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRouteContext } from './server-context.js';
export function registerServerGithubInstallationRoutes(context: AuthRouteContext): void {
  const {
    app,
    options,
    now,
    flowTtlMs,
    isAllowedAppRedirect,
    decryptGitHubToken,
    reconcileGitHubInstallations,
    tenantFor,
    completeGitHubInstallation,
    githubInstallationManageUrl,
    noStore,
    requiredQueryString,
    githubInstallationId,
    publicUrl,
    ProtocolError,
    READ_ONLY_ROOM_TOKEN_PERMISSIONS,
    resolveGitHubRepositoryAccess,
    randomToken,
    sha256,
    verifyNip98Header,
  } = context;
  app.post('/auth/github/install/start', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected GitHub installation request');
    }
    const body = request.body as Record<string, unknown>;
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
    const requestedInstallationId = body.installation_id;
    if (!/^[0-9a-f]{64}$/.test(pubkey))
      throw new ProtocolError(400, 'invalid_pubkey', 'invalid public key');
    let redirect: URL;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw new ProtocolError(400, 'invalid_redirect', 'invalid installation redirect');
    }
    const associatedRedirect = `${tenant.origin}/auth/github/mobile-callback`;
    if (
      !isAllowedAppRedirect(redirectUri, associatedRedirect) ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    ) {
      throw new ProtocolError(400, 'invalid_redirect', 'installation redirect is not allowed');
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
    if (!(await options.store.githubSubjectForPubkey(tenant.community, pubkey))) {
      throw new ProtocolError(
        409,
        'github_not_linked',
        'sign in with GitHub before installing the Beeline GitHub App',
      );
    }
    let requestedInstallation:
      Awaited<ReturnType<typeof options.store.githubInstallationForPubkey>> | undefined;
    if (requestedInstallationId !== undefined) {
      if (
        typeof requestedInstallationId !== 'number' ||
        !Number.isSafeInteger(requestedInstallationId) ||
        requestedInstallationId <= 0
      ) {
        throw new ProtocolError(400, 'invalid_installation', 'invalid GitHub installation id');
      }
      requestedInstallation = (
        await options.store.githubInstallationsForPubkey(tenant.community, pubkey)
      ).find(
        (installation) =>
          installation.installationId === requestedInstallationId &&
          installation.status === 'active',
      );
      if (!requestedInstallation) {
        throw new ProtocolError(
          404,
          'installation_not_found',
          'the GitHub installation is not active for this Beeline identity',
        );
      }
    }
    const state = randomToken();
    await options.store.createGitHubInstallFlow(sha256(state), {
      community: tenant.community,
      pubkey,
      redirectUri: redirect.toString(),
      createdAt: authNow,
      expiresAt: new Date(authNow.getTime() + flowTtlMs),
    });
    noStore(reply);
    const authorizationUrl = requestedInstallation
      ? new URL(githubInstallationManageUrl(requestedInstallation))
      : new URL(options.github.app.installationUrl(state));
    authorizationUrl.searchParams.set('state', state);
    return reply.send({ authorization_url: authorizationUrl.toString() });
  });

  app.get('/auth/github/install/callback', completeGitHubInstallation);
  // Backward-compatible aliases for installation links issued before the
  // OAuth callback learned to dispatch installation/update returns itself.
  app.get('/auth/github/installed', completeGitHubInstallation);

  app.get<{ Params: { pubkey: string } }>('/auth/github/repos/:pubkey', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
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
    if (
      !(await options.store.claimNip98Event(
        auth.eventId,
        new Date(authNow.getTime() + 2 * 60_000),
        authNow,
      ))
    ) {
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    }
    let installations = await options.store.githubInstallationsForPubkey(tenant.community, pubkey);
    const query = request.query as Record<string, unknown>;
    // Discovery is not owned by the install callback alone: an installation
    // whose callback failed to persist (or one added while this user had
    // another recorded) is found here by the server itself.
    if (!installations.length || query.refresh === '1') {
      await reconcileGitHubInstallations(tenant.community, pubkey, request.log);
      installations = await options.store.githubInstallationsForPubkey(tenant.community, pubkey);
    }
    if (!installations.length) {
      noStore(reply);
      return reply.send({ installed: false, installations: [], repositories: [] });
    }
    if (query.refresh === '1') {
      await Promise.all(
        installations
          .filter((installation) => installation.status === 'active')
          .map(async (installation) => {
            const repositories = await options.github!.app.listRepositories(
              installation.installationId,
            );
            await options.store.replaceGitHubRepositories(
              tenant.community,
              installation.installationId,
              repositories,
              now(),
            );
          }),
      );
      installations = await options.store.githubInstallationsForPubkey(tenant.community, pubkey);
    }
    const repositories = await options.store.githubRepositoriesForPubkey(tenant.community, pubkey);
    // Set when reconcile's last user-token listing was rejected with 401/403:
    // the stored OAuth credential is dead and the app should re-auth silently.
    const staleSubject = await options.store.githubSubjectForPubkey(tenant.community, pubkey);
    const userTokenStaleAt = staleSubject
      ? await options.store.githubUserTokenStaleAt(tenant.community, staleSubject)
      : null;
    noStore(reply);
    return reply.send({
      installed: true,
      ...(userTokenStaleAt ? { user_token_stale: true } : {}),
      installations: installations.map((installation) => ({
        installationId: installation.installationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        ...(installation.accountAvatarUrl
          ? { accountAvatarUrl: installation.accountAvatarUrl }
          : {}),
        repositorySelection: installation.repositorySelection,
        status: installation.status,
        repositoryCount: installation.repositoryCount,
        manageUrl: githubInstallationManageUrl(installation),
      })),
      repositories,
    });
  });

  app.post<{ Params: { pubkey: string } }>('/auth/github/repos/:pubkey', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    const pubkey = request.params.pubkey;
    const url = publicUrl(tenant, request);
    const auth = verifyNip98Header(request.headers.authorization, url, 'POST', now());
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
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
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_request', 'expected repository creation request');
    }
    const body = request.body as Record<string, unknown>;
    const installationId = body.installation_id;
    const name = body.name;
    const description = body.description;
    const isPrivate = body.private;
    if (
      typeof installationId !== 'number' ||
      !Number.isSafeInteger(installationId) ||
      typeof name !== 'string' ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
      (description !== undefined && typeof description !== 'string') ||
      (isPrivate !== undefined && typeof isPrivate !== 'boolean')
    ) {
      throw new ProtocolError(400, 'invalid_request', 'invalid repository creation request');
    }
    const installation = (
      await options.store.githubInstallationsForPubkey(tenant.community, pubkey)
    ).find(
      (candidate) => candidate.installationId === installationId && candidate.status === 'active',
    );
    if (!installation) {
      throw new ProtocolError(
        404,
        'installation_unavailable',
        'GitHub installation is unavailable',
      );
    }
    let userAccessToken: string | undefined;
    if (installation.accountType === 'User') {
      const subject = await options.store.githubSubjectForPubkey(tenant.community, pubkey);
      const sealed = subject
        ? await options.store.githubUserToken(tenant.community, subject)
        : null;
      if (!sealed) {
        throw new ProtocolError(
          409,
          'github_reauthorization_required',
          'sign in with GitHub again before creating a personal repository',
        );
      }
      userAccessToken = decryptGitHubToken(sealed);
    }
    const repository = await options.github.app.createRepository(
      installationId,
      { login: installation.accountLogin, type: installation.accountType },
      {
        name,
        ...(typeof description === 'string' && description ? { description } : {}),
        ...(typeof isPrivate === 'boolean' ? { private: isPrivate } : {}),
      },
      userAccessToken,
    );
    await options.store.applyGitHubRepositoryChanges(installationId, [repository], [], authNow);
    noStore(reply);
    return reply.code(201).send({ repository });
  });

  app.get<{ Params: { pubkey: string } }>(
    '/auth/github/repo-access/:pubkey',
    async (request, reply) => {
      if (!options.github)
        throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
      const tenant = tenantFor(request);
      const pubkey = request.params.pubkey;
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
      if (
        !(await options.store.claimNip98Event(
          auth.eventId,
          new Date(authNow.getTime() + 120_000),
          authNow,
        ))
      ) {
        throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
      }
      const query = request.query as Record<string, unknown>;
      const fullName = requiredQueryString(query.full_name, 'full_name');
      if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
        throw new ProtocolError(400, 'invalid_repository', 'expected owner/repo');
      }
      // Optional Room context: when the caller is about to bind a Room to this
      // repository, a not-covered answer records the durable pending link so
      // completion is automatic once the repository owner grants access.
      const roomId = typeof query.room_id === 'string' ? query.room_id : '';
      if (roomId.length > 200) {
        throw new ProtocolError(400, 'invalid_request', 'invalid room_id');
      }
      noStore(reply);
      const access = await options.store.githubRepositoryAccess(tenant.community, pubkey, fullName);
      if (!access.accessible && access.reason !== 'revoked') {
        const installUrl = options.github.app.publicInstallUrl;
        if (roomId) {
          try {
            await options.store.recordGitHubRoomLinkRequest(
              tenant.community,
              roomId,
              fullName,
              pubkey,
              now(),
            );
          } catch (error) {
            request.log.warn(
              { err: error, roomId, repository: fullName },
              'Room link request not recorded',
            );
          }
        }
        return reply.send({ ...access, grant_needed: true, install_url: installUrl });
      }
      return reply.send(access);
    },
  );

  app.post('/auth/github/room-token', async (request, reply) => {
    if (!options.github || !options.authorizeGitHubRoomToken) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub repository access is unavailable');
    }
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_request', 'expected Room token request');
    }
    const body = request.body as Record<string, unknown>;
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
    const roomId = typeof body.room_id === 'string' ? body.room_id : '';
    // Read-only variant for agent SESSIONS (a corner fetching a private repo
    // to check currency against origin). The mint below pins GitHub's
    // permissions to read only, so the token cannot push or write on any ref.
    // Absent means the daemon's default mint — unchanged.
    const readOnly = body.read_only;
    if (readOnly !== undefined && typeof readOnly !== 'boolean') {
      throw new ProtocolError(400, 'invalid_request', 'read_only must be a boolean');
    }
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
      throw new ProtocolError(400, 'invalid_request', 'invalid Room token request');
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
    const authority = await options.authorizeGitHubRoomToken(tenant, {
      agentPubkey: pubkey,
      roomId,
      relayAuthorizations,
    });
    if (!authority.authorized) {
      request.log.warn(
        {
          authorityReason: authority.reason,
          roomId,
          agentPubkey: pubkey,
        },
        'GitHub Room token authority refused request',
      );
      if (authority.reason === 'agent_not_room_member') {
        throw new ProtocolError(
          403,
          'room_membership_required',
          'agent is not a member of this Room',
        );
      }
      if (
        authority.reason === 'room_repository_missing' ||
        authority.reason === 'room_repository_remote_malformed'
      ) {
        throw new ProtocolError(
          403,
          'room_repository_unresolvable',
          'Room repository could not be resolved',
        );
      }
      throw new ProtocolError(
        403,
        'room_repository_unauthorized',
        'agent is not authorized for this Room repository',
      );
    }
    // `authority.githubInstallationId` (the Room binding's bind-time pin) is
    // deliberately NOT checked here. It is a hint from when the binding was
    // written, and after a transfer the immutable repository id heals onto
    // whichever ACTIVE installation of the authorizing human currently covers
    // it — usually a different installation id than the pinned one. Demanding
    // equality stranded every Room token behind a permanent refusal when the
    // repository moved to an org whose installation reconcile had just
    // claimed (production, 2026-08). Authority is unchanged: the store only
    // resolves installations recorded for the authorizing pubkey, and the
    // mint below is scoped to the exact healed repository id.
    // Key succession: pubkey-keyed lookups (installation resolution,
    // reconciliation, pending-link recording) run against the binding
    // author's CURRENT key, so a replaced device key keeps full repository
    // authority over bindings its predecessor authored. The daemon also
    // learns the resolved owner key here (`authorized_by`) so merge-approval
    // verification can accept the successor without knowing the ledger.
    const ownerPubkey = authority.currentAuthorizedBy ?? authority.authorizedBy;
    const usable = (candidate: typeof access): boolean =>
      candidate.accessible && !!candidate.installationId && !!candidate.repositoryId;
    let access = await resolveGitHubRepositoryAccess(
      { app: options.github.app, store: options.store },
      tenant.community,
      ownerPubkey,
      authority.fullName,
      now(),
    );
    if (!usable(access)) {
      // A refusal for a repository whose account has NO recorded active
      // installation may be a missed callback, not a missing install — the
      // App can enumerate its own installations server-side. Reconcile once
      // (rate-limited), re-resolve, and only then refuse with the actionable
      // message.
      //
      // When the repository MOVED, its destination is usually unknown at this
      // point: GitHub only honours the rename redirect for viewers an
      // installation already covers, so a transfer to an account whose install
      // was never recorded leaves movedTo empty and the OLD owner's name as
      // the only visible one. Gating reconcile on that old owner's coverage
      // optimizes away the exact healing case — a stale-but-active install on
      // the previous owner then suppresses reconciliation forever while the
      // unrecorded destination install sits undiscovered on GitHub. So an
      // unusable resolution with NO known destination reconciles
      // unconditionally (the enumeration is rate-limited inside); a known
      // destination keeps the owner-coverage check on ITS owner.
      const destinationOwnerUncovered = async (): Promise<boolean> => {
        const owner = access.movedTo?.split('/')[0];
        if (!owner) return false;
        return !(await options.store.githubActiveInstallationCoversAccount(
          tenant.community,
          owner,
        ));
      };
      if (!access.movedTo || (await destinationOwnerUncovered())) {
        await reconcileGitHubInstallations(tenant.community, ownerPubkey, request.log);
        access = await resolveGitHubRepositoryAccess(
          { app: options.github.app, store: options.store },
          tenant.community,
          ownerPubkey,
          authority.fullName,
          now(),
        );
      }
    }
    if (!usable(access)) {
      if (!access.movedTo) {
        // The NEVER-GRANTED case is a pending owner grant, not an error wall:
        // the repository's owner (who may not use Beeline at all) must install
        // the App on their account — only GitHub can grant that, and only the
        // owner can do it. Record the durable pending link so the completion
        // is automatic and announced once the grant lands, and answer with a
        // TYPED refusal carrying the shareable, state-less install URL. This
        // is deliberately distinct from the moved-repository message below.
        const repository = authority.fullName;
        const installUrl = options.github.app.publicInstallUrl;
        try {
          await options.store.recordGitHubRoomLinkRequest(
            tenant.community,
            roomId,
            repository,
            ownerPubkey,
            now(),
          );
        } catch (error) {
          request.log.warn({ err: error, roomId, repository }, 'Room link request not recorded');
        }
        request.log.warn(
          {
            authorityReason: 'owner_grant_needed',
            roomId,
            agentPubkey: pubkey,
            authorizedBy: authority.authorizedBy,
            repository,
          },
          'GitHub Room token authority refused request',
        );
        throw new ProtocolError(
          403,
          'owner_grant_needed',
          `${repository} is waiting for its owner to grant Beeline access. Ask the repository owner to install the Beeline GitHub App: ${installUrl}`,
          { install_url: installUrl, repository },
        );
      }
      request.log.warn(
        {
          authorityReason: 'repository_not_granted',
          repositoryAccessReason: 'moved_not_granted',
          movedTo: access.movedTo,
          roomId,
          agentPubkey: pubkey,
          authorizedBy: authority.authorizedBy,
          repository: authority.fullName,
        },
        'GitHub Room token authority refused request',
      );
      throw new ProtocolError(
        403,
        'repository_not_granted',
        `repository moved to ${access.movedTo}; grant the App access there`,
      );
    }
    const resolvedFullName = access.resolvedFullName ?? authority.fullName;
    if (!access.installationId || !access.repositoryId) {
      // Unreachable behind usable(); keeps the mint below type-narrow.
      throw new ProtocolError(
        403,
        'repository_not_granted',
        'Room repository is not granted to the Beeline GitHub App',
      );
    }
    const installation = await options.github.app.installationToken(access.installationId, {
      repositoryIds: [access.repositoryId],
      ...(readOnly ? { permissions: READ_ONLY_ROOM_TOKEN_PERMISSIONS } : {}),
    });
    noStore(reply);
    return reply.send({
      token: installation.token,
      expires_at: installation.expiresAt,
      installation_id: access.installationId,
      full_name: resolvedFullName,
      // The binding author's current key after succession — the daemon treats
      // an exact-tip approval signed by this key as owner-signed.
      authorized_by: ownerPubkey,
    });
  });

  /**
   * Release stored GitHub repository activity to a daemon serving a Room that
   * owns that repository.
   *
   * This is the outbound-only hop for repository events: webhooks land here
   * (inbound-reachable infrastructure), while Room daemons only ever connect
   * OUT to the relay, so events cannot be pushed to them directly. A daemon
   * long-polls this endpoint per served Room; the response carries the stored
   * events newer than its cursor. Authorization reuses exactly the Room-token
   * authority: the NIP-98 signature proves the agent key, and current relay
   * truth must show that key inside a Room whose admin-authored binding names
   * this repository — the caller never chooses which repository it reads, so
   * private repository activity can only reach Rooms bound to it.
   */
}
