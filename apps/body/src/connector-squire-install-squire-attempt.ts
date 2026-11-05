import { homedir } from 'node:os';
import { squireReachCause } from './squire-status.js';
import { squireBrokerSocketReady, squireHostPaths } from './squire-host.js';
import type { ConnectionGrant, ConnectorSignIn, ConnectorStep, VaultConnectionMeta } from '@beeline/api-contract/daemon';
import { InstallSquireOptions, InstallSquireResult, squireChromeProfileDir, defaultShellRunner, defaultStreamedRunner, step, prepareHostedSquire, releaseSquireConnectSession, SquireConnectResolution, resolveSquireConnectSpec, squireConnectProcessEnv, isOutstandingSignIn, connectBlockedLine, connectBrowserLocation, SquireMcpClient, isRecord } from './connector-squire.js';



export async function installSquireAttempt(
  options: InstallSquireOptions,
  retryReconnect: boolean,
): Promise<InstallSquireResult> {
  const profileDir = options.profileDir ?? squireChromeProfileDir();
  const run = options.run ?? defaultShellRunner;
  const streamRun = options.streamRun ?? defaultStreamedRunner;
  const log = options.log ?? (() => {});
  const steps: ConnectorStep[] = [step('helper reached', 'done')];
  const emit = () => options.onProgress?.([...steps]);
  const push = (next: ConnectorStep) => {
    steps.push(next);
    emit();
  };
  const fail = (reason: string): InstallSquireResult => {
    steps.push(step('waiting for sign-in', 'pending'));
    emit();
    return { status: 'error', steps, errorMessage: reason };
  };
  emit();

  const hostedEntry = process.env.BEELINE_HOSTED_SERVICES === '1'
    ? '/opt/beeline/squire/node_modules/@trusty-squire/mcp/dist/bin.js' : undefined;
  if (hostedEntry &&
    !await prepareHostedSquire(run, squireHostPaths(homedir()))) {
    const reason = 'The hosted browser service could not start. Retry the Trusty Squire connection.';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }

  // Stop only the connect ceremony this agent spawned. Squire alone decides
  // whether its profile is busy or connected in the next typed report.
  releaseSquireConnectSession(log, options.workspaceId);
  options.mcp?.reconnect?.();

  // Verify the copy npx resolves BEFORE connect runs, re-resolving a stale
  // one against the release this reader is written for.
  const resolution: SquireConnectResolution = hostedEntry
    ? { npxArgs: [], reResolved: false,
        resolvedVersion: (await run(process.execPath, [hostedEntry, '--version'])).stdout.trim() }
    : await resolveSquireConnectSpec(run);
  if (resolution.reResolved) {
    log(
      `trusty-squire stale copy ${resolution.resolvedVersion ?? 'unknown'} re-resolved against current release ${resolution.currentRelease}`,
    );
  }

  // A paired hosted broker can serve API apps before any browser provider is
  // signed in. Explicit provider re-login still needs its sign-in ceremony.
  if (hostedEntry && !options.forceReloginProvider &&
      (await pairSquire(options.mcp, options.workspaceId)).ok) {
    push(step(`trusty-squire${resolution.resolvedVersion ? ` ${resolution.resolvedVersion}` : ''} installed`, 'done'));
    push(step('waiting for sign-in', 'done'));
    push(step('paired to workspace', 'done'));
    push(step('Browser provider sign-in is available when a task needs it', 'done'));
    return { status: 'connected', steps,
      ...(resolution.resolvedVersion ? { squireVersion: resolution.resolvedVersion } : {}) };
  }

  // Ordinary hosted pairing can use the API plane without provider cookies.
  // Explicit provider re-login must open broker Chrome, so never skip its
  // browser ceremony. Personal-computer pairing also uses broker Chrome.
  // --json supplies the typed report consumed by the phone handoff.
  const install = await streamRun(
    hostedEntry ? process.execPath : 'npx',
    [
      ...(hostedEntry ? [hostedEntry] : resolution.npxArgs),
      'connect',
      '--target=codex',
      '--json',
      ...(hostedEntry && !options.forceReloginProvider ? ['--skip-browser'] : []),
      ...(options.forceReloginProvider
        ? [`--force-relogin=${options.forceReloginProvider}`]
        : []),
    ],
    squireConnectProcessEnv(profileDir),
    options.workspaceId,
  );
  const report = install.report;
  const version = resolution.resolvedVersion;

  // Nothing to render: a run that printed no report at all. Never Squire's
  // stderr — that is a command-line error, not something a person can act on.
  if (!report) {
    const reason = 'Trusty Squire did not report a connect result';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }
  // A `needs-sign-in` report promises a page. Anything else that is not
  // `connected` is blocked, and its own reason is what the person reads.
  if (report.state === 'needs-sign-in' && !report.sign_in_url) {
    const reason = 'Trusty Squire reported a sign-in without a page';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }
  const hostedAccountReady = !!hostedEntry && !options.forceReloginProvider && report.terminal &&
    report.reason === 'provider_session_missing' && !!report.account?.id;
  if (report.state !== 'connected' && !hostedAccountReady && !isOutstandingSignIn(report)) {
    const reason = connectBlockedLine(report) ?? 'Trusty Squire could not connect';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }
  // The connect process stays alive in the background for the human to sign in.
  // `install.abort()` can kill it (safety timeout also fires after 5 min).

  // The version was verified before connect ran; the step records what is
  // actually installed, not what a stale cache would have served.
  push(step(`trusty-squire${version ? ` ${version}` : ''} installed`, 'done'));

  const location = connectBrowserLocation(report.browser_location);
  const signIn: ConnectorSignIn | undefined =
    isOutstandingSignIn(report) && report.sign_in_url
      ? {
          method: location?.kind === 'virtual' || location?.kind === 'host_screen'
            ? 'streamed-page' : 'oauth',
          url: location?.kind === 'virtual' ? location.url : report.sign_in_url,
          ...(location ? { browserLocation: location } : {}),
        }
      : undefined;

  // A quick-tunnel name is printed before DNS knows it. A phone that looks it
  // up that early caches the miss for minutes, so publish once it answers.
  if (signIn && location?.kind === 'virtual' &&
      !await (options.awaitPage ?? awaitPublicPage)(signIn.url)) {
    log(`trusty-squire sign-in page ${new URL(signIn.url).host} was not ready on its admitted observation; publishing the reported result`);
  }

  // Surface the reported sign-in URL so the phone has a page to
  // open, with the report's own placement riding beside it. The step settles
  // only when there is nothing left to press: a run that printed a ceremony
  // is still waiting on the human, while the already-connected report has
  // nobody to wait for.
  push(step('waiting for sign-in', signIn ? 'pending' : 'done'));

  if (hostedEntry) {
    const sockets = squireHostPaths(homedir());
    if (!await squireBrokerSocketReady(sockets.brokerSocket) ||
        !await squireBrokerSocketReady(sockets.mcpSocket)) {
      return fail('The hosted browser service disconnected. Retry the Trusty Squire connection.');
    }
  }
  const pair = await pairSquire(options.mcp, options.workspaceId);
  if (!pair.ok) {
    // Connect may need the person to claim the account before the vault can
    // answer. Keep that ordinary step-4 ceremony usable; its process exit
    // wakes the assignment and the next attempt probes the published binding.
    if (pair.reconnectRequired && signIn) {
      return { status: 'installing', steps, signIn,
        ...(version ? { squireVersion: version } : {}) };
    }
    // A legacy store can survive a completed connect. Give Squire's supported
    // connect path one fresh attempt to publish/rebind it, then probe again.
    if (pair.reconnectRequired && retryReconnect) {
      log('trusty-squire account binding missing after connect; retrying connect once');
      return installSquireAttempt(options, false);
    }
    push(step('paired to workspace', 'failed', pair.reason));
    if (pair.reconnectRequired) return { status: 'error', steps, errorMessage: pair.reason,
      ...(version ? { squireVersion: version } : {}) };
    return {
      status: 'installing',
      steps,
      ...(signIn ? { signIn } : {}),
      ...(version ? { squireVersion: version } : {}),
    };
  }
  push(step('paired to workspace', 'done'));
  if (hostedAccountReady) {
    push(step('Browser provider sign-in is available when a task needs it', 'done'));
  }
  // An OUTSTANDING ceremony is not a connected helper. The vault answering
  // `list_credentials` proves the credential plane, never that the shared
  // Chrome carries a provider session — and `installConnector` completes the
  // row in one write, which navigates the connect screen off the surface the
  // human still has to press. This run stays `installing` and hands the phone
  // its ceremony; a LATER run whose report says `connected` completes it.
  if (signIn) {
    return {
      status: 'installing',
      steps,
      signIn,
      ...(version ? { squireVersion: version } : {}),
    };
  }
  return {
    status: 'connected',
    ...(report.account?.email || report.account?.id.includes('@')
      ? { signedInAs: report.account.email ?? report.account.id } : {}),
    steps,
    ...(version ? { squireVersion: version } : {}),
  };
}


