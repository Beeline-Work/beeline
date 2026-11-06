import type { SigninAttemptObservation } from '@beeline/api-contract/signin-funnel';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AuthStore, type ManagedIdentity } from './store.js';
import { GITHUB_IDENTITY_AUDIENCE, type GitHubOrganizationMembership } from './github.js';
import { appSetupEnvBlock, buildAppManifest, checkGitHubAppDriftBestEffort, convertAppManifestCode, setupTokenMatches } from './github-manifest.js';
import { extractGitHubRepoEvent } from './github-repo-events.js';
import { resolveGitHubRepositoryAccess } from './github-repository-access.js';
import { isGitHubHandle, normalizeHost, OIDC_BIND_KIND, OIDC_BIND_MARKER, randomToken, sha256, verifyBindEvent, verifyNip98Header } from './protocol.js';
import { AuthServerOptions, DEFAULT_FLOW_TTL_MS, DEFAULT_TICKET_TTL_MS, GITHUB_SIGN_IN_DEEP_LINK, GITHUB_INSTALLATION_DEEP_LINK, LEGACY_GITHUB_SIGN_IN_DEEP_LINK, LEGACY_GITHUB_INSTALLATION_DEEP_LINK, exactRedirect, FLOW_COOKIE, AuthTenant, GITHUB_INSTALLATION_RECONCILE_INTERVAL_MS, isGitHubUserTokenAuthError, ProtocolError, githubInstallationId, noStore, githubInstallPendingPage, githubInstallConnectedPage, requiredQueryString, githubInstallErrorPage, githubInstallationManageUrl, managedIdentityJson, nativeReturnPage, githubInstallReturnPage, githubAppSetupFormPage, githubAppSetupEnvPage, githubAppSetupErrorPage, githubRepositoryFromPayload, verifyGitHubWebhookSignature, flowCookie, publicUrl, GITHUB_REPO_EVENT_TYPES, GITHUB_REPO_EVENT_FETCH_LIMIT, GITHUB_REPO_EVENT_MAX_WAIT_MS, GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS, sha256Bytes } from './server-context.js';



