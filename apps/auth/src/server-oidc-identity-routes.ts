import { parseSigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { onboardingCookie } from './onboarding-rollout.js';
import { GITHUB_IDENTITY_AUDIENCE, type GitHubIdentity } from './github.js';
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
  // Telemetry never changes the OAuth result. Only validated, state-bound flows
  // reach callback observations; no codes, tokens or account details are passed.
  const observe = async (input: Parameters<NonNullable<typeof options.onFunnelAuth>>[0]) => {
    try {
      await options.onFunnelAuth?.(input);
    } catch {
      // Sign-in must survive measurement failure.
    }
  };
  const startObservation = async (query: Record<string, unknown>, state: string, provider: 'github' | 'google', issuedAt: Date, recoveryHash?: string | null) => {
    let attemptContext;
    if (typeof query.funnel === 'string' && query.funnel.length <= 1024) {
      try { attemptContext = parseSigninFunnelEvent(JSON.parse(query.funnel)); } catch { /* Invalid context is omitted. */ }
    }
    await observeSigninAttempt({ stage: 'started', flowHash: sha256(state), provider,
      recoveryHash, expiresAt: new Date(issuedAt.getTime() + flowTtlMs), at: issuedAt,
      ...(attemptContext?.event === 'provider_tapped' && attemptContext.provider === provider ? { context: attemptContext } : {}) });
    if (!options.onFunnelAuth || typeof query.funnel !== 'string' || query.funnel.length > 1024) return;
    let context;
    try { context = parseSigninFunnelEvent(JSON.parse(query.funnel)); } catch { return; }
    if (!context || context.event !== 'provider_tapped' || context.provider !== provider) return;
    await observe({ phase: 'start', flowHash: sha256(state), provider, context });
  };
  const callbackObservation = async (state: string, provider: 'github' | 'google', outcome: 'success' | 'cancelled' | 'error', failureCode = 'provider_error') => {
    if (outcome === 'error') await observeSigninAttempt({ stage: 'failed', flowHash: sha256(state), errorCode: failureCode, at: now() });
    return observe({
    phase: 'callback', flowHash: sha256(state), provider, outcome,
    ...(outcome === 'error' ? { errorCode: 'provider_error' as const } : {}),
    });
  };
  app.get('/health', async () => ({ ok: true }));

  /** Public provider discovery; repository cards do not require a linked GitHub account. */
  app.get('/auth/capabilities', async (request, reply) => {
    tenantFor(request);
    noStore(reply);
    return reply.send({ github: Boolean(options.github), oidc: true, google: true,
      repositoryOnboarding: true,
    });
  });

  /** Recover a completed native GitHub flow without trusting OS callback delivery. */
  app.post('/auth/github/completion', async (request, reply) => {
    const tenant = tenantFor(request);
    const body = request.body as Record<string, unknown>;
    if (typeof body.recoveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryToken)) {
      throw new ProtocolError(400, 'invalid_recovery', 'GitHub recovery token is invalid');
    }
    const ticket = await options.store.findTicket(sha256(body.recoveryToken));
    noStore(reply);
    // Missing and not-yet-completed tokens are deliberately indistinguishable.
    if (!ticket) return reply.code(202).send({ status: 'pending' });
    if (ticket.community !== tenant.community || ticket.issuer !== 'https://github.com') {
      return reply.code(202).send({ status: 'pending' });
    }
    if (ticket.consumedAt || ticket.expiresAt.getTime() < now().getTime()) {
      return reply.code(410).send({ error: 'github_completion_expired' });
    }
    return reply.send({
      protocol: 1,
      kind: OIDC_BIND_KIND,
      marker: OIDC_BIND_MARKER,
      ticket: body.recoveryToken,
      challenge: ticket.challenge,
      provider: ticket.issuer,
      audience: ticket.audience,
      subject: ticket.subject,
      community: ticket.community,
      issued_at: Math.floor(ticket.createdAt.getTime() / 1_000),
      expires_at: Math.floor(ticket.expiresAt.getTime() / 1_000),
    });
  });

  app.post('/auth/github/completion/cancel', async (request, reply) => {
    tenantFor(request);
    const body = request.body as Record<string, unknown>;
    if (typeof body.recoveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryToken)) {
      throw new ProtocolError(400, 'invalid_recovery', 'GitHub recovery token is invalid');
    }
    await options.store.cancelRecoveryTicket(sha256(body.recoveryToken), now());
    await observeSigninAttempt({ stage: 'cancelled', ticketHash: sha256(body.recoveryToken), at: now() });
    noStore(reply);
    return reply.code(204).send();
  });

  /** Recover a completed native Google flow without trusting OS callback delivery. */
  app.post('/auth/oidc/completion', async (request, reply) => {
    const tenant = tenantFor(request);
    const body = request.body as Record<string, unknown>;
    if (typeof body.recoveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryToken)) {
      throw new ProtocolError(400, 'invalid_recovery', 'Google recovery token is invalid');
    }
    const ticket = await options.store.findTicket(sha256(body.recoveryToken));
    noStore(reply);
    // Missing and not-yet-completed tokens are deliberately indistinguishable.
    if (!ticket) return reply.code(202).send({ status: 'pending' });
    if (ticket.community !== tenant.community || ticket.issuer !== 'https://accounts.google.com') {
      return reply.code(202).send({ status: 'pending' });
    }
    if (ticket.consumedAt || ticket.expiresAt.getTime() < now().getTime()) {
      return reply.code(410).send({ error: 'google_completion_expired' });
    }
    return reply.send({
      protocol: 1,
      kind: OIDC_BIND_KIND,
      marker: OIDC_BIND_MARKER,
      ticket: body.recoveryToken,
      challenge: ticket.challenge,
      provider: ticket.issuer,
      audience: ticket.audience,
      subject: ticket.subject,
      community: ticket.community,
      issued_at: Math.floor(ticket.createdAt.getTime() / 1_000),
      expires_at: Math.floor(ticket.expiresAt.getTime() / 1_000),
    });
  });

  app.post('/auth/oidc/completion/cancel', async (request, reply) => {
    tenantFor(request);
    const body = request.body as Record<string, unknown>;
    if (typeof body.recoveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryToken)) {
      throw new ProtocolError(400, 'invalid_recovery', 'Google recovery token is invalid');
    }
    await options.store.cancelRecoveryTicket(sha256(body.recoveryToken), now());
    await observeSigninAttempt({ stage: 'cancelled', ticketHash: sha256(body.recoveryToken), at: now() });
    noStore(reply);
    return reply.code(204).send();
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
    await observeSigninAttempt({ stage: 'ticket_exchanged', ticketHash: sha256(body.ticket), at: now() });
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

  // Credential Manager binds a Google ID token to a server nonce and the same
  // app-held recovery secret used by browser sign-in. It never issues a session
  // directly; exchange/link still consume the existing one-use bind ticket.
  app.post('/auth/oidc/native/start', async (request, reply) => {
    const tenant = tenantFor(request);
    if (options.oidc.config.issuer !== 'https://accounts.google.com' || !options.oidc.config.androidClientIds?.length)
      throw new ProtocolError(503, 'native_google_unavailable', 'Android Google sign-in is not configured');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.recoveryChallenge !== 'string' || !/^[0-9a-f]{64}$/.test(body.recoveryChallenge))
      throw new ProtocolError(400, 'invalid_request', 'Invalid Google recovery challenge');
    const state = randomToken();
    const nonce = randomToken();
    const issuedAt = now();
    await options.store.createFlow(sha256(state), {
      community: tenant.community, issuer: options.oidc.config.issuer,
      audience: options.oidc.config.clientId, nonce, pkceVerifier: '',
      browserSessionHash: body.recoveryChallenge,
      redirectUri: `${tenant.origin}/auth/oidc/native/complete`,
      appRedirectUri: null, appState: null, appRecoveryHash: body.recoveryChallenge,
      createdAt: issuedAt, expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    await startObservation(body, state, 'google', issuedAt, body.recoveryChallenge);
    noStore(reply);
    return reply.send({ state, nonce, serverClientId: options.oidc.config.clientId });
  });

  app.post('/auth/oidc/native/complete', async (request, reply) => {
    const tenant = tenantFor(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.state) ||
        typeof body.recoveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryToken) ||
        typeof body.idToken !== 'string' || body.idToken.length > 32_768)
      throw new ProtocolError(400, 'invalid_request', 'Invalid native Google completion');
    const flow = await options.store.consumeFlow(sha256(body.state), sha256(body.recoveryToken), now());
    if (!flow || flow.community !== tenant.community ||
        flow.issuer !== 'https://accounts.google.com' ||
        flow.audience !== options.oidc.config.clientId ||
        flow.redirectUri !== `${tenant.origin}/auth/oidc/native/complete`)
      throw new ProtocolError(400, 'invalid_oidc_flow', 'Native Google flow is missing or expired');
    await observeSigninAttempt({ stage: 'provider_returned', flowHash: sha256(body.state), at: now() });
    let identity;
    try {
      identity = await options.oidc.verifyIdToken(body.idToken, flow.nonce, true);
    } catch {
      await callbackObservation(body.state, 'google', 'error', 'invalid_oidc_proof');
      throw new ProtocolError(401, 'invalid_oidc_proof', 'Google ID token validation failed');
    }
    await callbackObservation(body.state, 'google', 'success');
    return issueBindChallenge(tenant, flow, {
      ...identity, displayName: identity.name, login: identity.email, avatar: identity.picture,
    }, reply, true);
  });

  app.get('/auth/oidc/start', async (request, reply) => {
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const appRedirect = query.app_redirect;
    const appState = query.app_state;
    const appRecoveryChallenge = query.app_recovery_challenge;
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
        !isAllowedAppRedirect(appRedirect, associatedRedirect, '/beeline/google-callback')
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
    if (
      appRecoveryChallenge !== undefined &&
      (!appRedirectUri ||
        typeof appRecoveryChallenge !== 'string' ||
        !/^[0-9a-f]{64}$/.test(appRecoveryChallenge))
    ) {
      throw new ProtocolError(400, 'invalid_request', 'native recovery challenge is invalid');
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
      appRecoveryHash: typeof appRecoveryChallenge === 'string' ? appRecoveryChallenge : null,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    await startObservation(query,state,'google', issuedAt, typeof appRecoveryChallenge === 'string' ? appRecoveryChallenge : null);
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
    const appRecoveryChallenge = query.app_recovery_challenge;
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
    let appRecoveryHash: string | null = null;
    if (appRedirect !== undefined && appState !== undefined) {
      const associatedRedirect = `${tenant.origin}/auth/github/mobile-callback`;
      if (
        typeof appRedirect !== 'string' ||
        !isAllowedAppRedirect(appRedirect, associatedRedirect, '/beeline/github-callback')
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
      if (appRecoveryChallenge !== undefined) {
        if (
          typeof appRecoveryChallenge !== 'string' ||
          !/^[0-9a-f]{64}$/.test(appRecoveryChallenge)
        ) {
          throw new ProtocolError(400, 'invalid_request', 'native recovery challenge is invalid');
        }
        appRecoveryHash = appRecoveryChallenge;
      }
    } else if (appRecoveryChallenge !== undefined) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'native recovery requires an app redirect and state',
      );
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
    // Identify first: a prior browser cookie does not prove current installation coverage.
    const issuedAt = now();
    const state = randomToken();
    const verifier = randomToken();
    const browserSession = randomToken();
    const codeChallenge = Buffer.from(sha256Bytes(verifier)).toString('base64url');
    const redirectUri = `${tenant.origin}/auth/github/callback`;
    await options.store.createFlow(sha256(state), {
      community: tenant.community,
      issuer: 'https://github.com',
      audience: GITHUB_IDENTITY_AUDIENCE,
      nonce: query.onboarding === '1' && appRedirectUri ? 'onboarding_probe' : randomToken(),
      pkceVerifier: verifier,
      browserSessionHash: sha256(browserSession),
      redirectUri,
      appRedirectUri,
      appState: boundAppState,
      deviceCodeHash,
      appRecoveryHash,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    await startObservation(query,state,'github', issuedAt, appRecoveryHash);
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
    if (typeof query.state === 'string' && (query.state.startsWith('github_bind_') || query.state.startsWith('repository_install_'))) {
      const installationId = query.installation_id === undefined ? undefined : Number(query.installation_id);
      if ((query.error && !query.state.startsWith('github_bind_')) || (installationId !== undefined && (!Number.isSafeInteger(installationId) || installationId <= 0)) ||
          !options.completeRepositoryInstallation) {
        throw new ProtocolError(400, 'invalid_installation_flow', 'GitHub installation did not complete');
      }
      // The monolith verifies access with the flow owner's stored GitHub user grant,
      // locks and consumes the state, and supplies the previously validated return URI.
      const location = await options.completeRepositoryInstallation(query.state, installationId, typeof query.code === 'string' ? query.code : undefined, `${tenantFor(request).origin}/auth/github/callback`);
      noStore(reply);
      return reply.redirect(location, 302);
    }
    // Request-user-authorization-on-install makes this the GitHub App's only
    // post-install callback too. Repository selection updates carry the
    // installation id/setup action instead of an ordinary sign-in code.
    if ((query.installation_id !== undefined || query.setup_action !== undefined) &&
        !(typeof query.state === 'string' && query.state.startsWith('onboarding_'))) {
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
      flow.audience !== GITHUB_IDENTITY_AUDIENCE ||
      flow.redirectUri !== `${tenant.origin}/auth/github/callback`
    ) {
      throw new ProtocolError(400, 'invalid_oauth_flow', 'GitHub flow tenant or provider mismatch');
    }
    await observeSigninAttempt({ stage: 'provider_returned', flowHash: sha256(state), at: now(),
      ...(typeof query.error === 'string' ? { errorCode: query.error } : {}) });
    if (typeof query.error === 'string') {
      await callbackObservation(state,'github','cancelled');
      const completion = nativeCompletion(flow, {
        error: 'github_denied',
        message: 'GitHub authorization was canceled or denied',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'github_denied', 'GitHub denied the authorization request');
    }
    if (state.startsWith('onboarding_') && typeof query.code !== 'string') {
      const completion = nativeCompletion(flow, { error: 'github_installation_required',
        message: 'GitHub did not finish authorizing the installation. Return and try again.' });
      if (completion) return deliverNativeCompletion(reply, completion);
    }
    if(typeof query.code !== 'string') await callbackObservation(state,'github','error','missing_provider_code');
    const code = requiredQueryString(query.code, 'code');
    let identity: GitHubIdentity;
    try {
      identity = await options.github.oauth.exchangeCode(code, flow.redirectUri, flow.pkceVerifier || undefined);
    } catch {
      await callbackObservation(state,'github','error','invalid_github_proof');
      const completion = nativeCompletion(flow, {
        error: 'invalid_github_proof',
        message: 'GitHub authorization expired or could not be verified',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'invalid_github_proof', 'GitHub code exchange failed');
    }
    await callbackObservation(state,'github','success');
    if (flow.nonce.startsWith('onboarding_user:') && flow.nonce !== `onboarding_user:${identity.subject}`)
      throw new ProtocolError(403, 'onboarding_account_mismatch', 'Use the GitHub account that started this installation');
    const existing = reply.getHeader('set-cookie');
    reply.header('set-cookie', [
      ...(Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : []),
      `beeline_onboarding=${onboardingCookie(identity.subject, options.github.oauth.config.clientSecret, now().getTime())}; Path=/; Max-Age=86400;${cookieSecurity} HttpOnly; SameSite=Lax`,
    ]);
    await options.store.saveGitHubUserToken(
      tenant.community,
      identity.subject,
      encryptGitHubToken(identity.accessToken),
      now(),
      {
        encryptedRefreshToken: identity.refreshToken
          ? encryptGitHubToken(identity.refreshToken)
          : undefined,
        expiresAt: identity.tokenExpiresIn
          ? new Date(now().getTime() + identity.tokenExpiresIn * 1000)
          : undefined,
      },
    );
    if (flow.nonce === 'onboarding_probe') {
      let accounts: Awaited<ReturnType<typeof options.github.app.installationAccount>>[];
      let installed = false;
      try {
        const ids = await options.github.app.listUserInstallationIds(identity.accessToken);
        accounts = await Promise.all(ids.map(id => options.github!.app.installationAccount(id)));
        installed = (await Promise.all(accounts.map(account => account.type === 'User'
          ? Promise.resolve(account.id === identity.subject)
          : options.github!.app.organizationAdmin(identity.accessToken, account.login)))).some(Boolean);
      } catch {
        await observeSigninAttempt({ stage: 'failed', flowHash: sha256(state), errorCode: 'github_installation_unavailable', at: now() });
        const completion = nativeCompletion(flow, { error: 'github_installation_unavailable', message: 'GitHub could not verify your installation. Please try again.' });
        if (completion) return deliverNativeCompletion(reply, completion);
        throw new ProtocolError(503, 'github_installation_unavailable', 'GitHub installation verification failed');
      }
      if (!installed) {
        const installState = `onboarding_${randomToken()}`;
        await options.store.continueFlow(sha256(state), sha256(installState), {
          ...flow, nonce: `onboarding_user:${identity.subject}`, pkceVerifier: '',
          createdAt: now(), expiresAt: new Date(now().getTime() + flowTtlMs),
        });
        await observeSigninAttempt({ stage: 'continued', flowHash: sha256(state),
          nextFlowHash: sha256(installState), expiresAt: new Date(now().getTime() + flowTtlMs), at: now() });
        const headers = reply.getHeader('set-cookie');
        reply.header('set-cookie', [
          ...(Array.isArray(headers) ? headers.map(String) : headers ? [String(headers)] : []),
          `${flowCookieName}=${browserSession}; Path=/; Max-Age=${Math.floor(flowTtlMs / 1000)};${cookieSecurity} HttpOnly; SameSite=Lax`,
        ]);
        noStore(reply);
        const href = options.github.app.installationUrl(installState).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        return reply.type('text/html; charset=utf-8').send(githubInstallReturnPage(
          'Connect your GitHub repositories',
          `<p>Install Beeline on your personal account with All repositories so it can work on repositories you create later.</p><p><a href="${href}">Continue with GitHub</a></p>`,
        ));
      }
    }
    if (state.startsWith('onboarding_')) {
      // Never trust installation_id from the redirect as proof of repository access.
      let accounts: Awaited<ReturnType<typeof options.github.app.installationAccount>>[];
      try {
        const ids = await options.github.app.listUserInstallationIds(identity.accessToken);
        accounts = await Promise.all(ids.map(id => options.github!.app.installationAccount(id)));
      } catch {
        await observeSigninAttempt({ stage: 'failed', flowHash: sha256(state), errorCode: 'github_installation_unavailable', at: now() });
        const completion = nativeCompletion(flow, { error: 'github_installation_unavailable',
          message: 'GitHub could not verify your installation. Please try again.' });
        if (completion) return deliverNativeCompletion(reply, completion);
        throw new ProtocolError(503, 'github_installation_unavailable', 'GitHub installation verification failed');
      }
      const installed = accounts.some(account => account.type === 'User' && account.login.toLowerCase() === identity.login.toLowerCase() && account.repositorySelection === 'all');
      const clearing = reply.getHeader('set-cookie');
      reply.header('set-cookie', [
        ...(Array.isArray(clearing) ? clearing.map(String) : clearing ? [String(clearing)] : []),
        `beeline_github_installed=${installed ? '1' : ''}; Path=/; Max-Age=${installed ? 31_536_000 : 0};${cookieSecurity} HttpOnly; SameSite=Lax`,
      ]);
      if (!installed) {
        await observeSigninAttempt({ stage: 'failed', flowHash: sha256(state), errorCode: 'github_installation_required', at: now() });
        const completion = nativeCompletion(flow, { error: 'github_installation_required',
          message: 'Install Beeline on your personal account with All repositories, then try again.' });
        if (completion) return deliverNativeCompletion(reply, completion);
        throw new ProtocolError(409, 'github_installation_required', 'Personal All repositories installation is required');
      }
    }
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
    await observeSigninAttempt({ stage: 'provider_returned', flowHash: sha256(state), at: now(),
      ...(typeof query.error === 'string' ? { errorCode: query.error } : {}) });
    if (typeof query.error === 'string') {
      await callbackObservation(state,'google','cancelled');
      const completion = nativeCompletion(flow, {
        error: 'oidc_denied',
        message: 'Google authorization was canceled or denied',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'oidc_denied', 'OIDC provider denied the authorization request');
    }
    if(typeof query.code !== 'string') await callbackObservation(state,'google','error','missing_provider_code');
    const code = requiredQueryString(query.code, 'code');

    let identity;
    try {
      const idToken = await options.oidc.exchangeCode(code, flow.pkceVerifier, flow.redirectUri);
      identity = await options.oidc.verifyIdToken(idToken, flow.nonce);
    } catch {
      await callbackObservation(state,'google','error','invalid_oidc_proof');
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

    await callbackObservation(state,'google','success');
    return issueBindChallenge(
      tenant,
      flow, {
        ...identity,
        displayName: identity.name,
        login: identity.email,
        avatar: identity.picture,
    },
      reply,
    );
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