/** How long the helper waits for a fresh sign-in page to answer. */
export const PAGE_READY_TIMEOUT_MS = 30_000;


/** One admitted readiness observation. A pending tunnel never schedules another
 * GET; another explicit setup action or actual report can observe it anew. */
export async function awaitPublicPage(url: string, _timeoutMs = PAGE_READY_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: undefined });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500;
  } catch { return false; }
}


/** Probe the mounted Squire MCP to confirm the account is live on this helper. */
export async function pairSquire(
  mcp: SquireMcpClient | undefined,
  _workspaceId: string,
): Promise<{ ok: true } | { ok: false; reason: string; reconnectRequired?: true }> {
  if (!mcp) return { ok: false, reason: 'the Squire MCP surface is not mounted on this helper' };
  try {
    const result = await mcp.call('list_credentials', { fields: 'summary' });
    if (isRecord(result) && (result.isError === true || result.error)) {
      return pairingFailure(result);
    }
    return { ok: true };
  } catch (error) {
    return pairingFailure(error);
  }
}


/** Decode MCP error envelopes for recovery, and publish only a plain cause. */
export function pairingFailure(error: unknown): { ok: false; reason: string; reconnectRequired?: true } {
  let payload: unknown = error;
  if (isRecord(payload) && Array.isArray(payload.content)) {
    payload = payload.content.find((entry: unknown) => isRecord(entry) && entry.type === 'text')?.text;
  }
  const text = payload instanceof Error ? payload.message : typeof payload === 'string' ? payload : '';
  if (text) {
    const start = text.indexOf('{');
    if (start >= 0) {
      try { payload = JSON.parse(text.slice(start)); } catch { /* unstructured tool failure */ }
    }
  }
  const cause = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  if (cause?.code === 'reconnect_required') {
    return { ok: false, reason: 'Trusty Squire needs account sign-in', reconnectRequired: true };
  }
  const plain = (typeof cause?.message === 'string' ? cause.message : text)
    .replace(/^list_credentials failed:\s*/, '').trim();
  return { ok: false, reason: plain && !/[{}\[\]]/.test(plain)
    ? plain : squireReachCause(new Error(text)) };
}


