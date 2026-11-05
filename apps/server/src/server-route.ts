let webhookWritesSincePrune = 0;
import { routeAuthenticated } from './server-authenticated-routes.js';
import { syncXAdReports } from './x-ad-reports.js';
import { syncXSiteVisits } from './x-site-visits.js';
import { dashboardFinances } from './operator-finances.js';
import { serveEmailImage } from './email-images.js';
import { parseMobileMinimum } from '@beeline/api-contract/mobile-minimum';
import { readMobileMinimums, writeMobileMinimum } from './mobile-minimum.js';
import { parseSiteDownloadTap, recordSiteDownloadTap } from './site-download-taps.js';
import { ingestScreenReport, parseScreenReport } from './x-ad-screen.js';
import { parseSigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { recordSigninFunnelEvent } from './signin-funnel.js';
import { readCompanyLogo } from './company-logos.js';
import { receiveSentryWake } from './sentry-wake.js';
import { authenticSentryAlert, sendSentryTelegram, sentryTelegramMessage } from './sentry-telegram.js';
import { verifyNip98Header } from '@beeline/nostr';
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { serveComputerSession, serveComputerStatus } from './computer-session.js';
import { handleFreeAgentModelRequest } from './free-agent-model-proxy.js';
import { isAppSignInLink } from './composio-apps.js';
import { ingestComposioDelivery } from './composio-delivery.js';
import { ingestSubscriptionWebhook, WEBHOOK_BODY_LIMIT } from './subscription-webhooks.js';
import { ingestProviderWebhook } from './provider-webhooks.js';
import { ingestWalletWebhook } from './wallet-webhooks.js';
import { GoogleSignInError } from './auth.js';
import { connectorLogo } from './workbench.js';
import { InvitePreviewAccess } from './invite-preview.js';
import { parseDashboardPlatforms, readOperatorDashboard } from './operator-dashboard.js';
import { HelperVersionGate } from './helper-version-gate.js';
import { ServerOptions, exactPath, bytes, MAX_JSON_BYTES, json, body, appSignInWebOrigin, appSignInReturnCookie, bearerSecretMatches, clientKey, publicJson, funnelRateLimit, signatureMatches } from './server.js';
import { PhoneHttpOperation, daemonIdentity, refuseDaemon, phoneIdentity } from './server-create-beeline-server.js';



export async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  invitePreview: InvitePreviewAccess,
  liveHealth: () => object,
  helperVersionGate: HelperVersionGate,
  httpPhoneOperation: PhoneHttpOperation,
): Promise<void> {
  const url = exactPath(request.url);
  const method = request.method ?? 'GET';
  if (await options.roomsMcp?.handle(request, response)) return;
  if (method === 'POST' && url.pathname === '/v1/sentry/webhook') {
    let raw: Buffer;
    try { raw = await bytes(request, MAX_JSON_BYTES); }
    catch { json(response, 413, { error: 'sentry_payload_too_large' }); return; }
    const status = await receiveSentryWake(options.database, raw, request.headers, options.sentryWakeSecret, options.sentryWakeAgentId);
    json(response, status, status < 300 ? { accepted: true } : { error: 'invalid_sentry_webhook' });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/webhooks/sentry') {
    if (!authenticSentryAlert(options.sentryTelegram, url.searchParams.get('token'))) {
      json(response, 401, { error: 'invalid_sentry_webhook' }); return;
    }
    let payload: Record<string, unknown>;
    try { payload = await body(request); }
    catch { json(response, 400, { error: 'invalid_sentry_alert' }); return; }
    const message = sentryTelegramMessage(payload);
    if (!message) { json(response, 400, { error: 'invalid_sentry_alert' }); return; }
    await sendSentryTelegram(options.sentryTelegram!, message);
    json(response, 200, { ok: true }); return;
  }
  if (url.pathname.startsWith('/v1/free-agents/model/')) {
    if (!options.freeAgentModel) json(response, 503, { error: { message: 'free agent model unavailable' } });
    else await handleFreeAgentModelRequest(request, response, url.pathname, options.freeAgentModel);
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/free-agents/bootstrap') {
    const input = await body(request);
    const grant =
      options.freeAgents && typeof input.token === 'string' && input.token.startsWith('bfb_')
        ? await options.freeAgents.bootstrap(input.token)
        : undefined;
    if (!grant) json(response, 401, { error: 'invalid_free_agent_bootstrap' });
    else {
      response.setHeader('cache-control', 'no-store');
      json(response, 200, grant);
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/free-agents/sleep') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    const input = await body(request);
    json(response, 200, options.freeAgents
      ? await options.freeAgents.requestSleep(agentId, { refresh: input.refresh === true })
      : { sleep: false });
    return;
  }
  const computer = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname);
  if (method === 'GET' && computer) {
    await serveComputerSession(request, response, options.database, options.live, computer[1]!);
    return;
  }
  const computerStatus = /^\/s\/([A-Za-z0-9_-]{43})\/status$/.exec(url.pathname);
  if (method === 'GET' && computerStatus) {
    await serveComputerStatus(request, response, options.database, computerStatus[1]!);
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/link/oauth/callback') {
    if (!options.linkWallet) {
      json(response, 503, { error: 'Link is unavailable' });
      return;
    }
    const state = url.searchParams.get('state');
    if (!state) {
      json(response, 400, { error: 'Link authorization was not completed' });
      return;
    }
    const result = await options.linkWallet.complete(
      state,
      url.searchParams.get('code') ?? undefined,
      url.searchParams.get('error') ?? undefined,
      url.searchParams.get('error_description') ?? undefined,
    );
    const webOrigin = appSignInWebOrigin(request, options);
    if (webOrigin) {
      const destination = new URL('/beeline/settings/workbench', webOrigin);
      response.writeHead(302, { location: destination.toString(),
        'set-cookie': `${appSignInReturnCookie}=; Path=/v1; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }
    if (/\b(?:Android|iPhone|iPad|iPod)\b/i.test(request.headers['user-agent'] ?? '')) {
      const appReturn = new URL('beeline://beeline/settings/workbench');
      if (result.ownerId) appReturn.searchParams.set('viewerId', result.ownerId);
      response.writeHead(302, {
        location: appReturn.toString(),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end();
    } else {
      response.writeHead(result.completed ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(
        result.completed
          ? '<p>Link connected. Return to Beeline.</p>'
          : '<p>Link sign-in did not complete. Return to Beeline and retry.</p>',
      );
    }
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/apps/oauth/start') {
    // Beeline web opens the provider through here so the verifier below can
    // send this browser back to the web app instead of the native app scheme.
    const authorization = url.searchParams.get('authorization') ?? '';
    const webOrigin = url.searchParams.get('return') ?? '';
    let isLinkSignIn = false;
    let safeAuthorization = false;
    try {
      const provider = new URL(authorization);
      safeAuthorization = provider.protocol === 'https:' && !provider.username && !provider.password
        && authorization.length <= 4096;
      isLinkSignIn = provider.origin === 'https://login.link.com' && provider.pathname === '/auth'
        && !provider.username && !provider.password;
    } catch { /* Invalid URLs are refused below. */ }
    if (!safeAuthorization || !options.webAppOrigins?.includes(webOrigin)) {
      json(response, 400, { error: 'Invalid app sign-in start' });
      return;
    }
    const storedSignIn = !isAppSignInLink(authorization) && !isLinkSignIn
      ? (await options.database.query(`SELECT 1 FROM workspace_connectors
          WHERE status='installing' AND sign_in->>'url'=$1
          UNION ALL SELECT 1 FROM agents WHERE squire_work->>'install'='true'
            AND squire_work->'signIn'->>'url'=$1 LIMIT 1`, [authorization])).rowCount > 0 : false;
    if (!(isAppSignInLink(authorization) || isLinkSignIn || storedSignIn) || !options.webAppOrigins?.includes(webOrigin)) {
      json(response, 400, { error: 'Invalid app sign-in start' });
      return;
    }
    response.writeHead(302, {
      location: authorization,
      'set-cookie': `${appSignInReturnCookie}=${encodeURIComponent(webOrigin)}; Path=/v1; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    response.end();
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/apps/oauth/verify') {
    const sessionUri = url.searchParams.get('session_uri');
    if (!sessionUri || sessionUri.length > 4096) {
      json(response, 400, { error: 'Invalid app sign-in session' });
      return;
    }
    const webOrigin = appSignInWebOrigin(request, options);
    if (webOrigin) {
      const webReturn = new URL('/beeline/settings/workbench/connect-signin', webOrigin);
      webReturn.searchParams.set('appSignInSession', sessionUri);
      response.writeHead(302, {
        location: webReturn.toString(),
        'set-cookie': `${appSignInReturnCookie}=; Path=/v1; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end();
      return;
    }
    const destination = new URL('beeline://beeline/settings/workbench/connect-signin');
    destination.searchParams.set('appSignInSession', sessionUri);
    const href = destination.toString().replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const nonce = randomUUID();
    // Browsers can block an automatic app handoff. Keep the same session in a
    // visible link so a deliberate tap can finish without starting sign-in again.
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Return to Beeline</title><style nonce="${nonce}">
body { margin: 0; padding: 32px 24px; font: 18px/1.5 system-ui, sans-serif; background: #14091a; color: #f7f3f8; }
main { max-width: 420px; margin: 12vh auto; } h1 { font-size: 28px; line-height: 1.2; }
p { color: #d3c8d7; } a { display: inline-block; padding: 14px 24px; border-radius: 10px; background: #f7f3f8; color: #14091a; font-weight: 600; text-decoration: none; }
a:focus-visible { outline: 3px solid #c8a8e8; outline-offset: 4px; }
</style></head><body><main><h1>Return to Beeline</h1>
<p>Return to Beeline to finish connecting your app. If it doesn't open automatically, tap below.</p>
<a id="open-beeline" href="${href}">Open Beeline</a>
</main><script nonce="${nonce}">window.location.href = document.getElementById('open-beeline').href;</script></body></html>`);
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/registry-mcp/oauth/callback') {
    if (!options.registryMcpOAuth) {
      json(response, 503, { error: 'Registry MCP OAuth is unavailable' });
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state) {
      json(response, 400, { error: 'Provider authorization was not completed' });
      return;
    }
    const completed = code
      ? await options.registryMcpOAuth.complete(state, code)
      : (await options.registryMcpOAuth.cancel(state), false);
    const webOrigin = appSignInWebOrigin(request, options);
    if (webOrigin) {
      response.writeHead(302, { location: new URL('/beeline/settings/workbench', webOrigin).toString(),
        'set-cookie': `${appSignInReturnCookie}=; Path=/v1; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }
    response.writeHead(completed ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(
      completed
        ? '<p>Provider sign-in completed. Return to Beeline while the helper connects the tool.</p>'
        : '<p>Provider sign-in did not complete. Return to Beeline and retry.</p>',
    );
    return;
  }
  if (options.authHandler && url.pathname.startsWith('/auth/')) {
    options.authHandler(request, response);
    return;
  }
  if (method === 'GET' && url.pathname === '/health') {
    const diagnostics = options.healthDatabase ?? options.database;
    await diagnostics.query('SELECT 1');
    const pool = options.database.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
    // Read the age from the APP database, the same object the pool counts come
    // from. The diagnostics handle has its own pool and its own in-flight set,
    // so asking it would report the health check's own query rather than the
    // work that can actually be stuck.
    const oldestActiveQueryAgeMs = await options.database.oldestActiveQueryAgeMs?.();
    const pools =
      options.databasePools &&
      Object.fromEntries(
        Object.entries(options.databasePools).map(([name, database]) => {
          const counts = database.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
          return [
            name,
            {
              size: counts.total,
              inUse: counts.total - counts.idle,
              waiting: counts.waiting,
              telemetry: database.poolTelemetry?.() ?? null,
            },
          ];
        }),
      );
    json(response, 200, {
      ok: true,
      database: {
        pool: {
          size: pool.total,
          inUse: pool.total - pool.idle,
          waiting: pool.waiting,
        },
        oldestActiveQueryAgeMs: oldestActiveQueryAgeMs ?? null,
        ...(options.database.queryProfiles
          ? { queryProfiles: options.database.queryProfiles() }
          : {}),
        ...(options.databaseBudget ? { budget: options.databaseBudget } : {}),
        ...(pools
          ? { pools }
          : options.enrichmentDatabase || options.jobsDatabase || options.healthDatabase
            ? {
                pools: Object.fromEntries(
                  (
                    [
                      ['enrichment', options.enrichmentDatabase],
                      ['diagnostics', options.healthDatabase],
                      ['jobs', options.jobsDatabase],
                    ] as const
                  )
                    .filter(([, db]) => !!db)
                    .map(([name, db]) => {
                      const counts = db?.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
                      return [
                        name,
                        {
                          size: counts.total,
                          inUse: counts.total - counts.idle,
                          waiting: counts.waiting,
                        },
                      ];
                    }),
                ),
              }
            : {}),
        ...(options.database.oldestActiveTransactionAgeMs
          ? { oldestActiveTransactionAgeMs: options.database.oldestActiveTransactionAgeMs() }
          : {}),
        ...(options.database.transactionDeadlineCount
          ? { transactionDeadlines: options.database.transactionDeadlineCount() }
          : {}),
      },
      live: liveHealth(),
      ...(options.backgroundHealth ? { background: options.backgroundHealth() } : {}),
      ...(options.liveBridgeHealth ? { liveBridge: options.liveBridgeHealth() } : {}),
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { ok: true });
    return;
  }
  if (method === 'GET' && url.pathname === '/readyz') {
    const ready = options.readiness?.() ?? true;
    json(response, ready ? 200 : 503, { ok: ready });
    return;
  }
  if (method === 'GET' && url.pathname === '/version') {
    json(response, 200, {
      version: process.env.BEELINE_RELEASE_VERSION ?? 'development',
      sourceSha: process.env.BEELINE_RELEASE_SHA ?? 'unknown',
      ...(helperVersionGate.minimum ? { minimumHelperVersion: helperVersionGate.minimum } : {}),
    });
    return;
  }
  if (url.pathname === '/v1/site/download-tap') {
    response.setHeader('vary', 'Origin');
    response.setHeader('cache-control', 'no-store');
    if (request.headers.origin !== 'https://usebeeline.app') {
      json(response, 403, { error: 'origin_denied' }); return;
    }
    response.setHeader('access-control-allow-origin', 'https://usebeeline.app');
    if (method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
      response.end(); return;
    }
    if (method !== 'POST') { json(response, 405, { error: 'method_not_allowed' }); return; }
    let input: unknown;
    try { input = JSON.parse((await bytes(request, 256)).toString('utf8')); }
    catch { json(response, 400, { error: 'invalid_download_tap' }); return; }
    const tap = parseSiteDownloadTap(input);
    if (!tap) { json(response, 400, { error: 'invalid_download_tap' }); return; }
    if (!await recordSiteDownloadTap(options.database, tap)) {
      json(response, 429, { error: 'daily_cap_reached' }); return;
    }
    response.writeHead(204); response.end(); return;
  }
  if (method === 'POST' && url.pathname === '/v1/admin/dashboard/refresh') {
    if (!options.dashboardSecret || !bearerSecretMatches(options.dashboardSecret, request)) {
      json(response,403,{error:'access_denied'});return;
    }
    const input=await body(request);
    if(Object.keys(input).some(key=>key!=='scope') || !['finances','x-reports','x-site-visits'].includes(String(input.scope))){
      json(response,400,{error:'invalid_refresh_scope'});return;
    }
    if(input.scope==='finances')json(response,200,await dashboardFinances(options.database));
    else{
      if(input.scope==='x-reports')await syncXAdReports(options.database);
      else await syncXSiteVisits(options.database);
      json(response,200,{ok:true});
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/admin/dashboard/x-ads/screen') {
    if (!options.dashboardSecret || !bearerSecretMatches(options.dashboardSecret, request)) {
      json(response, 403, { error: 'access_denied' });
      return;
    }
    let input: unknown;
    try { input = await body(request); }
    catch { json(response, 400, { error: 'invalid_screen_report' }); return; }
    const report = parseScreenReport(input);
    if (!report) { json(response, 400, { error: 'invalid_screen_report' }); return; }
    json(response, 200, await ingestScreenReport(options.database, report));
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/admin/dashboard') {
    // Authentication happens before parsing the filter or reading any ledger.
    // The browser never receives this key; the same-origin edge proxy supplies it.
    if (!options.dashboardSecret || !bearerSecretMatches(options.dashboardSecret, request)) {
      json(response, 403, { error: 'access_denied' });
      return;
    }
    const platforms = parseDashboardPlatforms(url.searchParams.get('platforms'));
    if (
      !platforms ||
      [...url.searchParams.keys()].some((key) => key !== 'platforms') ||
      url.searchParams.getAll('platforms').length > 1
    ) {
      json(response, 400, { error: 'invalid_platforms' });
      return;
    }
    json(
      response,
      200,
      await readOperatorDashboard(
        options.database,
        platforms,
        process.env.BEELINE_DASHBOARD_LATEST_MOBILE_RELEASE ?? 'development',
        {
          ...(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_IOS &&
          /^\d+$/.test(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_IOS)
            ? { ios: Number(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_IOS) }
            : {}),
          ...(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID &&
          /^\d+$/.test(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID)
            ? { android: Number(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID) }
            : {}),
        },
      ),
    );
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/public/invite-preview') {
    // The bearer invite stays in the query string because request logging records
    // only the pathname; do not put it in a path segment that becomes log data.
    const result = await invitePreview.resolve(
      url.searchParams.get('token') ?? '',
      clientKey(request),
    );
    if (result.status === 'found') publicJson(response, 200, result.preview);
    else if (result.status === 'rate_limited')
      publicJson(response, 429, { error: 'too_many_requests' });
    else publicJson(response, 404, { valid: false });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/daemon/rollback') {
    const input = await body(request);
    if (typeof input.exchangeToken !== 'string') throw new Error('exchangeToken is required');
    const agentId = await options.auth.consumeDaemonExchangeAgent(input.exchangeToken);
    if (!agentId) throw new Error('pairing not found');
    await options.phone.rollbackUnrealizedAgent(agentId);
    json(response, 204, {});
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/releases/daemon-readiness') {
    json(response, 200, await options.daemon.releaseReadiness());
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/public/mobile-minimum') {
    try {
      publicJson(response, 200, await readMobileMinimums(options.database));
    } catch {
      publicJson(response, 503, {});
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/releases/mobile-minimum') {
    if (!options.releaseNotify?.secret || !bearerSecretMatches(options.releaseNotify.secret, request)) {
      json(response, 403, { error: 'release_notify_access_denied' });
      return;
    }
    const input = await body(request);
    const minimum = parseMobileMinimum(input);
    if (!minimum || (input.platform !== 'android' && input.platform !== 'ios')) {
      json(response, 400, { error: 'platform, valid minVersion and reason required' });
      return;
    }
    await writeMobileMinimum(options.database, input.platform, minimum);
    json(response, 200, { platform: input.platform, ...minimum });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/releases/helper-minimum') {
    if (
      !options.releaseNotify?.secret ||
      !bearerSecretMatches(options.releaseNotify.secret, request)
    ) {
      json(response, 403, { error: 'release_notify_access_denied' });
      return;
    }
    const input = await body(request);
    if (typeof input.minVersion !== 'string') {
      json(response, 400, { error: 'minVersion_required' });
      return;
    }
    try {
      helperVersionGate.raise(input.minVersion);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid minimum helper version';
      json(response, reason.includes('cannot decrease') ? 409 : 400, { error: reason });
      return;
    }
    json(response, 200, { minVersion: helperVersionGate.minimum });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/releases/notify') {
    if (
      !options.releaseNotify?.secret ||
      !bearerSecretMatches(options.releaseNotify.secret, request)
    )
      throw new Error('release notify access denied');
    const input = await body(request);
    if (
      typeof input.version !== 'string' ||
      typeof input.sha !== 'string' ||
      typeof input.changelogUrl !== 'string'
    ) {
      throw new Error('version, sha and changelogUrl are required');
    }
    json(
      response,
      200,
      await options.releaseNotify.notifyReleaseDelivered({
        version: input.version,
        sha: input.sha,
        changelogUrl: input.changelogUrl,
      }),
    );
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/funnel/events') {
    if (!funnelRateLimit.allow(clientKey(request))) { json(response,429,{error:'too_many_requests'}); return; }
    let input: unknown;
    try { input = JSON.parse((await bytes(request, 1024)).toString('utf8')); }
    catch { json(response,400,{error:'invalid_funnel_event'}); return; }
    const event = parseSigninFunnelEvent(input);
    if (!event) { json(response,400,{error:'invalid_funnel_event'}); return; }
    const requiresIdentity = ['signed_in', 'workspace_created', 'first_message_sent', 'screen_shown'].includes(event.event);
    const viewerId = requiresIdentity || request.headers.authorization ? await phoneIdentity(request,options) : undefined;
    if (requiresIdentity && !viewerId) { json(response,401,{error:'unauthorized'}); return; }
    await recordSigninFunnelEvent(options.database,event,'client',viewerId ?? undefined);
    response.writeHead(204); response.end(); return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/github/reconnect') {
    const viewerId = await phoneIdentity(request, options);
    if (!viewerId) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    const matched = await options.auth.reconnectGitHub(viewerId, input.oidcToken);
    if (!matched) json(response, 409, { error: 'github_account_mismatch' });
    else {
      response.writeHead(204);
      response.end();
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/google/link') {
    const viewerId = await phoneIdentity(request, options);
    if (!viewerId) { json(response, 401, { error: 'unauthorized' }); return; }
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    await options.auth.linkGoogleOidc(viewerId, input.oidcToken);
    response.writeHead(204);
    response.end();
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/google/exchange') {
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    try {
      const tokens = await options.auth.exchangeGoogleOidc(input.oidcToken, input.xAttribution);
      const funnel = parseSigninFunnelEvent(input.funnel);
      if (funnel && funnel.event === 'provider_tapped' && funnel.provider === 'google') {
        await recordSigninFunnelEvent(options.database, {...funnel, event: 'signed_in'}, 'server', tokens.identityId).catch(() => undefined);
      }
      json(response, 200, tokens);
    } catch (error) {
      if (!(error instanceof GoogleSignInError)) throw error;
      json(response, 401, { error: 'google_sign_in_failed' });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/github/exchange') {
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    const tokens=await options.auth.exchangeGitHubOidc(input.oidcToken, input.xAttribution);
    const funnel=parseSigninFunnelEvent(input.funnel);
    if(funnel && funnel.event==='provider_tapped' && funnel.provider==='github') {
      await recordSigninFunnelEvent(options.database,{...funnel,event:'signed_in'},'server',tokens.identityId).catch(()=>undefined);
    }
    json(response,200,tokens);
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/review/exchange') {
    const input = await body(request);
    const redemption = await (options.review?.redeem(input.secret, clientKey(request)) ??
      Promise.resolve({ status: 'refused' as const }));
    if (redemption.status === 'redeemed') json(response, 200, redemption.tokens);
    // A rate limit is the only thing a client is told; an unknown secret and an
    // unconfigured server are the same ordinary 404, so neither is a hint.
    else if (redemption.status === 'rate_limited')
      json(response, 429, { error: 'too_many_requests' });
    else json(response, 404, { error: 'not_found' });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/logout') {
    const input = await body(request);
    if (typeof input.refreshToken !== 'string') throw new Error('refreshToken is required');
    await options.auth.revokePhoneSession(input.refreshToken);
    json(response, 200, { signedOut: true });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/refresh') {
    const input = await body(request);
    if (typeof input.refreshToken !== 'string') throw new Error('refreshToken is required');
    const result = await options.auth.refresh(input.refreshToken);
    json(response, result ? 200 : 401, result ?? { error: 'stale_refresh_token' });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/daemon/migrate-legacy') {
    const origin = options.legacyMigrationOrigin ?? process.env.BEELINE_MONOLITH_BASE_URL ?? 'https://server.usebeeline.app';
    const proof = verifyNip98Header(request.headers.authorization, `${origin.replace(/\/$/, '')}/v1/auth/daemon/migrate-legacy`, 'POST');
    if (!proof.ok) { json(response, 401, { error: 'legacy_identity_proof_required' }); return; }
    const input = await body(request);
    if (typeof input.workspaceId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.workspaceId) || typeof input.pairedBy !== 'string') {
      json(response, 400, { error: 'legacy_pairing_required' }); return;
    }
    const result = await options.auth.migrateLegacyDaemon({ agentId: proof.pubkey, proofId: proof.eventId, workspaceId: input.workspaceId, pairedBy: input.pairedBy });
    json(response, result ? 200 : 403, result ?? { error: 'legacy_reconnect_required' });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/daemon/exchange') {
    const input = await body(request);
    if (typeof input.exchangeToken !== 'string') throw new Error('exchangeToken is required');
    const result = await options.auth.exchangeDaemonToken(input.exchangeToken);
    json(response, result ? 200 : 401, result ?? { error: 'stale_daemon_exchange' });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/github/install/callback') {
    const state = url.searchParams.get('state');
    const installationId = Number(url.searchParams.get('installation_id'));
    if (
      !state ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      !options.github?.completeInstallation
    )
      throw new Error('GitHub installation callback is invalid');
    const location = await options.github.completeInstallation(state, installationId);
    response.writeHead(302, { location, 'cache-control': 'no-store' });
    response.end();
    return;
  }

  const walletWebhookPath = /^\/v1\/wallet\/events\/cdp\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
  if (method === 'POST' && walletWebhookPath) {
    const secret = options.cdpWebhookSecrets?.[walletWebhookPath[1]!];
    if (typeof secret !== 'string' || !secret) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    const raw = await bytes(request, MAX_JSON_BYTES);
    const accepted = await ingestWalletWebhook(options.database, raw, request.headers, secret);
    json(response, accepted ? 200 : 401,
      accepted ? { accepted: true } : { error: 'invalid_wallet_webhook' });
    return;
  }

  const subscriptionHook = /^\/hooks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
  if (method === 'POST' && subscriptionHook) {
    const chunks: Buffer[] = [];
    let size = 0;
    let retained = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      const keep = buffer.subarray(0, Math.max(0, WEBHOOK_BODY_LIMIT + 1 - retained));
      if (keep.length) { chunks.push(keep); retained += keep.length; }
    }
    const result = await ingestSubscriptionWebhook(options.database, subscriptionHook[1]!,
      Buffer.concat(chunks), { ...request.headers,
        'x-beeline-signature': request.headers['x-beeline-signature'] ?? url.searchParams.get('signature') ?? undefined,
        'x-beeline-delivery': request.headers['x-beeline-delivery'] ?? url.searchParams.get('delivery') ?? undefined,
      }, size);
    json(response, result.status, { outcome: result.outcome });
    return;
  }

  const providerWebhookPath = /^\/v1\/connectors\/events\/(linear|stripe)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
  if (method === 'POST' && providerWebhookPath) {
    const raw = await bytes(request, MAX_JSON_BYTES);
    const accepted = await ingestProviderWebhook(options.database,
      providerWebhookPath[1] as 'linear' | 'stripe', providerWebhookPath[2]!, raw, request.headers);
    if (!accepted) {
      json(response, 401, { error: 'invalid_webhook_signature' });
      return;
    }
    json(response, 200, { accepted: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/connectors/events/composio') {
    if (!options.composio || !options.composioReceiverUrl) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    const raw = await bytes(request, MAX_JSON_BYTES);
    const secret = await options.composio.triggerReceiverSecret(options.composioReceiverUrl);
    const accepted = await ingestComposioDelivery(options.database, raw, request.headers, secret);
    if (!accepted) {
      json(response, 401, { error: 'invalid_webhook_signature' });
      return;
    }
    json(response, 200, { accepted: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/github/webhook') {
    const payload = await bytes(request, MAX_JSON_BYTES);
    if (
      !options.github?.webhookSecret ||
      !signatureMatches(
        options.github.webhookSecret,
        payload,
        request.headers['x-hub-signature-256'] as string | undefined,
      )
    ) {
      json(response, 401, { error: 'invalid_webhook_signature' });
      return;
    }
    const delivery = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    if (typeof delivery !== 'string' || typeof event !== 'string')
      throw new Error('GitHub delivery headers are required');
    const parsed = JSON.parse(payload.toString('utf8')) as unknown;
    const completed = await options.database.query(
      `SELECT 1 FROM github_webhook_deliveries WHERE delivery_id=$1`,
      [delivery],
    );
    if (completed.rowCount) {
      json(response, 200, { accepted: false, duplicate: true });
      return;
    }
    if (options.github?.onWebhook) await options.github.onWebhook(event, parsed, delivery);
    const inserted = await options.database.query(
      `INSERT INTO github_webhook_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING`,
      [delivery],
    );
    const accepted = Boolean(inserted.rowCount);
    if (accepted && ++webhookWritesSincePrune % 64 === 1) {
      try {
        await options.database.query(
          `DELETE FROM github_webhook_deliveries delivery
           WHERE delivery.delivery_id IN (
             SELECT delivery_id FROM github_webhook_deliveries
             WHERE received_at<now()-interval '30 days'
             ORDER BY received_at,delivery_id LIMIT 1024 FOR UPDATE SKIP LOCKED)`,
        );
      } catch (error) {
        console.warn('[github-webhook] retention prune failed', error);
      }
    }
    json(response, accepted ? 202 : 200, {
      accepted,
      duplicate: !accepted,
    });
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/v1/company-logos/')) {
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice('/v1/company-logos/'.length)); }
    catch { json(response, 400, { error: 'invalid_company' }); return; }
    const image = await readCompanyLogo(id);
    if (!image) { json(response, 404, { error: 'company_icon_unavailable' }); return; }
    response.writeHead(200, { 'content-type': image.mime, 'content-length': String(image.bytes.length),
      'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox" });
    response.end(image.bytes); return;
  }
  if (method === 'GET' && url.pathname.startsWith('/v1/connectors/logo/')) {
    const type = url.pathname.slice('/v1/connectors/logo/'.length).replace(/\.svg$/, '');
    const logo = connectorLogo(type);
    if (!logo) {
      json(response, 404, { error: 'connector_not_found' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'image/svg+xml',
      'content-length': String(Buffer.byteLength(logo)),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    response.end(logo);
    return;
  }
  // OS Stop runs while JavaScript/the phone socket is suspended; its scoped stop token is a separate boundary.
  const nativeVoiceStop = url.pathname.match(/^\/v1\/phone\/voice\/([0-9a-f-]{36})\/native-stop$/);
  if (nativeVoiceStop && method === 'POST') {
    if (!options.voice) { json(response, 503, { error: 'Voice mode is unavailable' }); return; }
    const accepted = await options.voice.nativeStop(nativeVoiceStop[1]!, (await body(request)).token);
    json(response, accepted ? 200 : 403, accepted ? { left: true } : { error: 'invalid_voice_stop' });
    return;
  }
  if (method === 'GET' && await serveEmailImage(options.database, url, response)) return;
  return routeAuthenticated(request, response, options, invitePreview, liveHealth, helperVersionGate, httpPhoneOperation, url, method);

}