export function createAuthRouteContext(options: AuthServerOptions) {
  const observeSigninAttempt = async (input: SigninAttemptObservation) => {
    try { await options.onSigninAttempt?.(input); }
    catch { /* The consumer reports failures; telemetry never changes sign-in. */ }
  };
  const now = options.now ?? (() => new Date());
  const flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS;
  const ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  const nativeRedirectUris = new Set([
    GITHUB_SIGN_IN_DEEP_LINK,
    GITHUB_INSTALLATION_DEEP_LINK,
    'beeline://beeline/google-callback',
    LEGACY_GITHUB_SIGN_IN_DEEP_LINK,
    LEGACY_GITHUB_INSTALLATION_DEEP_LINK,
    ...(options.nativeRedirectUris ?? []),
  ]);
  const isAllowedAppRedirect = (
    value: string,
    associatedRedirect: string,
    webPath?: string,
  ): boolean =>
    exactRedirect(value, associatedRedirect) ||
    [...nativeRedirectUris].some((redirect) => exactRedirect(value, redirect)) ||
    Boolean(
      webPath &&
      options.webAppOrigins?.some((origin) => exactRedirect(value, `${origin}${webPath}`)),
    );
  const cookieSecurity = options.secureCookies === false ? '' : ' Secure;';
  const flowCookieName = options.secureCookies === false ? 'beeline_oidc_flow' : FLOW_COOKIE;
  const githubTokenKey = options.github
    ? createHash('sha256').update(options.github.oauth.config.clientSecret).digest()
    : undefined;
  const encryptGitHubToken = (token: string): string => {
    if (!githubTokenKey) throw new Error('GitHub token encryption is unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', githubTokenKey, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.');
  };
  const decryptGitHubToken = (sealed: string): string => {
    if (!githubTokenKey) throw new Error('GitHub token encryption is unavailable');
    const parts = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16) {
      throw new Error('stored GitHub token is invalid');
    }
    const decipher = createDecipheriv('aes-256-gcm', githubTokenKey, parts[0]!);
    decipher.setAuthTag(parts[1]!);
    return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8');
  };
  type AgentConnectIdentity = {
    issuer: string;
    audience: string;
    subject: string;
  };
  let agentConnectApproval: (
    tenant: AuthTenant,
    flow: import('./store.js').OidcFlow,
    identity: AgentConnectIdentity,
  ) => Promise<boolean> = async () => false;
  const completeAgentConnectApproval = (
    tenant: AuthTenant,
    flow: import('./store.js').OidcFlow,
    identity: AgentConnectIdentity,
  ) => agentConnectApproval(tenant, flow, identity);
  const setAgentConnectApproval = (approval: typeof agentConnectApproval): void => {
    agentConnectApproval = approval;
  };
  const reconcileGitHubInstallations = async (
    community: string,
    pubkey: string,
    log: FastifyRequest['log'],
  ): Promise<void> => {
    try {
      const subject = await options.store.githubSubjectForPubkey(community, pubkey);
      if (!subject) return;
      const sealedUserToken = await options.store.githubUserToken(community, subject);
      if (!sealedUserToken) return;
      const attemptedAt = now();
      if (
        !(await options.store.claimGitHubInstallationReconciliation(
          community,
          subject,
          attemptedAt,
          new Date(attemptedAt.getTime() - GITHUB_INSTALLATION_RECONCILE_INTERVAL_MS),
        ))
      ) {
        return;
      }
      // Enumerate with the APP's own credential: GET /user/installations is
      // keyed to the OAuth lookup token's visibility, and an unscoped token
      // cannot see organization installations — production stranded a real
      // org install behind exactly that blindness. The App JWT sees every
      // installation, so an install whose callback never persisted is
      // discovered here without the owner re-running the install flow.
      const installations = await options.github!.app.listInstallations();
      // One user-token listing answers "which installations does this user
      // administer" for every candidate at once; computed only when a
      // not-yet-recorded installation actually needs the ownership gate.
      let userInstallationIds: Promise<Set<number> | 'unavailable'> | undefined;
      const administeredByUser = async (): Promise<Set<number> | 'unavailable'> => {
        if (!userInstallationIds) {
          userInstallationIds = options
            .github!.app.listUserInstallationIds(decryptGitHubToken(sealedUserToken))
            .then(
              (ids) => {
                // The stored credential demonstrably still works.
                void options.store.clearGitHubUserTokenStale(community, subject).catch(() => {});
                return new Set(ids);
              },
              (error: unknown) => {
                log.warn(
                  { err: error, community, pubkey },
                  'GitHub installation listing unavailable for organization verification',
                );
                if (isGitHubUserTokenAuthError(error)) {
                  // GitHub answered 401/403 for the STORED user token: mark
                  // it stale so the app can offer a silent re-auth next
                  // session. Best-effort — never blocks the reconcile.
                  void options.store
                    .markGitHubUserTokenStale(community, subject, now())
                    .catch(() => {});
                }
                return 'unavailable' as const;
              },
            );
        }
        return userInstallationIds;
      };
      // Second opinion for an organization installation the user listing
      // omits: GET /user/memberships/orgs/{org} speaks for the user's own
      // token and says plainly whether they belong to the account that owns
      // the install.
      const membershipIn = async (login: string): Promise<GitHubOrganizationMembership> => {
        try {
          return await options.github!.app.organizationMembership(
            decryptGitHubToken(sealedUserToken),
            login,
          );
        } catch {
          return 'unknown';
        }
      };
      for (const { installationId, account } of installations) {
        const known = await options.store.githubInstallation(community, installationId);
        if (!known) {
          // A NEWLY discovered installation is only claimed for a user who
          // can administer it. A User-type account is always verifiable, so
          // it demands positive confirmation; an Organization-type account
          // follows the install-callback precedent — GitHub's state-bound
          // redirect is absent here, but an unavailable listing is logged
          // and proceeded with, while a definitive denial refuses.
          //
          // The listing's definitive answer is NOT the last word for an
          // organization: GET /user/installations is keyed to one OAuth
          // token's visibility and omits org installations outright (an org
          // that restricts third-party access, or a member who is not an app
          // manager, both read as a clean absence). Production stranded a
          // real org install on exactly that silence. So an omitted
          // organization gets the membership fallback, which can only ever
          // ADD a claim: 'active' membership claims, and anything else —
          // including GitHub declining to answer — leaves the prior outcome
          // untouched.
          const administered = await administeredByUser();
          const listed = administered !== 'unavailable' && administered.has(installationId);
          if (!listed) {
            if (account.type !== 'Organization') continue;
            // An unavailable listing already claims by precedent; only a
            // definitive omission needs membership to speak.
            if (
              administered !== 'unavailable' &&
              (await membershipIn(account.login)) !== 'active'
            ) {
              continue;
            }
          }
        }
        // An already recorded installation refreshes through the same
        // guarded upsert the callback uses: the store's conflict guard keeps
        // another GitHub account's link untouched and lets a matching
        // subject move the row onto the current pubkey (identity recovery);
        // a refusal there is the honest answer, not an error.
        const repositories = await options.github!.app.listRepositories(installationId);
        await options.store.replaceGitHubInstallationSnapshot(
          {
            community,
            pubkey,
            authorizedSubject: subject,
            accountId: account.id,
            accountLogin: account.login,
            accountType: account.type,
            ...(account.avatarUrl ? { accountAvatarUrl: account.avatarUrl } : {}),
            installationId,
            repositorySelection: account.repositorySelection,
            status: 'active',
            repositoryCount: repositories.length,
          },
          repositories,
          attemptedAt,
        );
        // Reconcile is the backstop that discovers an owner's NEW install
        // without any callback, so it is also a completion path for pending
        // Room links (failures are swallowed by this function's outer catch).
        await completeActivatedRoomLinks(
          community,
          repositories.map((repository) => repository.fullName),
        );
      }
    } catch (error) {
      log.warn({ err: error, community, pubkey }, 'GitHub installation reconciliation failed');
    }
  };
  if (flowTtlMs < 30_000 || flowTtlMs > 10 * 60_000)
    throw new Error('flow TTL is outside safe bounds');
  if (ticketTtlMs < 30_000 || ticketTtlMs > 5 * 60_000)
    throw new Error('ticket TTL is outside safe bounds');

  const tenants = new Map<string, AuthTenant>();
  for (const configured of options.tenants) {
    const host = normalizeHost(configured.host);
    if (!configured.community || configured.community.length > 512)
      throw new Error('invalid tenant community');
    if (
      !Array.isArray(configured.roomCommunityIds) ||
      configured.roomCommunityIds.length === 0 ||
      configured.roomCommunityIds.length > 64 ||
      configured.roomCommunityIds.some(
        (communityId) =>
          typeof communityId !== 'string' || !communityId || communityId.length > 512,
      )
    ) {
      throw new Error('invalid tenant Room community ids');
    }
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
    tenants.set(host, {
      host,
      community: configured.community,
      roomCommunityIds: [...new Set(configured.roomCommunityIds)],
      origin: normalizedOrigin,
    });
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

  // Long-poll waiters for stored repository events, keyed by lowercased
  // full_name. A verified webhook insert wakes every daemon parked on that
  // repository so a Room sees a star/issue/PR within milliseconds of the
  // delivery instead of on the next poll tick.
  const githubRepoEventWaiters = new Map<string, Set<() => void>>();
  const wakeGitHubRepoEventWaiters = (fullName: string): void => {
    const waiters = githubRepoEventWaiters.get(fullName.toLowerCase());
    if (!waiters) return;
    githubRepoEventWaiters.delete(fullName.toLowerCase());
    for (const waiter of waiters) waiter();
  };
  const waitForGitHubRepoEvent = (fullName: string, waitMs: number): Promise<void> => {
    const key = fullName.toLowerCase();
    let waiters = githubRepoEventWaiters.get(key);
    if (!waiters) {
      waiters = new Set();
      githubRepoEventWaiters.set(key, waiters);
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      waiters.add(done);
    });
  };

  // Complete pending Room→repo links whose repository just became covered by
  // an installation (install callback, webhook, or reconcile), and announce
  // each completion into the stored repository-event feed the daemon already
  // long-polls — so the Room card announcing "access granted" rides exactly
  // the path stars and issues ride, with no new delivery mechanism. The
  // deterministic per-link delivery id makes re-announcement impossible: a
  // second activation attempt finds nothing to flip, and a replayed event row
  // conflicts on delivery_id and is dropped.
  const completeActivatedRoomLinks = async (
    community: string,
    fullNames: readonly string[],
  ): Promise<void> => {
    const activated = await options.store.activateGitHubRoomLinks(community, fullNames, now());
    if (activated.length === 0) return;
    await options.store.saveGitHubRepoEvents(
      activated.map((link) => ({
        fullName: link.fullName,
        deliveryId: `room-link-${sha256(`${community}|${link.roomId}|${link.fullName.toLowerCase()}`).slice(0, 32)}`,
        eventType: 'beeline_room_link',
        action: 'granted',
        actor: '',
        summary: `Beeline access granted: ${link.fullName} is now linked.`,
      })),
      now(),
    );
    for (const link of activated) wakeGitHubRepoEventWaiters(link.fullName);
  };

  // A successful Room authority proof costs several authenticated relay reads.
  // Reusing it for a short window keeps a long-polling daemon from re-reading
  // relay state every request; the cache is authorized results only, so a
  // refusal is always re-derived from current truth.
  const roomAuthorityCache = new Map<
    string,
    {
      authorizedBy: string;
      currentAuthorizedBy?: string;
      fullName: string;
      githubInstallationId?: number;
      expiresAt: number;
    }
  >();

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

  const deliverNativeCompletion = (reply: FastifyReply, target: URL) => {
    noStore(reply);
    // ASWebAuthenticationSession and Android's auth-session polyfill finish
    // only when the browser navigates to the registered callback URL. An HTML
    // meta refresh can leave the completion page visible without dispatching
    // the custom scheme back to the installed app.
    return reply.redirect(target.toString(), 302);
  };

  const issueBindChallenge = async (
    tenant: AuthTenant,
    flow: {
      appRedirectUri: string | null;
      appState: string | null;
      appRecoveryHash?: string | null;
      stateHash?: string;
    },
    identity: {
      issuer: string;
      audience: string;
      subject: string;
      login?: string;
      displayName?: string;
      avatar?: string;
    },
    reply: FastifyReply,
    nativeJson = false,
  ) => {
    const audience =
      identity.issuer === 'https://github.com' ? GITHUB_IDENTITY_AUDIENCE : identity.audience;
    const ticket = randomToken();
    const challenge = randomToken();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ticketTtlMs);
    const storedTicket = {
      challenge,
      community: tenant.community,
      issuer: identity.issuer,
      audience,
      subject: identity.subject,
      createdAt: issuedAt,
      expiresAt,
      attemptCount: 0,
      consumedAt: null,
      boundPubkey: null,
      providerLogin: identity.login?.toLowerCase() ?? null,
      providerDisplayName: identity.displayName?.trim() || identity.login || null,
      providerAvatar: identity.avatar ?? null,
    };
    if (flow.appRecoveryHash) {
      const created = await options.store.createRecoveryTicket(
        flow.appRecoveryHash,
        storedTicket,
        issuedAt,
      );
      if (!created) {
        const completion = nativeCompletion(flow, {
          error: 'github_completion_cancelled',
          message: 'GitHub authorization was canceled',
        });
        if (completion) return deliverNativeCompletion(reply, completion);
        throw new ProtocolError(
          410,
          'github_completion_cancelled',
          'GitHub authorization was canceled',
        );
      }
      if (flow.stateHash) await observeSigninAttempt({ stage: 'ticket_issued',
        flowHash: flow.stateHash, ticketHash: flow.appRecoveryHash, expiresAt, at: issuedAt });
      const completion = nativeCompletion(flow, { completed: 1 });
      if (nativeJson) {
        noStore(reply);
        return reply.send({ completed: true });
      }
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(400, 'invalid_oauth_flow', 'Native recovery flow has no redirect');
    }
    await options.store.createTicket(sha256(ticket), storedTicket);
    if (flow.stateHash) await observeSigninAttempt({ stage: 'ticket_issued',
      flowHash: flow.stateHash, ticketHash: sha256(ticket), expiresAt, at: issuedAt });
    noStore(reply);
    const bindChallenge = {
      protocol: 1,
      kind: OIDC_BIND_KIND,
      marker: OIDC_BIND_MARKER,
      ticket,
      challenge,
      provider: identity.issuer,
      audience,
      subject: identity.subject,
      community: tenant.community,
      issued_at: Math.floor(issuedAt.getTime() / 1_000),
      expires_at: Math.floor(expiresAt.getTime() / 1_000),
    } as const;
    const completion = nativeCompletion(flow, bindChallenge);
    if (completion) return deliverNativeCompletion(reply, completion);
    return reply.send(bindChallenge);
  };

  const provisionManagedIdentity = async (
    ticket: NonNullable<Awaited<ReturnType<AuthStore['findTicket']>>>,
    pubkey: string,
  ): Promise<ManagedIdentity | undefined> => {
    if (ticket.issuer !== 'https://github.com') return undefined;
    const login = ticket.providerLogin?.toLowerCase() ?? '';
    if (!isGitHubHandle(login)) {
      throw new Error('verified GitHub identity is missing a valid login');
    }
    const displayName = ticket.providerDisplayName?.trim().slice(0, 60) || login;
    return options.store.provisionGitHubIdentity(
      ticket.community,
      ticket.subject,
      pubkey,
      login,
      displayName,
      now(),
    );
  };

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProtocolError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
      void reply.status(413).send({ error: 'request_too_large' });
      return;
    }
    // Never a silent 500: log the exception against the request id and give
    // the caller an actionable body. Upstream client errors carry their own
    // plain-language message (e.g. "GitHub user installations failed: HTTP
    // 404") and never contain credentials, so surfacing them — plus the id to
    // correlate with this log line — beats a bare internal_error.
    const reqId = request.id;
    request.log.error({ err: error, reqId }, 'auth request failed unexpectedly');
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim().slice(0, 300)
        : 'the request failed while contacting GitHub or the database';
    void reply.status(500).send({
      error: 'internal_error',
      message: `${detail} (request id ${reqId} — retry; if it persists, search the auth logs for this id)`,
      reqId,
    });
  });

  async function completeGitHubInstallation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    // An organization that requires approval calls back BEFORE an
    // installation exists, with setup_action=request. Spending the flow here
    // would burn the binding: GitHub's real install callback lands later and
    // would read as "already used" although nothing was ever connected. This
    // checkpoint touches no state; the flow stays live for the approval, and
    // it answers even without a state so the person is never told a pending
    // request "connected".
    if (query.setup_action === 'request') {
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply.status(200).type('text/html; charset=utf-8').send(githubInstallPendingPage());
    }
    // Three shapes remain. (a) In-app-initiated: state present and a matching
    // flow exists — complete the binding exactly as before. (b) Stateless/
    // foreign: no state at all — a share-link or marketplace install; answer a
    // friendly landing page and touch nothing. (c) State present but wrong —
    // keep an error, but as a readable page rather than raw JSON.
    if (query.state === undefined) {
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply.status(200).type('text/html; charset=utf-8').send(githubInstallConnectedPage());
    }
    const state = requiredQueryString(query.state, 'state');
    const rawInstallationId = query.installation_id;
    const installationId =
      typeof rawInstallationId === 'string' ? Number(rawInstallationId) : Number.NaN;
    const flowUnavailable = (
      reason: 'expired' | 'used' | 'invalid',
      cause: 'expired' | 'used' | 'missing' | 'other_community',
    ) => {
      // The auth app runs with Fastify's logger off in the monolith, so
      // request.log is silent in production. Record why the return was
      // refused, with presence flags and a short state fingerprint only —
      // never the state or code themselves.
      console.warn(
        '[auth] GitHub installation return rejected',
        JSON.stringify({
          route:
            request.routeOptions.url === '/auth/github/callback'
              ? 'oauth_callback'
              : 'install_callback',
          path: request.routeOptions.url,
          reason: cause,
          installationId: query.installation_id !== undefined,
          code: query.code !== undefined,
          setupAction: typeof query.setup_action === 'string' ? query.setup_action : null,
          stateFingerprint: sha256(state).slice(0, 8),
        }),
      );
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply
        .status(400)
        .type('text/html; charset=utf-8')
        .send(githubInstallErrorPage(reason));
    };
    // GitHub omits installation_id when the install did NOT complete; the
    // documented case is an organization whose install is awaiting an owner's
    // approval (setup_action=request). Treating a missing id as an invalid
    // link was the production bug: a valid seconds-old link rendered "expired
    // or already used" for a person still mid-install. Classify the state so a
    // genuinely dead link still says why, but never spend it here — GitHub's
    // real callback arrives once approval lands.
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      const pending = await options.store.peekGitHubInstallFlow(sha256(state), now());
      if (pending.status !== 'ok') {
        return flowUnavailable(
          pending.status === 'missing' ? 'invalid' : pending.status,
          pending.status,
        );
      }
      if (pending.flow.community !== tenant.community) {
        return flowUnavailable('invalid', 'other_community');
      }
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply.status(200).type('text/html; charset=utf-8').send(githubInstallPendingPage());
    }
    // Completion is atomic and single-use: only an unconsumed, unexpired state
    // can bind an installation, and it can do so exactly once.
    const flow = await options.store.consumeGitHubInstallFlow(sha256(state), now());
    if (!flow || flow.community !== tenant.community) {
      // The state was spent or ran out of time; the row still says which.
      const miss = await options.store.peekGitHubInstallFlow(sha256(state), now());
      return flowUnavailable(
        miss.status === 'expired' || miss.status === 'used' ? miss.status : 'invalid',
        flow ? 'other_community' : miss.status === 'ok' ? 'missing' : miss.status,
      );
    }
    const [linkedAccountId, installedAccount, repositories] = await Promise.all([
      options.store.githubSubjectForPubkey(tenant.community, flow.pubkey),
      options.github.app.installationAccount(installationId),
      options.github.app.listRepositories(installationId),
    ]);
    if (!linkedAccountId) {
      throw new ProtocolError(
        403,
        'github_not_linked',
        'sign in with GitHub before installing the Beeline GitHub App',
      );
    }
    const sealedUserToken = await options.store.githubUserToken(tenant.community, linkedAccountId);
    if (!sealedUserToken) {
      throw new ProtocolError(
        403,
        'installation_account_mismatch',
        'the signed-in GitHub user cannot administer this installation',
      );
    }
    // GET /user/installations is keyed to the OAuth lookup token's visibility:
    // user-owned installations always appear, but an unscoped OAuth token
    // generally cannot list ORGANIZATION installations, so demanding a
    // positive match here strands every org install behind an exception or a
    // false negative. For an Organization target, GitHub's state-bound
    // redirect — only the installing admin's browser receives it, bound to
    // this flow's one-time state — is the authority; the listing still refuses
    // when it definitively denies access, and its failures are logged rather
    // than fatal.
    let userCanAdminister: boolean | undefined;
    try {
      userCanAdminister = await options.github.app.userCanAccessInstallation(
        decryptGitHubToken(sealedUserToken),
        installationId,
      );
    } catch (error) {
      if (installedAccount.type !== 'Organization') throw error;
      request.log.warn(
        { err: error, installationId },
        'GitHub installation listing unavailable for organization verification',
      );
    }
    const accessConfirmed =
      installedAccount.type === 'User' ? userCanAdminister === true : userCanAdminister !== false;
    if (!accessConfirmed) {
      throw new ProtocolError(
        403,
        'installation_account_mismatch',
        'the signed-in GitHub user cannot administer this installation',
      );
    }
    const installationSaved = await options.store.saveGitHubInstallation(
      {
        community: tenant.community,
        pubkey: flow.pubkey,
        authorizedSubject: linkedAccountId,
        accountId: installedAccount.id,
        accountLogin: installedAccount.login,
        accountType: installedAccount.type,
        ...(installedAccount.avatarUrl ? { accountAvatarUrl: installedAccount.avatarUrl } : {}),
        installationId,
        repositorySelection: installedAccount.repositorySelection,
        status: 'active',
        repositoryCount: repositories.length,
      },
      now(),
    );
    if (!installationSaved) {
      throw new ProtocolError(
        409,
        'installation_account_mismatch',
        'the GitHub installation is already linked through another GitHub account',
      );
    }
    await options.store.replaceGitHubRepositories(
      tenant.community,
      installationId,
      repositories,
      now(),
    );
    // A pending Room link for one of these repositories may now be grantable —
    // best-effort: the callback must not fail AFTER a successful save, and any
    // later webhook/reconcile completes it instead.
    try {
      await completeActivatedRoomLinks(
        tenant.community,
        repositories.map((repository) => repository.fullName),
      );
    } catch (error) {
      request.log.warn({ err: error, installationId }, 'Room link completion check failed');
    }
    const completion = new URL(flow.redirectUri);
    completion.searchParams.set('installed', '1');
    return reply.redirect(completion.toString(), 302);
  }

  return {
    app,
    options,
    now,
    flowTtlMs,
    ticketTtlMs,
    isAllowedAppRedirect,
    cookieSecurity,
    flowCookieName,
    encryptGitHubToken,
    decryptGitHubToken,
    completeAgentConnectApproval,
    setAgentConnectApproval,
    reconcileGitHubInstallations,
    tenantFor,
    wakeGitHubRepoEventWaiters,
    waitForGitHubRepoEvent,
    completeActivatedRoomLinks,
    roomAuthorityCache,
    nativeCompletion,
    deliverNativeCompletion,
    issueBindChallenge,
    observeSigninAttempt,
    provisionManagedIdentity,
    completeGitHubInstallation,
    githubInstallationManageUrl,
    noStore,
    managedIdentityJson,
    nativeReturnPage,
    githubInstallReturnPage,
    githubInstallConnectedPage,
    githubInstallErrorPage,
    githubAppSetupFormPage,
    githubAppSetupEnvPage,
    githubAppSetupErrorPage,
    requiredQueryString,
    githubRepositoryFromPayload,
    githubInstallationId,
    verifyGitHubWebhookSignature,
    flowCookie,
    publicUrl,
    ProtocolError,
    GITHUB_REPO_EVENT_TYPES,
    GITHUB_REPO_EVENT_FETCH_LIMIT,
    GITHUB_REPO_EVENT_MAX_WAIT_MS,
    GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS,
    GITHUB_SIGN_IN_DEEP_LINK,
    GITHUB_INSTALLATION_DEEP_LINK,
    sha256Bytes,
    extractGitHubRepoEvent,
    resolveGitHubRepositoryAccess,
    appSetupEnvBlock,
    buildAppManifest,
    checkGitHubAppDriftBestEffort,
    convertAppManifestCode,
    setupTokenMatches,
    isGitHubHandle,
    OIDC_BIND_KIND,
    OIDC_BIND_MARKER,
    randomToken,
    sha256,
    verifyBindEvent,
    verifyNip98Header,
  };
}