export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}


export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}


export function stringList(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}


export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}


/**
 * Squire reports vault timestamps as ISO-8601 strings; older shapes sent epoch
 * seconds. An unreadable one stays 0, which the Workbench KEYS ordering reads
 * as "no vault time" and answers with the row's own insert time.
 */
export function epochSeconds(value: unknown): number | null {
  const numeric = numberOrNull(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}


/** Map one Squire vault entry to the contract metadata (never secret values). */
export function vaultConnectionMeta(raw: unknown): VaultConnectionMeta {
  const record = asRecord(raw);
  const reference = String(record.reference ?? record.id ?? '');
  const expiresAt = epochSeconds(record.expires_at ?? record.expiresAt);
  return {
    reference,
    service: typeof record.service === 'string' ? record.service : null,
    label: String(record.label ?? record.service ?? reference),
    fieldNames: stringList(record.field_names ?? record.fieldNames),
    allowedHosts: stringList(record.allowed_hosts ?? record.allowedHosts),
    loginHosts: stringList(record.login_hosts ?? record.loginHosts),
    ...(typeof record.favicon_domain === 'string' ? { faviconDomain: record.favicon_domain } : {}),
    ...(typeof record.key_name === 'string' ? { keyName: record.key_name } : {}),
    ...(typeof record.kind === 'string' ? { credentialKind: record.kind } : {}),
    ...(expiresAt !== null ? { expiresAt } : {}),
    createdAt: epochSeconds(record.created_at ?? record.createdAt) ?? 0,
    stale: record.stale === true,
    state: record.state === 'error' ? 'error' : 'active',
  };
}


/** `list_credentials` through the Squire MCP, shaped to the contract. */
export async function readVault(mcp: SquireMcpClient): Promise<VaultConnectionMeta[]> {
  const result = asRecord(await mcp.call('list_credentials'));
  return asArray(result.credentials ?? result.items ?? result).map(vaultConnectionMeta);
}


export function connectionGrant(raw: unknown): ConnectionGrant {
  const record = asRecord(raw);
  return {
    grantId: String(record.grant_id ?? record.grantId ?? record.id ?? ''),
    credentialRef: String(record.credential_ref ?? record.credentialRef ?? record.reference ?? ''),
    createdAt: numberOrNull(record.created_at ?? record.createdAt) ?? 0,
    ...(numberOrNull(record.revoked_at ?? record.revokedAt) !== null
      ? { revokedAt: numberOrNull(record.revoked_at ?? record.revokedAt)! }
      : {}),
    ...(numberOrNull(record.rate_limit_per_hour) !== null
      ? { rateLimitPerHour: numberOrNull(record.rate_limit_per_hour)! }
      : {}),
    ...(numberOrNull(record.spend_cap_usd) !== null
      ? { spendCapUsd: numberOrNull(record.spend_cap_usd)! }
      : {}),
  };
}


/** Every live grant on one connection, from `list_app_access`. */
export async function readGrants(mcp: SquireMcpClient, ref: string): Promise<ConnectionGrant[]> {
  const result = asRecord(await mcp.call('list_app_access', {}));
  return asArray(result.grants ?? result.items ?? result)
    .map(connectionGrant)
    .filter((grant) => grant.credentialRef === ref && grant.revokedAt === undefined);
}


/** Revoke every live grant on one connection; partial failures are counted. */
export async function revokeGrants(
  mcp: SquireMcpClient,
  ref: string,
): Promise<{ revoked: number; failed: number }> {
  const grants = await readGrants(mcp, ref);
  let revoked = 0;
  let failed = 0;
  for (const grant of grants) {
    try {
      const result = asRecord(await mcp.call('revoke_app_access', { grant_id: grant.grantId }));
      if (result.revoked === false) failed += 1;
      else revoked += 1;
    } catch {
      failed += 1;
    }
  }
  return { revoked, failed };
}
