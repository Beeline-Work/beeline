import { NotificationWork } from './notification-work.js';
import { CommandRefusalError } from './command-refusal.js';
import { cornerReviewerSql, cornerReviewerFallbacksSql } from './corner-reviewer.js';
import type { RepositorySignals } from './repository-onboarding.js';
import { enqueueCornerBranchDeletion, retryCornerBranchDeletions } from './corner-branch-cleanup.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  GITHUB_IDENTITY_AUDIENCE,
  GitHubAppClient,
  GitHubOAuthClient,
  GitHubHttpError,
  GitHubCredentialRejectedError,
  githubMergeability,
  transientGitHubError,
  githubRetryDelay,
  retryGitHubRead,
} from '@beeline/auth/github';
import type { CornerLifecycleView, PhoneOperationMap } from '@beeline/api-contract/phone';
import type { CornerPullRequestResult } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { GITHUB_SUBJECT, systemLine, type SystemPhrase } from './system-line.js';
import { recordPersonMergeYes } from './corner-merge-approval.js';
import { assertCornerBriefAllowsMerge } from './corner-brief.js';
import { cancelCornerAgentCommands } from './corner-close.js';
import { captureServerError } from './sentry.js';
import { retryOnDeadlock } from './migration-retry.js';
import { deleteCornerWakeSources } from './corner-wake-cleanup.js';
import { abandonCornerWorkflowRuns } from './workflow-runs.js';
import {
  advanceCorner,
  claimCornerMergeAttempt,
  lockCornerLifecycle,
  cornerMergeGate,
  unfinishedCornerMergeClaims,
  clearUnfinishedCornerMergeClaim,
} from './corner-lifecycle.js';
import {
  queueCornerMergeConflict,
  reconcileCornerMergeBlockers,
  routeSystemCommand,
} from './agent-command.js';
import { recordInstitutionalCornerOutcome } from './institutional-memory-shadow.js';
import { reviewerList, roomAgentHealth } from './agent-health.js';
import { fireRepositorySubscriptions } from './agent-subscriptions.js';

type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];

type GitHubRecord = Record<string, unknown>;

function record(value: unknown): GitHubRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as GitHubRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function githubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function repositoryName(body: GitHubRecord): string | undefined {
  return text(record(body.repository)?.full_name);
}

function branchForEvent(event: string, body: GitHubRecord): string | undefined {
  if (event === 'push') {
    const ref = text(body.ref);
    return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  }
  if (event === 'pull_request') return text(record(record(body.pull_request)?.head)?.ref);
  if (event === 'check_run') return text(record(record(body.check_run)?.check_suite)?.head_branch);
  if (event === 'check_suite') return text(record(body.check_suite)?.head_branch);
  if (event === 'status') {
    const branches = Array.isArray(body.branches) ? body.branches : [];
    return branches.map((value) => text(record(value)?.name)).find(Boolean);
  }
  return undefined;
}

function checksResult(event: string, body: GitHubRecord): 'passed' | 'failed' | undefined {
  let value: string | undefined;
  if (event === 'check_run') {
    const run = record(body.check_run);
    if (body.action !== 'completed' && run?.status !== 'completed') return undefined;
    value = text(run?.conclusion);
  } else if (event === 'check_suite') {
    const suite = record(body.check_suite);
    if (body.action !== 'completed' && suite?.status !== 'completed') return undefined;
    value = text(suite?.conclusion);
  } else if (event === 'status') {
    value = text(body.state);
  }
  if (value === 'success' || value === 'neutral' || value === 'skipped') return 'passed';
  if (value && value !== 'pending') return 'failed';
  return undefined;
}

function checkFact(event: string, body: GitHubRecord) {
  if (event === 'check_run') {
    const run = record(body.check_run);
    const completed = body.action === 'completed' || run?.status === 'completed';
    const conclusion = text(run?.conclusion);
    return {
      name: text(run?.name) ?? `Check run ${integer(run?.id) ?? ''}`.trim(),
      status: completed
        ? checksResult(event, body) === 'passed'
          ? 'passed'
          : 'failed'
        : 'pending',
      ...(conclusion ? { conclusion } : {}),
      ...(text(run?.html_url) ? { url: text(run?.html_url)! } : {}),
      ...((text(run?.head_sha) ?? text(record(run?.check_suite)?.head_sha))
        ? {
            headSha: (text(run?.head_sha) ?? text(record(run?.check_suite)?.head_sha))!,
          }
        : {}),
    } as const;
  }
  if (event === 'check_suite') {
    const suite = record(body.check_suite);
    const completed = body.action === 'completed' || suite?.status === 'completed';
    const conclusion = text(suite?.conclusion);
    const appName = text(record(suite?.app)?.name);
    const headSha = text(suite?.head_sha);
    const repository = repositoryName(body);
    // check_suite.url is a GitHub API endpoint, not a page a person can use.
    const browserUrl =
      githubUrl(suite?.html_url) ??
      (repository &&
      /^[^/]+\/[^/]+$/.test(repository) &&
      headSha &&
      /^[a-f0-9]{40}$/i.test(headSha)
        ? `https://github.com/${repository}/commit/${headSha}/checks`
        : undefined);
    return {
      name: appName ? `${appName} check suite` : `Check suite ${integer(suite?.id) ?? ''}`.trim(),
      status: completed
        ? checksResult(event, body) === 'passed'
          ? 'passed'
          : 'failed'
        : 'pending',
      ...(conclusion ? { conclusion } : {}),
      ...(browserUrl ? { url: browserUrl } : {}),
      ...(headSha ? { headSha } : {}),
    } as const;
  }
  if (event === 'status') {
    const result = checksResult(event, body);
    return {
      name: text(body.context) ?? 'Commit status',
      status: result === 'passed' ? 'passed' : result === 'failed' ? 'failed' : 'pending',
      ...(text(body.description) ? { conclusion: text(body.description)! } : {}),
      ...(text(body.target_url) ? { url: text(body.target_url)! } : {}),
      ...(text(body.sha) ? { headSha: text(body.sha)! } : {}),
    } as const;
  }
  return undefined;
}

interface CornerWebhookTarget {
  corner_id: string;
  parent_id: string;
  author_id: string;
  corner_name: string;
  summary: string;
  repository_id: string;
  installation_id: string;
}

/** No check on the head is still running. */
function checksSettled(checks: readonly { status: string }[] | undefined): boolean {
  return !checks?.some((check) => check.status === 'pending');
}

/** A new Actions job also identifies a rerun whose start webhook was missed. */
function checksRestarted(
  previous: readonly { name: string; status: string; url?: string }[] | undefined,
  current: readonly { name: string; status: string; url?: string }[],
): boolean {
  if (!previous?.length || !checksSettled(previous)) return false;
  return !checksSettled(current) || current.some(check => {
    const before = previous.find(item => item.name === check.name);
    return Boolean(before?.url && check.url && actionsJobId(before.url) &&
      actionsJobId(check.url) && actionsJobId(before.url) !== actionsJobId(check.url));
  });
}

function actionsJobId(url: string | undefined): number | undefined {
  const match = url?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/);
  const id = match ? Number(match[1]) : undefined;
  return id && Number.isSafeInteger(id) ? id : undefined;
}

function jobErrorLines(log: string): string {
  const lines = log.split(/\r?\n/);
  const picked = new Set<number>();
  for (let i = 0, errors = 0; i < lines.length && errors < 3; i++) {
    if (!/##\[error\]/i.test(lines[i]!)) continue;
    errors++;
    for (let j = Math.max(0, i - 3); j <= i; j++) picked.add(j);
  }
  return [...picked].map(i => lines[i]!.slice(0, 300)).join('\n').slice(0, 1_500);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
// One conflict wake per pull-request head. The base is deliberately absent:
// every new commit on main moved it, so a stale 'dirty' verdict produced a
// fresh key and a fresh wake for an unchanged head.
function mergeConflictKey(number: number, headSha: string): string {
  return `merge-conflict:${number}:${headSha}`;
}
function challenge(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export type ReviewerWakeStatus = 'unconfigured' | 'unreachable' | 'waiting' | 'dispatched';

/** Whether the configured reviewer can be / was woken for this corner's current check state. */
export function reviewerWakeFromFacts(input: {
  configuredReviewerId: string | null;
  reviewerHandle: string | null;
  parentMember: boolean;
  cornerMember: boolean;
  /** The live GitHub verdict reported beside this status, never the stored lifecycle. */
  checks: string | undefined;
  /** The run sits in `review` after a green head woke the reviewer. */
  reviewWoken: boolean;
}): { status: ReviewerWakeStatus; detail: string } {
  const label = input.reviewerHandle ? `@${input.reviewerHandle}` : 'the configured reviewer';
  if (!input.configuredReviewerId) {
    return {
      status: 'unconfigured',
      detail: 'No reviewer is configured for this corner, so no agent is woken for review.',
    };
  }
  if (!input.parentMember) {
    return {
      status: 'unreachable',
      detail: `${label} is configured as reviewer but is not a current member of the parent Room, so the checks-passed transition cannot wake them.`,
    };
  }
  if (!input.cornerMember) {
    return {
      status: 'unreachable',
      detail: `${label} is configured as reviewer but is not a current member of this corner, so the checks-passed transition cannot wake them.`,
    };
  }
  if (input.reviewWoken) {
    return {
      status: 'dispatched',
      detail: `The checks-passed transition woke ${label}.`,
    };
  }
  if (input.checks === 'pending') {
    return {
      status: 'waiting',
      detail: `Checks are still pending, so ${label} has not been woken yet.`,
    };
  }
  return {
    status: 'waiting',
    detail: `A review turn has not been dispatched to ${label} yet.`,
  };
}

/** What one `landCornerOutcome` call did on GitHub. */
export type LandCornerOutcome =
  | { readonly status: 'not-attempted' }
  | { readonly status: 'started' }
  | { readonly status: 'queued' }
  | { readonly status: 'refused'; readonly reason: string };

export class GitHubOperations {
  readonly #key: Buffer;
  readonly #webhooks = new NotificationWork(1);
  readonly #roomTokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #roomTokenMints = new Map<string, Promise<{ token: string; expiresAt: number }>>();
  constructor(
    private readonly database: SqlDatabase,
    private readonly oauth: GitHubOAuthClient,
    private readonly app: GitHubAppClient,
    clientSecret: string,
    private readonly resolveSealedUserToken?: (subject: string) => Promise<string | undefined>,
    private readonly onRoomChanged?: (roomId: string) => void,
  ) {
    this.#key = createHash('sha256').update(clientSecret).digest();
  }

  async beginIdentity(viewerId: string, input: Input<'beginGitHubIdentityBind'>) {
    await this.database.query(
      `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'identity',now()+interval '15 minutes')`,
      [hash(input.state), viewerId, input.redirectUri],
    );
    return {
      url: this.oauth.authorizationUrl({
        state: input.state,
        codeChallenge: challenge(input.state),
        redirectUri: input.redirectUri,
      }),
    };
  }

  async completeIdentity(
    viewerId: string,
    input: Input<'completeGitHubIdentityBind'>,
    recover: boolean,
  ) {
    const flow = (
      await this.database.query<{
        redirect_uri: string;
        provider_identity: Record<string, string> | null;
        encrypted_token: string | null;
      }>(
        `SELECT redirect_uri,provider_identity,encrypted_token FROM github_auth_flows WHERE state_hash=$1 AND identity_id=$2 AND purpose='identity' AND consumed_at IS NULL AND expires_at>now()`,
        [hash(input.proof), viewerId],
      )
    ).rows[0];
    if (!flow) throw new Error('GitHub identity flow not found or expired');
    let github = flow.provider_identity;
    let sealed = flow.encrypted_token;
    let exchangedRefresh: string | undefined;
    let exchangedExpiresIn: number | undefined;
    if (!github || !sealed) {
      const exchanged = await this.oauth.exchangeCode(
        input.challenge,
        flow.redirect_uri,
        input.proof,
      );
      github = {
        subject: exchanged.subject,
        login: exchanged.login,
        name: exchanged.displayName ?? exchanged.login,
        issuer: exchanged.issuer,
        audience: exchanged.audience,
      };
      sealed = this.seal(exchanged.accessToken);
      exchangedRefresh = exchanged.refreshToken;
      exchangedExpiresIn = exchanged.tokenExpiresIn;
      await this.database.query(
        `UPDATE github_auth_flows SET provider_identity=$2::jsonb,encrypted_token=$3 WHERE state_hash=$1 AND consumed_at IS NULL`,
        [hash(input.proof), JSON.stringify(github), sealed],
      );
    }
    return this.database.transaction(async (database) => {
      const existing = (
        await database.query<{ identity_id: string }>(
          `SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject=$1`,
          [github!.subject],
        )
      ).rows[0];
      const current = (await database.query<{ subject: string }>(`SELECT subject FROM identity_external_links WHERE provider='github' AND identity_id=$1`, [viewerId])).rows[0];
      if (current && current.subject !== github!.subject) throw new Error('github_account_mismatch');
      if (existing && existing.identity_id !== viewerId && !recover)
        throw new Error('GitHub identity is already linked');
      if (existing && existing.identity_id !== viewerId) {
        await database.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [
          existing.identity_id,
        ]);
        await database.query(
          `INSERT INTO identity_successions(old_identity_id,new_identity_id,provider,subject) VALUES($1,$2,'github',$3) ON CONFLICT(old_identity_id) DO UPDATE SET new_identity_id=EXCLUDED.new_identity_id,subject=EXCLUDED.subject`,
          [existing.identity_id, viewerId, github!.subject],
        );
      }
      await database.query(
        `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
         VALUES('github',$1,$2,$3,$4,$5)
         ON CONFLICT(provider,subject) DO UPDATE SET
           identity_id=EXCLUDED.identity_id,
           issuer=EXCLUDED.issuer,
           audience=EXCLUDED.audience,
           provider_login=EXCLUDED.provider_login`,
        [github!.subject, viewerId, github!.issuer, GITHUB_IDENTITY_AUDIENCE, github!.login],
      );
      await database.query(
        `UPDATE identities SET github_subject=$2,updated_at=now() WHERE id=$1`,
        [viewerId, github!.subject],
      );
      await database.query(
        `INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()`,
        [
          github!.subject,
          sealed,
          exchangedRefresh ? this.seal(exchangedRefresh) : null,
          exchangedExpiresIn ? new Date(Date.now() + exchangedExpiresIn * 1000) : null,
        ],
      );
      await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [
        hash(input.proof),
      ]);
      return {
        personId: viewerId,
        recovered: Boolean(existing && existing.identity_id !== viewerId),
      };
    });
  }

  async beginInstallation(viewerId: string, input: Input<'beginGitHubInstallation'>) {
    const credential = await this.userCredential(viewerId, this.database);
    const binding = input.reconnect === true || !credential?.token;
    const state = `${binding ? (input.selectTarget ? 'github_bind_org_' : 'github_bind_') : 'repository_install_'}${randomBytes(32).toString('base64url')}`;
    await this.database.query(
      `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'installation',now()+interval '15 minutes')`,
      [hash(state), viewerId, input.redirectUri],
    );
    if (input.installationId) {
      await this.assertInstallationAccess(viewerId, input.installationId);
      await this.syncInstallation(viewerId, input.installationId);
    }
    // Use the App's registered OAuth callback, not the final client return URL.
    return { url: binding ? this.oauth.authorizationUrl({ state, codeChallenge: challenge(state) }) : this.app.installationUrl(state, input.selectTarget) };
  }

  async completeInstallation(state: string, installationId?: number, code?: string, callbackUri?: string) {
    try { return await this.database.transaction(async (database) => {
      const flow = (
        await database.query<{ identity_id: string; redirect_uri: string }>(
          `SELECT identity_id,redirect_uri FROM github_auth_flows WHERE state_hash=$1 AND purpose='installation' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
          [hash(state)],
        )
      ).rows[0];
      if (!flow) throw new Error('GitHub installation flow not found or expired');
      if (state.startsWith('github_bind_')) {
        if (!code || !callbackUri) throw new Error('github_connection_canceled');
        const identity = await this.oauth.exchangeCode(code, callbackUri, state);
        await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`github:${identity.subject}`]);
        await database.query(`SELECT id FROM identities WHERE id=$1 FOR UPDATE`, [flow.identity_id]);
        const links = (await database.query<{ subject: string; identity_id: string }>(
          `SELECT subject,identity_id FROM identity_external_links WHERE provider='github' AND (identity_id=$1 OR subject=$2) FOR UPDATE`,
          [flow.identity_id, identity.subject])).rows;
        if (links.some(link => link.identity_id !== flow.identity_id))
          throw new Error('That GitHub account belongs to another Beeline account. Sign out and continue with GitHub to use it.');
        if (links.some(link => link.subject !== identity.subject)) throw new Error('github_account_mismatch');
        await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
          VALUES('github',$1,$2,$3,$4,$5) ON CONFLICT(provider,subject) DO UPDATE SET provider_login=EXCLUDED.provider_login`,
          [identity.subject, flow.identity_id, identity.issuer, GITHUB_IDENTITY_AUDIENCE, identity.login]);
        await database.query(`UPDATE identities SET github_subject=$2,updated_at=now() WHERE id=$1`, [flow.identity_id, identity.subject]);
        await database.query(`INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
          encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()`,
          [identity.subject, this.seal(identity.accessToken), identity.refreshToken ? this.seal(identity.refreshToken) : null,
            identity.tokenExpiresIn ? new Date(Date.now()+identity.tokenExpiresIn*1000) : null]);
      }
      let installationIds: number[];
      if (installationId !== undefined) {
        installationIds = [installationId];
      } else {
        // OAuth-during-install returns an authorization code; the installation id
        // is not required. Discover grants with the original flow owner's token.
        const credential = await this.userCredential(flow.identity_id, database);
        if (!credential?.token) throw new Error('GitHub installation access denied');
        installationIds = [...(await this.listAdministeredInstallations(credential.token) ?? [])];
        if (!installationIds.length || state.startsWith('github_bind_org_')) {
          if (!state.startsWith('github_bind_')) throw new Error('GitHub installation access denied');
          const nextState = `${state.startsWith('github_bind_org_') ? 'repository_install_' : 'github_bind_'}${randomBytes(32).toString('base64url')}`;
          await database.query(
            `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'installation',now()+interval '15 minutes')`,
            [hash(nextState), flow.identity_id, flow.redirect_uri],
          );
          await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [hash(state)]);
          return this.app.installationUrl(nextState, state.startsWith('github_bind_org_'));
        }
      }
      let installed = 0;
      for (const id of installationIds) {
        if (state.startsWith('github_bind_')) {
          const account = await this.app.installationAccount(id);
          const credential = await this.userCredential(flow.identity_id, database);
          const administers = credential?.token && (account.type === 'User' ? account.id === credential.subject
            : await this.app.organizationAdmin(credential.token, account.login));
          if (!administers) {
            if (installationId === undefined) continue;
            throw new Error('github_installation_admin_required');
          }
        }
        await this.assertInstallationAccess(flow.identity_id, id, database);
        await this.syncInstallation(flow.identity_id, id, database);
        installed++;
      }
      if (!installed) throw new Error('github_installation_admin_required');
      await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [
        hash(state),
      ]);
      const redirect = new URL(flow.redirect_uri);
      redirect.searchParams.set('installed', '1');
      return redirect.toString();
    });
    } catch (reason) {
      if (!state.startsWith('github_bind_')) throw reason;
      const flow = (await this.database.query<{ redirect_uri: string }>(
        `UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1 AND purpose='installation'
         AND consumed_at IS NULL AND expires_at>now() RETURNING redirect_uri`, [hash(state)])).rows[0];
      if (!flow) throw reason;
      const message = reason instanceof Error ? reason.message : '';
      const error = message === 'github_installation_admin_required' ? message : message === 'github_account_mismatch' ? 'github_account_mismatch'
        : message.startsWith('That GitHub account belongs') ? 'github_account_already_linked'
        : message === 'github_connection_canceled' ? message : 'github_connection_failed';
      const redirect = new URL(flow.redirect_uri);
      redirect.searchParams.set('installed', '0');
      redirect.searchParams.set('error', error);
      return redirect.toString();
    }
  }

  async refresh(viewerId: string): Promise<{ githubReconnectNeeded?: boolean }> {
    const rows = await this.database.query<{ installation_id: string }>(
      `SELECT installation_id FROM github_installations WHERE owner_id=$1 AND status='active'`,
      [viewerId],
    );
    const installationIds = new Set(rows.rows.map((row) => Number(row.installation_id)));
    const credential = await this.userCredential(viewerId, this.database);
    let githubReconnectNeeded: boolean | undefined = credential?.reconnectNeeded;
    if (credential) {
      let administered: Set<number> | undefined;
      // The token every later user-scoped question must use: a rotation below
      // replaces it, and asking GitHub with the expired one answers nothing.
      let userToken = credential.token;
      try {
        administered = credential.token
          ? await this.listAdministeredInstallations(credential.token)
          : new Set<number>();
      } catch (error) {
        if (githubReconnectNeeded && error instanceof GitHubHttpError && error.status >= 500) {
          administered = undefined;
        } else if (!(error instanceof GitHubHttpError) || error.status !== 401) {
          throw error;
        } else {
          // User-to-server tokens expire after 8 hours; rotate once before giving up.
          const rotated = credential.refreshToken
            ? await this.rotateUserCredential(credential, this.database)
            : undefined;
          if (rotated) {
            userToken = rotated;
            administered = await this.listAdministeredInstallations(rotated);
          } else {
            // Refresh is impossible (no/revoked refresh token): degrade to the stored
            // installations instead of surfacing a 503 to the repo picker.
            administered = undefined;
            githubReconnectNeeded = true;
          }
        }
      }
      if (!credential.token) githubReconnectNeeded = true;
      try {
        const installations = await this.app.listInstallations();
        for (const installation of installations) {
          if (installation.account.type === 'User') {
            // A user-owned install claims only on the App JWT's own identity
            // match: GET /user/installations is the positive confirmation a
            // User account can always provide, so an unavailable listing
            // confirms nothing for it.
            if (administered && installation.account.id === credential.subject) {
              installationIds.add(installation.installationId);
            }
            continue;
          }
          // GET /user/installations is keyed to the lookup token's visibility
          // and cannot list organization installations — the same blindness
          // the install callback accommodates (see the reconciliation gate in
          // apps/auth/src/server-context.ts for the canonical comment). A
          // positively listed organization claims; an UNAVAILABLE listing
          // follows the install-callback precedent and claims an organization
          // nobody else owns yet; a definitive answer without it falls back to
          // MEMBERSHIP (below) before refusing, because the listing's silence
          // about an org install is not evidence of anything.
          const listed = Boolean(administered?.has(installation.installationId));
          if (administered && !listed) {
            // Membership is the user's own answer about their own account, so
            // an active member claims an org install /user/installations left
            // out. Anything else — 'none', an unaccepted invitation, GitHub
            // declining to answer — keeps the refusal this listing implied.
            const membership = userToken
              ? await this.app.organizationMembership(userToken, installation.account.login)
              : 'unknown';
            if (membership !== 'active') continue;
          }
          if (!listed) {
            // Whether discovered by the outage precedent or by membership, an
            // installation another identity already owns stays theirs: this
            // claim adds a viewer, it never steals a row.
            const owner = (
              await this.database.query<{ owner_id: string }>(
                `SELECT owner_id FROM github_installations WHERE installation_id=$1`,
                [installation.installationId],
              )
            ).rows[0]?.owner_id;
            if (owner && owner !== viewerId) continue;
          }
          installationIds.add(installation.installationId);
        }
      } catch (error) {
        if (!githubReconnectNeeded) throw error;
      }
    }
    for (const installationId of installationIds) {
      try {
        await this.syncInstallation(viewerId, installationId);
      } catch (error) {
        if (!githubReconnectNeeded) throw error;
      }
    }
    return { ...(githubReconnectNeeded ? { githubReconnectNeeded } : {}) };
  }

  /** Whether the viewer starred `fullName`; 'unknown' without a usable token or answer. */
  async repositoryStarred(viewerId: string, fullName: string): Promise<boolean | 'unknown'> {
    const token = (await this.userCredential(viewerId, this.database))?.token;
    return token ? this.app.repositoryStarred(token, fullName) : 'unknown';
  }

  /** Star `fullName` with the viewer's own token. False when GitHub refuses. */
  async starRepository(viewerId: string, fullName: string): Promise<boolean> {
    const token = (await this.userCredential(viewerId, this.database))?.token;
    return token ? this.app.starRepository(token, fullName) : false;
  }

  /** Read signals with the Room's exact-repository installation token. */
  async onboardingSignals(roomId: string): Promise<RepositorySignals> {
    const room = (await this.database.query<{ repository_name: string; repository_target_branch: string }>(
      `SELECT repository_name,repository_target_branch FROM rooms WHERE id=$1 AND repository_resolution='repository'`, [roomId])).rows[0];
    if (!room) throw new Error('Link a repository before reading starters');
    const token = await this.roomToken(roomId);
    const read = (path: string) => this.app.issuesRequest(token.token, room.repository_name, 'GET', path);
    const [commitsResult, issuesResult, branchesResult, treeResult] = await Promise.all([
      read(`commits?sha=${encodeURIComponent(room.repository_target_branch)}&per_page=30`).catch(error => {
        if (error instanceof GitHubHttpError && error.status === 409) return [];
        throw error;
      }),
      read('issues?state=open&sort=created&direction=asc&per_page=50'),
      read('branches?per_page=100'),
      read(`git/trees/${encodeURIComponent(room.repository_target_branch)}?recursive=1`).catch(error => {
        if (error instanceof GitHubHttpError && [404, 409].includes(error.status)) return { tree: [] };
        throw error;
      }),
    ]);
    const records = (value: unknown) => Array.isArray(value) ? value.map(record).filter((r): r is GitHubRecord => !!r) : [];
    const commits = await Promise.all(records(commitsResult).slice(0, 10).map(async commit => {
      const sha = text(commit.sha)!;
      const detail = record(await read(`commits/${encodeURIComponent(sha)}`));
      return { sha, message: text(record(commit.commit)?.message) ?? '',
        files: records(detail?.files).map(file => text(file.filename)).filter((p): p is string => !!p) };
    }));
    const head = commits[0]?.sha;
    const checks = head ? await this.app.readCommitCheckRollup(token.token, room.repository_name, head) : undefined;
    return {
      commits, failingChecks: checks?.failing ?? [],
      issues: records(issuesResult).filter(issue => !issue.pull_request).map(issue => ({ number: integer(issue.number)!,
        title: text(issue.title) ?? '', bug: records(issue.labels).some(label => /bug/i.test(String(label.name))) })),
      branches: records(branchesResult).map(branch => text(branch.name)).filter((p): p is string => !!p),
      files: records(record(treeResult)?.tree).map(file => text(file.path)).filter((p): p is string => !!p),
    };
  }

  async createRepository(viewerId: string, input: Input<'createGitHubRepository'>, database: SqlDatabase = this.database) {
    const installation = (
      await database.query<{ account_login: string; account_type: 'User' | 'Organization' }>(
        `SELECT account_login,account_type FROM github_installations WHERE installation_id=$1 AND owner_id=$2 AND status='active'`,
        [input.installationId, viewerId],
      )
    ).rows[0];
    if (!installation) throw new Error('GitHub installation not found');
    const token = (await this.userCredential(viewerId, database))?.token;
    const repository = await this.app.createRepository(
      input.installationId,
      { login: installation.account_login, type: installation.account_type },
      {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      },
      token,
    );
    await this.storeRepository(repository, database);
    return {
      id: repository.id,
      fullName: repository.fullName,
      installationId: repository.installationId,
      defaultBranch: repository.defaultBranch,
      private: repository.private,
    };
  }

  async roomToken(roomId: string) {
    const row = (
      await this.database.query<{ github_installation_id: string; repository_id: string }>(
        `SELECT r.github_installation_id,g.repository_id FROM rooms r
         JOIN github_repositories g ON g.installation_id=r.github_installation_id
           AND g.active AND lower(g.full_name)=lower(regexp_replace(regexp_replace(
             r.repository_remote,'^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         JOIN github_installations i ON i.installation_id=g.installation_id
         WHERE r.id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
           AND r.repository_resolution='repository' AND i.status='active'`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('GitHub repository installation not found');
    const now = Date.now();
    for (const [key, value] of this.#roomTokens) {
      if (value.expiresAt - now <= 5 * 60_000) this.#roomTokens.delete(key);
    }
    const key = `${row.github_installation_id}:${row.repository_id}`;
    const cached = this.#roomTokens.get(key);
    if (cached) return { ...cached };
    const pending = this.#roomTokenMints.get(key);
    if (pending) return { ...await pending };
    const mint = (async () => {
      const value = await this.app.installationToken(Number(row.github_installation_id), {
        repositoryIds: [Number(row.repository_id)],
      });
      const token = { token: value.token, expiresAt: new Date(value.expiresAt).getTime() };
      if (token.expiresAt - Date.now() > 5 * 60_000) this.#roomTokens.set(key, token);
      return token;
    })();
    this.#roomTokenMints.set(key, mint);
    try {
      return { ...await mint };
    } finally {
      this.#roomTokenMints.delete(key);
    }
  }

  /**
   * The installation token, repository, and default branch behind a corner or
   * Room addressed by either id.
   *
   * A generated procedure's source Room is the CORNER it came out of, while an
   * installation token is minted for the top-level Room only, so the lookup
   * walks to the corner's parent — the same authority `roomToken` requires. It
   * deliberately does not filter archived Rooms: a code-anchor check runs long
   * after the corner that produced the procedure has been archived away.
   */
  async roomAnchorTarget(roomId: string, database: SqlDatabase = this.database) {
    const parentId = (
      await database.query<{ id: string }>(
        `SELECT COALESCE(parent.id,own.id) id FROM rooms own
         LEFT JOIN rooms parent ON parent.id=own.parent_id
         WHERE own.id=$1`,
        [roomId],
      )
    ).rows[0]?.id;
    if (!parentId) throw new Error('GitHub repository installation not found');
    return this.roomWorkflowTarget(parentId, database);
  }

  private async roomWorkflowTarget(roomId: string, database: SqlDatabase = this.database) {
    const row = (
      await database.query<{
        github_installation_id: string;
        repository_id: string;
        full_name: string;
        default_branch: string;
      }>(
        `SELECT r.github_installation_id,g.repository_id,g.full_name,g.default_branch
         FROM rooms r
         JOIN github_repositories g ON lower(g.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(r.repository_remote,r.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         JOIN github_installations i ON i.installation_id=g.installation_id
         WHERE r.id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
           AND r.github_installation_id=i.installation_id AND g.active AND i.status='active'`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('GitHub repository installation not found');
    const token = await this.app.installationToken(Number(row.github_installation_id), {
      repositoryIds: [Number(row.repository_id)],
    });
    return {
      token: token.token,
      repository: row.full_name,
      defaultBranch: row.default_branch,
    };
  }

  /** Read every PR commit, including coauthors, using the repository installation. */
  async assertCornerReviewerNotAuthor(cornerId: string, agentId: string, database: SqlDatabase = this.database): Promise<void> {
    const pr = (await database.query<{ number: number | null; head_sha: string | null }>(
      `SELECT lifecycle->'pr'->>'headSha' head_sha,(lifecycle->'pr'->>'number')::int number FROM corner_facts WHERE corner_id=$1`, [cornerId],
    )).rows[0];
    if (!pr?.number) return;
    const target = await this.roomAnchorTarget(cornerId, database);
    const verifyHead = async () => {
      const live = record(await this.app.issuesRequest(target.token, target.repository, 'GET', `pulls/${pr.number}`));
      const count = integer(live?.commits);
      if (!pr.head_sha || record(live?.head)?.sha !== pr.head_sha)
        throw new CommandRefusalError('PR head changed; refresh checks before selecting or approving a reviewer', 409);
      // GitHub's PR commits endpoint exposes at most 250 commits.
      if (!count || count > 250)
        throw new CommandRefusalError('could not verify every PR author; split the PR to at most 250 commits', 409);
      return count;
    };
    const count = await verifyHead();
    let seen = 0;
    const email = `${agentId.slice(0, 16)}@users.noreply.github.com`;
    for (let page = 1; page <= 3; page++) {
      const response = await this.app.issuesRequest(target.token, target.repository, 'GET',
        `pulls/${pr.number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(response)) throw new Error('could not verify PR commit authors');
      seen += response.length;
      for (const value of response) {
        const commit = record(record(value)?.commit);
        const author = record(commit?.author);
        const committer = record(commit?.committer);
        if (typeof author?.email !== 'string' || !author.email || typeof committer?.email !== 'string' || !committer.email
          || typeof commit?.message !== 'string') throw new Error('could not verify PR commit authors');
        if ([author.email, committer.email].some(value => typeof value === 'string' && value.toLowerCase() === email)
          || (typeof commit?.message === 'string' && commit.message.split(/\r?\n/).some(line =>
            /^co-authored-by:\s/i.test(line) && line.trim().toLowerCase().endsWith(`<${email}>`))))
          throw new CommandRefusalError('reviewer must be independent: a PR commit author cannot review its own work', 409);
      }
      if (response.length < 100) {
        if (seen !== count || await verifyHead() !== count) throw new Error('PR commit list changed or is incomplete');
        return;
      }
    }
    throw new Error('could not verify all PR commit authors; select a reviewer after reducing the PR');
  }

  async listRoomWorkflows(roomId: string) {
    const target = await this.roomWorkflowTarget(roomId);
    const workflows = await this.app.listDispatchableWorkflows(
      target.token,
      target.repository,
      target.defaultBranch,
    );
    return {
      defaultBranch: target.defaultBranch,
      workflows: workflows.map(({ name, lastRunAt, conclusion }) => ({
        name,
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
        ...(conclusion ? { conclusion } : {}),
      })),
    };
  }

  async dispatchRoomWorkflow(roomId: string, workflowName: string): Promise<void> {
    const name = workflowName.trim();
    if (!name || name.length > 255) throw new Error('invalid workflow name');
    if (name === 'Unified production release') throw new Error('Production release requires an agent identity; use the audited release command');
    const target = await this.roomWorkflowTarget(roomId);
    const workflows = await this.app.listDispatchableWorkflows(
      target.token,
      target.repository,
      target.defaultBranch,
    );
    const matches = workflows.filter((workflow) => workflow.name === name);
    if (matches.length !== 1) throw new Error('dispatchable workflow not found');
    await this.app.dispatchWorkflow(
      target.token,
      target.repository,
      matches[0]!.id,
      target.defaultBranch,
    );
  }

  async dispatchProductionRelease(roomId: string, inputs: Record<string, string>): Promise<void> {
    if (!inputs.dispatched_by) throw new Error('Production release requires an agent identity');
    const target = await this.roomAnchorTarget(roomId);
    if (target.repository.toLowerCase() !== 'beeline-work/beeline' || target.defaultBranch !== 'main')
      throw new Error('Production release requires Beeline main');
    await this.app.dispatchProductionWorkflow(target.token, target.repository, inputs);
  }

  /** Caller is authorized by DaemonService against the requesting corner membership. */
  async prChecksStatus(input: { cornerId: string; pullRequest?: number | string }, confirmZeroChecks = false) {
    const corner = (
      await this.database.query<{
        parent_id: string;
        workspace_id: string;
        lifecycle: CornerLifecycleView;
        archived: boolean;
        review_woken: boolean;
        configured_reviewer_id: string | null;
        reviewer_fallback_ids: string[];
        reviewer_identity_id: string | null;
        parent_reviewer_id: string | null;
        corner_reviewer_id: string | null;
        reviewer_handle: string | null;
      }>(
        `SELECT r.parent_id,parent.workspace_id,f.lifecycle,
                r.archived_at IS NOT NULL archived,
                (f.workflow_state='review' AND f.workflow_outcome IS DISTINCT FROM 'no_reviewer') review_woken,
                ${cornerReviewerSql('r')} configured_reviewer_id,
                ${cornerReviewerFallbacksSql('r')} reviewer_fallback_ids,
                reviewer_identity.id reviewer_identity_id,
                parent_member.identity_id parent_reviewer_id,
                corner_member.identity_id corner_reviewer_id,
                reviewer_identity.handle reviewer_handle
         FROM rooms r
         JOIN corner_facts f ON f.corner_id=r.id
         JOIN rooms parent ON parent.id=r.parent_id
         LEFT JOIN identities reviewer_identity ON reviewer_identity.id=${cornerReviewerSql('r')}
           AND reviewer_identity.kind='agent'
         LEFT JOIN effective_memberships parent_member ON parent_member.room_id=parent.id
           AND parent_member.identity_id=${cornerReviewerSql('r')} AND parent_member.removed_at IS NULL
         LEFT JOIN effective_memberships corner_member ON corner_member.room_id=r.id
           AND corner_member.identity_id=${cornerReviewerSql('r')} AND corner_member.removed_at IS NULL
         WHERE r.id=$1`,
        [input.cornerId],
      )
    ).rows[0];
    if (!corner?.parent_id) throw new Error('corner not found');
    const target = await this.roomWorkflowTarget(corner.parent_id);
    const requested = input.pullRequest ?? corner.lifecycle.pr?.number;
    let number: number;
    if (typeof requested === 'number') number = requested;
    else if (typeof requested === 'string') {
      const match = requested.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i);
      if (!match || match[1]!.toLowerCase() !== target.repository.toLowerCase())
        throw new Error('pull request must belong to the corner Room repository');
      number = Number(match[2]);
    } else throw new Error('specify the pull request number or URL being reviewed');
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('invalid pull request number');
    // Always resolve the head: a force-push must never inherit a green predecessor.
    const pr = await this.app.readPullRequest(target.token, target.repository, number);
    let rollup = await this.app.readCommitCheckRollup(
      target.token,
      target.repository,
      pr.headSha,
    );
    let zeroChecksConfirmed = false;
    if (confirmZeroChecks && rollup.total === 0 && rollup.state === 'pending') {
      const absent = await this.app.confirmNoChecks(target.token, target.repository, pr.headSha);
      // Re-read after registration evidence: neither a new head nor a newly
      // registered status context can inherit the earlier empty rollup.
      const latestPr = await this.app.readPullRequest(target.token, target.repository, number);
      rollup = await this.app.readCommitCheckRollup(target.token, target.repository, pr.headSha);
      zeroChecksConfirmed = absent && !rollup.pendingRegistrations && latestPr.headSha === pr.headSha && rollup.total === 0;
    }
    // A completed worker handoff can establish that this head genuinely has no
    // checks. Before that point a null rollup is only the ordinary race between
    // opening a PR and GitHub registering its workflows, so it remains pending.
    const completedWithoutChecks =
      !rollup.pendingRegistrations &&
      rollup.total === 0 &&
      corner.lifecycle.checks === 'passing' &&
      corner.lifecycle.checksSummary?.total === 0 &&
      corner.lifecycle.pr?.headSha === pr.headSha;
    const checks = completedWithoutChecks ? ('passed' as const) : rollup.state;
    const configuredReviewerId = corner.configured_reviewer_id;
    // The same gate the server merges on (`cornerMergeGate`), for this exact head.
    const gate = await cornerMergeGate(this.database, input.cornerId, {
      number,
      headSha: pr.headSha,
    });
    const { reviewerExists } = gate;
    const listed = corner.reviewer_fallback_ids.length
      ? reviewerList({
          reviewer_agent_id: configuredReviewerId,
          reviewer_fallback_ids: corner.reviewer_fallback_ids,
        })
      : [];
    const listLabel = listed.length
      ? `the reviewer list (${(
          await this.database.query<{ id: string; handle: string | null }>(
            `SELECT id,handle FROM identities WHERE id=ANY($1::text[])`,
            [listed],
          )
        ).rows
          .sort((a, b) => listed.indexOf(a.id) - listed.indexOf(b.id))
          .map((row) => (row.handle ? `@${row.handle}` : row.id))
          .join(', ')})`
      : null;
    const reviewer = listLabel
      ? `an agent on ${listLabel}`
      : configuredReviewerId && corner.reviewer_handle
        ? `@${corner.reviewer_handle}`
        : null;
    const reviewerWake = listLabel
      ? await this.listReviewerWake({
          parentId: corner.parent_id,
          candidates: listed,
          listLabel,
          checks,
          reviewWoken: corner.review_woken,
        })
      : reviewerWakeFromFacts({
          configuredReviewerId,
          reviewerHandle: corner.reviewer_handle,
          parentMember: Boolean(
            configuredReviewerId && corner.reviewer_identity_id && corner.parent_reviewer_id,
          ),
          cornerMember: Boolean(
            configuredReviewerId && corner.reviewer_identity_id && corner.corner_reviewer_id,
          ),
          checks,
          reviewWoken: corner.review_woken,
        });
    const mergeAllowed = !corner.archived && checks === 'passed' && gate.open;
    // Where the corner stands, from the live facts above: building ->
    // checking -> waiting for a yes -> merged (or closed).
    const stage = pr.merged
      ? ('merged' as const)
      : corner.archived
        ? ('closed' as const)
        : checks === 'passed'
          ? ('waiting_for_yes' as const)
          : checks === 'failed'
            ? ('building' as const)
            : ('checking' as const);
    return {
      ...(confirmZeroChecks ? { zeroChecksConfirmed } : {}),
      stage,
      checks,
      checkCount: rollup.total,
      checkStates: {
        passed: rollup.checks.filter((check) => check.status === 'passed').length,
        pending: rollup.checks.filter((check) => check.status === 'pending').length,
        failed: rollup.checks.filter((check) => check.status === 'failed').length,
        unlisted: Math.max(0, rollup.total - rollup.checks.length),
        pendingNames: rollup.checks
          .filter((check) => check.status === 'pending')
          .slice(0, 10)
          .map((check) => check.name),
        failedNames: rollup.checks
          .filter((check) => check.status === 'failed')
          .slice(0, 10)
          .map((check) => check.name),
      },
      pullRequest: pr.url,
      headSha: pr.headSha,
      approved: gate.approved,
      reviewer,
      reviewerExists,
      reviewerWake,
      held: gate.held,
      holds: gate.holds,
      mergeAllowed,
    };
  }

  /** `reviewerWake` for a Room with fallback reviewers: the list's health, then the dispatch state. */
  private async listReviewerWake(input: {
    parentId: string;
    candidates: readonly string[];
    listLabel: string;
    /** The live GitHub verdict reported beside this status, never the stored lifecycle. */
    checks: string | undefined;
    reviewWoken: boolean;
  }): Promise<{ status: ReviewerWakeStatus; detail: string }> {
    const health = await roomAgentHealth(this.database, input.parentId, input.candidates);
    if (!health.size)
      return {
        status: 'unreachable',
        detail: `No agent on ${input.listLabel} is a current member of the parent Room, so the checks-passed transition cannot wake anyone.`,
      };
    if (![...health.values()].some((agent) => agent.healthy))
      return {
        status: 'unreachable',
        detail: `Every agent on ${input.listLabel} is offline, recently failed, or out of credit.`,
      };
    if (input.reviewWoken)
      return {
        status: 'dispatched',
        detail: `The checks-passed transition woke the first healthy agent on ${input.listLabel}.`,
      };
    return {
      status: 'waiting',
      detail:
        input.checks === 'pending'
          ? `Checks are still pending, so nobody on ${input.listLabel} has been woken yet.`
          : `A review turn has not been dispatched to ${input.listLabel} yet.`,
    };
  }

  /**
   * The phone's approve: a Workspace owner or admin's yes on the current head
   * (`recordPersonMergeYes`), then the one merge path, `landCorner`. Checks
   * must be green and no hold may stand; a yes given early merges when the
   * implementer's `merge_corner` runs after green checks.
   */
  async approveCornerMerge(viewerId: string, input: Input<'approveCornerMerge'>) {
    const corner = (
      await this.database.query<{ archived: boolean; lifecycle: CornerLifecycleView }>(
        `SELECT corner.archived_at IS NOT NULL archived,fact.lifecycle
         FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE corner.id=$1`,
        [input.cornerId],
      )
    ).rows[0];
    const pullRequest = corner?.lifecycle.pr;
    if (!corner || !pullRequest) throw new Error('corner has no pull request to merge');
    if (corner.archived || corner.lifecycle.lifecycle === 'done')
      return { status: 'already-merged' as const, pullRequestUrl: pullRequest.url };
    const yes = await recordPersonMergeYes(this.database, input.cornerId, viewerId);
    await this.landCorner(input.cornerId);
    return {
      status: yes.recorded ? ('merge-requested' as const) : ('already-requested' as const),
      pullRequestUrl: pullRequest.url,
    };
  }

  /**
   * The one merge path. Squash-merges a corner at its exact head when
   * `pr_checks_status`'s `mergeAllowed` is true on GitHub's current head:
   * live checks green, a yes said on that head, and no hold. Called by
   * the implementer's `merge_corner`, a person's yes (`order_corner_merge` or
   * the phone's approve). Recovery only confirms or releases an unfinished attempt.
   * At most one attempt per head: the attempt is claimed under the run lock
   * before GitHub is called. Confirmation, the webhook, or recurring recovery
   * then lands the corner; a refusal returns GitHub's reason to the implementer.
   *
   * The brief gate lives here, for all of those callers: a corner whose
   * current brief does not assign repository work (no brief, or
   * `repositoryWork: false`) throws `CornerBriefMergeRefusedError` before
   * GitHub is read, so every caller reports the same refusal.
   */
  async landCorner(cornerId: string): Promise<boolean> {
    return (await this.landCornerOutcome(cornerId)).status !== 'not-attempted';
  }

  /**
   * `landCorner`, telling a started merge apart from one GitHub refused, so
   * `merge_corner` can report the refusal instead of `merge-started`.
   */
  async landCornerOutcome(cornerId: string, onBlocked?: (reason: string) => void): Promise<LandCornerOutcome> {
    const notAttempted = (reason: string) => {
      onBlocked?.(reason);
      return { status: 'not-attempted' } as const;
    };
    await assertCornerBriefAllowsMerge(this.database, cornerId);
    let status: Awaited<ReturnType<GitHubOperations['prChecksStatus']>>;
    try {
      status = await this.prChecksStatus({ cornerId });
    } catch (error) {
      console.error(
        `[server] corner ${cornerId} merge gate read failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return notAttempted('GitHub merge gate read failed');
    }
    if (!status.mergeAllowed) return notAttempted([
      status.checks !== 'passed' ? `checks are ${status.checks}` : '',
      status.approved ? '' : 'no yes on this head', status.held ? 'a hold stands' : '',
    ].filter(Boolean).join('; ') || 'the merge gate is closed');
    const target = (
      await this.database.query<CornerWebhookTarget & {
        number: number;
        feature_branch: string | null;
        full_name: string;
      }>(
        `SELECT (fact.lifecycle->'pr'->>'number')::int number,fact.feature_branch,
           repository.repository_id,repository.installation_id,repository.full_name,
           corner.id corner_id,parent.id parent_id,corner.name corner_name,
           COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) author_id,fact.objective summary
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
           AND repository.active AND lower(repository.full_name)=lower(regexp_replace(regexp_replace(
             COALESCE(parent.repository_remote,parent.repository_key,''),
             '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         WHERE corner.id=$1 AND corner.archived_at IS NULL
           AND fact.lifecycle->'pr'->>'headSha'=$2`,
        [cornerId, status.headSha],
      )
    ).rows[0];
    if (!target) return notAttempted('the merge target no longer matches the corner head or linked GitHub repository');
    if (!(await claimCornerMergeAttempt(this.database, cornerId, status.headSha, onBlocked)))
      return { status: 'not-attempted' };
    try {
      const result = await this.app.mergePullRequest(
        Number(target.installation_id),
        Number(target.repository_id),
        target.full_name,
        target.number,
        status.headSha,
      );
      if (result === 'queued') {
        await this.database.query(
          `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{mergeQueue}',
             jsonb_build_object('headSha',$2::text)),updated_at=now()
           WHERE corner_id=$1 AND merge_attempt_head=$2`, [cornerId, status.headSha],
        );
        await this.reconcileQueuedCorners(cornerId);
        this.onRoomChanged?.(cornerId);
        return { status: 'queued' };
      }
    } catch (error) {
      let pr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>> | undefined;
      const queueAttempted = record(error)?.queueAttempted === true;
      // A REST 4xx rejected the operation. Unlike a lost response, it cannot
      // hide an accepted merge; still require the matching unmerged PR read.
      const definiteRefusal = !queueAttempted && record(error)?.mergeAttempted === true && error instanceof GitHubHttpError
        && error.status >= 400 && error.status < 500;
      let confirmedUnqueued = definiteRefusal;
      try {
        const token = await this.app.installationToken(Number(target.installation_id), {
          repositoryIds: [Number(target.repository_id)],
        });
        pr = await this.app.readPullRequest(token.token, target.full_name, target.number);
        if (!pr.merged) {
          const queue = await this.app.readPullRequestQueue(token.token, target.full_name, target.number);
          confirmedUnqueued = !queue.entry;
          if (queue.entry && queue.headSha === status.headSha) {
            await this.database.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{mergeQueue}',
              jsonb_build_object('headSha',$2::text)),updated_at=now() WHERE corner_id=$1 AND merge_attempt_head=$2`,
              [cornerId, status.headSha]);
            await this.reconcileQueuedCorners(cornerId);
            this.onRoomChanged?.(cornerId);
            return { status: 'queued' };
          }
        }
      } catch (readError) {
        console.error(`[server] merge outcome read failed for ${cornerId}:`, readError);
      }
      if (pr?.merged && pr.headSha === status.headSha && pr.headRef === target.feature_branch) {
        await this.recordConfirmedCornerMerge(target, target.full_name, target.number, pr);
        return { status: 'started' };
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (queueAttempted && !confirmedUnqueued) {
        // Leave the review-stage claim recoverable when enqueue acceptance
        // cannot yet be read, rather than inscribing a terminal refusal.
        return { status: 'refused', reason };
      }
      await advanceCorner(this.database, cornerId, {
        kind: 'merge-refused',
        headSha: status.headSha,
        confirmedUnmerged: confirmedUnqueued && pr?.merged === false
          && pr.headSha === status.headSha && pr.headRef === target.feature_branch,
        reason,
      });
      this.onRoomChanged?.(cornerId);
      return { status: 'refused', reason };
    }
    // Do not depend on delivery of the closed webhook after a successful
    // merge. A failed confirmation leaves the claim for background recovery.
    try {
      const token = await this.app.installationToken(Number(target.installation_id), {
        repositoryIds: [Number(target.repository_id)],
      });
      const pr = await this.app.readPullRequest(token.token, target.full_name, target.number);
      if (pr.merged && pr.headSha === status.headSha && pr.headRef === target.feature_branch)
        await this.recordConfirmedCornerMerge(target, target.full_name, target.number, pr);
    } catch (error) {
      console.error(`[server] merged corner confirmation deferred for ${cornerId}:`, error);
    }
    return { status: 'started' };
  }

  /**
   * Close a corner's own pull request without merging (`close_pull_request`).
   * The branch and its commits stay on GitHub. Clearing the recorded PR keeps
   * active corners open and repairs legacy archived corners without reopening
   * them. The merge gate reads "no pull request" until a new one opens.
   */
  async closeCornerPullRequest(
    cornerId: string,
  ): Promise<
    | { status: 'closed'; number: number; url: string; title: string }
    | { status: 'blocked'; blocker: string }
  > {
    const target = (
      await this.database.query<{
        number: number | null;
        url: string | null;
        title: string | null;
        repository_id: string | null;
        installation_id: string | null;
        full_name: string | null;
      }>(
        `SELECT (fact.lifecycle->'pr'->>'number')::int number,fact.lifecycle->'pr'->>'url' url,
           fact.lifecycle->'pr'->>'title' title,
           repository.repository_id,repository.installation_id,repository.full_name
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         LEFT JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
           AND repository.active AND lower(repository.full_name)=lower(regexp_replace(regexp_replace(
             COALESCE(parent.repository_remote,parent.repository_key,''),
             '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         WHERE corner.id=$1 AND fact.workflow_state IS DISTINCT FROM 'landed'`,
        [cornerId],
      )
    ).rows[0];
    if (!target) return { status: 'blocked', blocker: 'no corner found' };
    if (!target.number || !target.url)
      return { status: 'blocked', blocker: 'the corner has no pull request' };
    if (!target.repository_id || !target.installation_id || !target.full_name)
      return { status: 'blocked', blocker: 'the GitHub app cannot reach this repository' };
    await this.app.closePullRequest(
      Number(target.installation_id),
      Number(target.repository_id),
      target.full_name,
      target.number,
    );
    await this.recordClosedCornerPullRequest(cornerId, target.number);
    return {
      status: 'closed',
      number: target.number,
      url: target.url,
      title: target.title ?? `Pull request #${target.number}`,
    };
  }

  /** PR association and run state move together for tool calls and GitHub facts. */
  private async recordClosedCornerPullRequest(
    cornerId: string,
    number: number,
    database: SqlDatabase = this.database,
  ): Promise<void> {
    let changed = false;
    await database.transaction(async db => {
      await lockCornerLifecycle(db, cornerId);
      const removed = await db.query<{ archived: boolean }>(
        `UPDATE corner_facts fact SET merge_attempt_head=NULL,
           lifecycle=(lifecycle-'pr'-'mergeQueue'-'mergeRecovery'-'checksSummary')||
             CASE WHEN corner.archived_at IS NULL THEN '{"lifecycle":"working","checks":"unknown"}'::jsonb
               ELSE '{}'::jsonb END,
           updated_at=now()
         FROM rooms corner WHERE fact.corner_id=$1 AND corner.id=fact.corner_id
           AND fact.workflow_state IS DISTINCT FROM 'landed'
           AND (fact.lifecycle->'pr'->>'number')::int=$2
         RETURNING corner.archived_at IS NOT NULL archived`,
        [cornerId, number],
      );
      if (!removed.rowCount) return;
      changed = true;
      await db.query(`DELETE FROM corner_merge_approvals WHERE corner_id=$1 AND pull_request_number=$2`, [cornerId, number]);
      if (!removed.rows[0]!.archived)
        await advanceCorner(db, cornerId, { kind: 'pull-request-closed', number });
    });
    if (changed) this.onRoomChanged?.(cornerId);
  }

  /** Caller is authorized by DaemonService: it reaches the corner. */
  async readCornerPullRequest(cornerId: string): Promise<CornerPullRequestResult> {
    const corner = (
      await this.database.query<{ parent_id: string; number: number | null }>(
        `SELECT corner.parent_id,(fact.lifecycle->'pr'->>'number')::int number
         FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE corner.id=$1 AND corner.parent_id IS NOT NULL`,
        [cornerId],
      )
    ).rows[0];
    if (!corner) return { status: 'blocked', blocker: 'corner not found' };
    if (!corner.number) return { status: 'blocked', blocker: 'the corner has no pull request' };
    const target = await this.roomWorkflowTarget(corner.parent_id);
    const [pr, discussion] = await Promise.all([
      this.app.readPullRequest(target.token, target.repository, corner.number),
      this.app.readPullRequestDiscussion(target.token, target.repository, corner.number),
    ]);
    return {
      status: 'ok',
      number: pr.number,
      url: pr.url,
      ...(pr.title ? { title: pr.title } : {}),
      headSha: pr.headSha,
      merged: pr.merged,
      ...discussion,
    };
  }

  async processWebhook(event: string, payload: unknown, deliveryId?: string) {
    const release = await this.#webhooks.acquire();
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const body = payload as Record<string, unknown>;
      // The authenticated phone route uses this internal signal after a human message commits.
      if (event === 'beeline:human-message' && typeof body.cornerId === 'string') {
        await this.recoverUnfinishedMergeClaims(body.cornerId);
        return;
      }
      if (event === 'merge_group') {
        await this.reconcileQueuedCorners();
        return;
      }
      const installation = body.installation;
      if (!installation || typeof installation !== 'object' || Array.isArray(installation)) return;
      const install = installation as Record<string, unknown>;
      if (typeof install.id !== 'number') return;
      if (deliveryId) {
        const changed = await fireRepositorySubscriptions(this.database, install.id, event, body, deliveryId);
        for (const roomId of new Set(changed)) this.onRoomChanged?.(roomId);
      }
      if (
        event === 'push' ||
        event === 'issues' ||
        event === 'pull_request' ||
        event === 'check_run' ||
        event === 'check_suite' ||
        event === 'status'
      ) {
        await this.processRepositoryEvent(event, body, install.id);
        await this.processCornerEvent(event, body, install.id);
        if (event === 'push') await this.processBaseBranchPush(body, install.id);
        await this.reconcileQueuedCorners();
        return;
      }
      // Only installation and repository lifecycle events change the catalog.
      // Other subscribed webhook types must not turn every delivery into a
      // full GitHub refresh and repository-change wake for every bound Room.
      if (event !== 'installation' && event !== 'installation_repositories' && event !== 'repository') return;
      if (event === 'installation' && body.action === 'deleted') {
        await this.database.query(
          `UPDATE github_installations SET status='revoked',updated_at=now() WHERE installation_id=$1`,
          [install.id],
        );
        await this.database.query(
          `UPDATE github_repositories SET active=false,updated_at=now() WHERE installation_id=$1`,
          [install.id],
        );
        return;
      }
      if (event === 'installation' && body.action === 'suspend') {
        await this.database.query(
          `UPDATE github_installations SET status='suspended',updated_at=now()
           WHERE installation_id=$1 AND status<>'revoked'`,
          [install.id],
        );
        return;
      }
      const existing = (
        await this.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM github_installations WHERE installation_id=$1`,
          [install.id],
        )
      ).rows[0]?.owner_id;
      let owner = existing;
      if (!owner && event === 'installation') {
        const sender = body.sender;
        if (
          sender &&
          typeof sender === 'object' &&
          !Array.isArray(sender) &&
          typeof (sender as Record<string, unknown>).id === 'number'
        )
          owner = (
            await this.database.query<{ identity_id: string }>(
              `SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject=$1`,
              [String((sender as Record<string, unknown>).id)],
            )
          ).rows[0]?.identity_id;
      }
      if (!owner) return;
      if (event === 'installation_repositories') {
        const removed = Array.isArray(body.repositories_removed) ? body.repositories_removed : [];
        const removedIds = removed.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const id = (entry as Record<string, unknown>).id;
          return typeof id === 'number' && Number.isSafeInteger(id) ? [id] : [];
        });
        if (removedIds.length) {
          await this.database.query(
            `UPDATE github_repositories SET active=false,updated_at=now() WHERE installation_id=$1 AND repository_id=ANY($2::bigint[])`,
            [install.id, removedIds],
          );
        }
      }
      await this.syncInstallation(owner, install.id);
    } finally {
      release();
    }
  }

  /** One startup pass for repository corners whose first GitHub events were missed. */
  async repairPromotedCornerBranches(): Promise<void> {
    const candidates = await this.database.query<{
      corner_id: string;
      repository: string;
      repository_id: string;
      installation_id: string;
      branch: string;
    }>(
      `SELECT corner.id corner_id,github.full_name repository,
              github.repository_id,github.installation_id,
              'feature/corner-' || left(replace(corner.id::text,'-',''),12) branch
       FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_facts fact ON fact.corner_id=corner.id
       JOIN github_repositories github ON github.installation_id=parent.github_installation_id
         AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND fact.lifecycle->'pr' IS NULL
         AND (fact.lifecycle->>'branch' IS NULL OR fact.lifecycle->>'branch'=
           'feature/corner-' || left(replace(corner.id::text,'-',''),12))
         AND fact.feature_branch IS DISTINCT FROM
           'feature/corner-' || left(replace(corner.id::text,'-',''),12)`,
    );
    for (const candidate of candidates.rows) {
      try {
        const collisions = await this.database.query(
          `SELECT 1 FROM rooms corner
           JOIN rooms parent ON parent.id=corner.parent_id
           WHERE corner.id<>$1 AND corner.archived_at IS NULL AND parent.archived_at IS NULL
             AND parent.github_installation_id=$2
             AND left(replace(corner.id::text,'-',''),12)=$3
             AND lower(regexp_replace(regexp_replace(
               COALESCE(parent.repository_remote,parent.repository_key,''),
               '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($4)
           LIMIT 1`,
          [candidate.corner_id, candidate.installation_id, candidate.branch.slice(-12), candidate.repository],
        );
        if (collisions.rowCount) continue;
        const duplicate = await this.database.query(
          `SELECT 1 FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
           JOIN rooms parent ON parent.id=corner.parent_id
           WHERE fact.feature_branch=$1 AND fact.corner_id<>$2
             AND parent.github_installation_id=$3
             AND lower(regexp_replace(regexp_replace(
               COALESCE(parent.repository_remote,parent.repository_key,''),
               '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($4)`,
          [candidate.branch, candidate.corner_id, candidate.installation_id, candidate.repository],
        );
        if (duplicate.rowCount) continue;
        const token = await this.app.installationToken(Number(candidate.installation_id), {
          repositoryIds: [Number(candidate.repository_id)],
        });
        const headSha = await this.app.readBranchHead(token.token, candidate.repository, candidate.branch);
        const numbers = await this.app.openPullRequestsForBranch(
          token.token, candidate.repository, candidate.branch,
        );
        if (numbers.length > 1) continue;
        const pr = numbers.length === 1
          ? await this.app.readPullRequest(token.token, candidate.repository, numbers[0]!)
          : undefined;
        if (pr && (pr.headRef !== candidate.branch || pr.headSha !== headSha || !pr.baseRef))
          continue;
        const claimed = await this.database.query(
          `UPDATE corner_facts SET feature_branch=$2,
             lifecycle=jsonb_set(COALESCE(lifecycle,'{}'::jsonb),'{branch}',to_jsonb($2::text),true),
             updated_at=now()
           WHERE corner_id=$1 AND lifecycle->'pr' IS NULL
             AND (lifecycle->>'branch' IS NULL OR lifecycle->>'branch'=$2)
           RETURNING corner_id`,
          [candidate.corner_id, candidate.branch],
        );
        if (!claimed.rowCount) continue;
        if (pr) {
          await this.processWebhook('pull_request', {
            action: 'opened', installation: { id: Number(candidate.installation_id) },
            repository: { full_name: candidate.repository },
            pull_request: {
              number: pr.number, html_url: pr.url, title: pr.title ?? 'Pull request',
              head: { ref: pr.headRef, sha: pr.headSha },
              base: { ref: pr.baseRef, sha: pr.baseSha },
              mergeable_state: pr.mergeability,
            },
          });
        }
        await this.processWebhook('check_run', {
          action: 'in_progress', installation: { id: Number(candidate.installation_id) },
          repository: { full_name: candidate.repository },
          check_run: {
            name: 'GitHub checks', status: 'in_progress', head_sha: headSha,
            check_suite: { head_branch: candidate.branch, head_sha: headSha },
          },
        });
      } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) continue;
        console.error(`[github] repository corner ${candidate.corner_id} repair failed:`, error);
      }
    }
  }

  /**
   * Retry GitHub's asynchronous mergeability calculation for open corner PRs,
   * and re-read a stored 'dirty' PR so a conflict that GitHub has since
   * cleared stops re-firing the merge-conflict wake. An addressed refresh also
   * checks previously clean verdicts: checks can finish after the base moves
   * without a pull-request webhook carrying the new conflict.
   */
  async refreshStaleMergeability(
    cornerId?: string,
    confirmedPr?: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>,
  ): Promise<void> {
    const rows = await this.database.query<{
      corner_id: string;
      repository: string;
      repository_id: string;
      installation_id: string;
      number: number;
      head_sha: string;
      author_id: string;
      title: string;
      url: string;
      base_sha: string | null;
      target_branch: string;
    }>(
      `SELECT fact.corner_id,github.full_name repository,github.repository_id,
              github.installation_id,(fact.lifecycle->'pr'->>'number')::integer number,
              fact.lifecycle->'pr'->>'headSha' head_sha,
              COALESCE(fact.owner_agent_id,corner.created_by) author_id,
              fact.lifecycle->'pr'->>'title' title,fact.lifecycle->'pr'->>'url' url,
              fact.lifecycle->'pr'->>'baseSha' base_sha,
              fact.lifecycle->'pr'->>'targetBranch' target_branch
       FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN github_repositories github ON github.installation_id=parent.github_installation_id
         AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND COALESCE(fact.owner_agent_id,corner.created_by) IS NOT NULL
         AND ($1::uuid IS NOT NULL OR fact.lifecycle->'pr'->>'mergeability' IN ('unknown','dirty'))
         AND fact.lifecycle->'pr'->>'number' ~ '^[0-9]+$'
         AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL
         AND ($1::uuid IS NULL OR fact.corner_id=$1)`,
      [cornerId ?? null],
    );
    for (const row of rows.rows) {
      try {
        const token = await this.app.installationToken(Number(row.installation_id), {
          repositoryIds: [Number(row.repository_id)],
        });
        const pr = cornerId && confirmedPr?.number === row.number
          ? confirmedPr
          : await this.app.readPullRequest(token.token, row.repository, row.number);
        if (pr.mergeability === 'unknown') continue;
        const staleBase = Boolean(
          row.base_sha &&
            row.base_sha !== pr.baseSha &&
            (!pr.baseSha ||
              (await this.app.readBranchHead(token.token, row.repository, row.target_branch)) !==
                pr.baseSha),
        );
        // GitHub can leave a conflicting PR's base sha behind the branch head
        // indefinitely. A conflict is still reported against the base already
        // recorded; any other verdict waits for GitHub to reach that base.
        if (staleBase && pr.mergeability !== 'dirty') continue;
        const baseSha = staleBase ? row.base_sha! : pr.baseSha;
        await this.database.transaction(async (tx) => {
          const current = (
            await tx.query<{ lifecycle: CornerLifecycleView }>(
              `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
              [row.corner_id],
            )
          ).rows[0]?.lifecycle;
          if (
            !current?.pr ||
            current.pr.number !== row.number ||
            current.pr.headSha !== pr.headSha ||
            (current.pr.baseSha ?? null) !== row.base_sha ||
            (!cornerId && current.pr.mergeability !== 'unknown' && current.pr.mergeability !== 'dirty')
          )
            return;
          await this.updateLifecycle(
            row.corner_id,
            {
              pr: {
                ...current.pr,
                mergeability: pr.mergeability,
                ...(baseSha ? { baseSha } : {}),
              },
            },
            tx,
          );
          if (pr.mergeability !== 'dirty') return;
          const conflictKey = mergeConflictKey(row.number, pr.headSha);
          const note = await systemLine(tx, {
            id: hash(`beeline:${row.corner_id}:github:${conflictKey}`),
            roomId: row.corner_id,
            authorId: row.author_id,
            subject: GITHUB_SUBJECT,
            verb: 'found merge conflicts in',
            object: {
              text: row.title ?? `pull request #${row.number}`,
              url: row.url,
              headSha: pr.headSha,
            },
            cardType: 'github-corner-note',
            card: { source: 'github', dedupe: conflictKey },
          });
          await queueCornerMergeConflict(tx, row.corner_id, note.id);
          if (note.inserted) this.onRoomChanged?.(row.corner_id);
        });
      } catch (error) {
        console.error(`[server] mergeability refresh failed for corner ${row.corner_id}:`, error);
      }
    }
  }

  /** Reconcile committed queue facts against GitHub; never enqueue from a wake. */
  async reconcileQueuedCorners(cornerId?: string): Promise<void> {
    const rows = (await this.database.query<CornerWebhookTarget & {
      repository: string; number: number; head_sha: string; combined_sha: string | null;
    }>(`SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
      COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) author_id,fact.objective summary,
      repository.repository_id,repository.installation_id,repository.full_name repository,
      (fact.lifecycle->'pr'->>'number')::int number,
      fact.lifecycle->'mergeQueue'->>'headSha' head_sha,
      fact.lifecycle->'mergeQueue'->>'combinedSha' combined_sha
      FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
      JOIN rooms parent ON parent.id=corner.parent_id
      JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
        AND repository.active AND lower(repository.full_name)=lower(regexp_replace(regexp_replace(
          COALESCE(parent.repository_remote,parent.repository_key,''),
          '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
      WHERE corner.archived_at IS NULL AND fact.lifecycle ? 'mergeQueue'
        AND ($1::uuid IS NULL OR corner.id=$1)`, [cornerId ?? null])).rows;
    for (const row of rows) {
      try {
        const token = await this.app.installationToken(Number(row.installation_id), {
          repositoryIds: [Number(row.repository_id)], permissions: { contents: 'write', pull_requests: 'write' },
        });
        const pr = await this.app.readPullRequest(token.token, row.repository, row.number);
        if (pr.merged) {
          if (pr.headSha === row.head_sha) await this.recordConfirmedCornerMerge(row, row.repository, row.number, pr);
          continue;
        }
        const queue = await this.app.readPullRequestQueue(token.token, row.repository, row.number);
        const gate = await cornerMergeGate(this.database, row.corner_id, { number: row.number, headSha: row.head_sha });
        if (queue.entry && gate.open && queue.headSha === row.head_sha) {
          await this.database.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{mergeQueue,combinedSha}',to_jsonb($3::text))
            WHERE corner_id=$1 AND lifecycle->'mergeQueue'->>'headSha'=$2`,
            [row.corner_id, row.head_sha, queue.entry.headCommit?.oid ?? row.combined_sha ?? '']);
          continue;
        }
        if (queue.entry) await this.app.dequeuePullRequest(token.token, queue.id);
        const combined = queue.entry?.headCommit?.oid ?? row.combined_sha;
        const rollup = combined ? await this.app.readCommitCheckRollup(token.token, row.repository, combined) : undefined;
        const reason = !gate.open ? 'Removed from the merge queue because approval was withdrawn or a hold stands'
          : `Removed from the merge queue: ${rollup?.failing.join(', ') || 'GitHub removed the entry before merging'}`;
        await this.database.transaction(async db => {
          await lockCornerLifecycle(db, row.corner_id);
          const changed = await db.query(`UPDATE corner_facts SET lifecycle=lifecycle-'mergeQueue',updated_at=now()
            WHERE corner_id=$1 AND lifecycle->'mergeQueue'->>'headSha'=$2 RETURNING 1`, [row.corner_id, row.head_sha]);
          if (!changed.rowCount) return;
          await advanceCorner(db, row.corner_id, { kind: 'merge-refused', headSha: row.head_sha, confirmedUnmerged: true, reason });
        });
        this.onRoomChanged?.(row.corner_id);
      } catch (error) {
        console.error(`[github] queue reconciliation failed for ${row.corner_id}:`, error);
      }
    }
  }

  /** The leader recovers unfinished claims; it never sends a merge itself. */
  async recoverUnfinishedMergeClaims(cornerId?: string): Promise<void> {
    await this.reconcileQueuedCorners(cornerId);
    for (const claim of await unfinishedCornerMergeClaims(this.database, cornerId)) {
      try {
        const target = (await this.database.query<CornerWebhookTarget & { repository: string; branch: string }>(
          `SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
             COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) author_id,fact.objective summary,
             github.repository_id,github.installation_id,github.full_name repository,fact.feature_branch branch
           FROM rooms corner JOIN rooms parent ON parent.id=corner.parent_id
           JOIN corner_facts fact ON fact.corner_id=corner.id
           JOIN github_repositories github ON github.installation_id=parent.github_installation_id
             AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
               COALESCE(parent.repository_remote,parent.repository_key,''),
               '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
           WHERE corner.id=$1 AND fact.feature_branch IS NOT NULL`, [claim.corner_id],
        )).rows[0];
        if (!target) throw new Error(`Repository target unavailable for PR #${claim.number}`);
        const token = await this.app.installationToken(Number(target.installation_id), {
          repositoryIds: [Number(target.repository_id)],
        });
        const pr = await this.app.readPullRequest(token.token, target.repository, claim.number);
        if (pr.merged) {
          if (pr.headRef !== target.branch || pr.headSha !== claim.head_sha)
            throw new Error(`Merged PR #${claim.number} does not match the claimed branch and head`);
          await this.recordConfirmedCornerMerge(target, target.repository, claim.number, pr, claim.head_sha);
        } else {
          // An enqueue may have succeeded just before the process lost its
          // response. Keep that claim and recover the provider's queued fact.
          const queue = await this.app.readPullRequestQueue(token.token, target.repository, claim.number);
          if (queue.entry && queue.headSha === claim.head_sha) {
            await this.database.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{mergeQueue}',
              jsonb_build_object('headSha',$2::text)),updated_at=now() WHERE corner_id=$1 AND merge_attempt_head=$2`,
              [claim.corner_id, claim.head_sha]);
            await this.reconcileQueuedCorners(claim.corner_id);
            continue;
          }
          // Only a fresh explicit gated request can attempt another merge.
          await clearUnfinishedCornerMergeClaim(this.database, claim.corner_id, claim.head_sha, claim.number);
        }
      } catch (error) {
        const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.database.transaction(async db => {
          await lockCornerLifecycle(db, claim.corner_id);
          const row = (await db.query<{ attempts: number }>(
            `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{mergeRecovery}',jsonb_build_object(
               'attempts',COALESCE((lifecycle->'mergeRecovery'->>'attempts')::int,0)+1,
               'lastAttemptAt',extract(epoch FROM clock_timestamp()),'lastError',$4::text,
               'nextAttemptAt',extract(epoch FROM clock_timestamp())+LEAST(3600,
                 300*power(2,LEAST(4,COALESCE((lifecycle->'mergeRecovery'->>'attempts')::int,0))))))
             WHERE corner_id=$1 AND merge_attempt_head=$2 AND (lifecycle->'pr'->>'number')::int=$3
             RETURNING (lifecycle->'mergeRecovery'->>'attempts')::int attempts`,
            [claim.corner_id, claim.head_sha, claim.number, lastError],
          )).rows[0];
          if (row?.attempts === 5)
            await advanceCorner(db, claim.corner_id, { kind: 'merge-unconfirmed', number: claim.number, error: lastError });
        });
        this.onRoomChanged?.(claim.corner_id);
        console.error(`[server] unfinished merge recovery failed for ${claim.corner_id}:`, lastError);
      }
    }
  }

  private async recordConfirmedCornerMerge(
    target: CornerWebhookTarget, repository: string, number: number,
    pr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>, unfinishedClaimHead?: string,
  ) {
    if (!pr.headRef) return;
    await this.mergeCorner(target, {
      repository, branch: pr.headRef, number, url: pr.url,
      title: pr.title ?? `Pull request #${number}`, targetBranch: pr.baseRef, headSha: pr.headSha,
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
      ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
      ...(pr.mergedBy ? { mergedBy: pr.mergedBy } : {}),
      commits: 0, files: 0,
    }, this.database, number, unfinishedClaimHead);
  }

  /** Recover merged or unmerged closed PRs when GitHub's close webhook was missed. */
  async reconcileMergedCorners(): Promise<void> {
    const candidates = await this.database.query<
      CornerWebhookTarget & {
        repository: string;
        branch: string;
        number: number;
        title: string;
        target_branch: string;
      }
    >(
      `SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
              COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) author_id,
              fact.objective summary,github.repository_id,github.installation_id,
              github.full_name repository,fact.feature_branch branch,
              (fact.lifecycle->'pr'->>'number')::integer number,
              fact.lifecycle->'pr'->>'title' title,
              fact.lifecycle->'pr'->>'targetBranch' target_branch
       FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_facts fact ON fact.corner_id=corner.id
       JOIN github_repositories github ON github.installation_id=parent.github_installation_id
         AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) IS NOT NULL
         AND fact.feature_branch IS NOT NULL
         AND fact.lifecycle->'pr'->>'mergedAt' IS NULL
         AND fact.lifecycle->'pr'->>'number' ~ '^[1-9][0-9]*$'`,
    );
    for (const candidate of candidates.rows) {
      try {
        const token = await this.app.installationToken(Number(candidate.installation_id), {
          repositoryIds: [Number(candidate.repository_id)],
        });
        const pr = await this.app.readPullRequest(
          token.token,
          candidate.repository,
          candidate.number,
        );
        if (pr.headRef !== candidate.branch) continue;
        if (!pr.merged) {
          if (pr.state === 'closed') await this.recordClosedCornerPullRequest(candidate.corner_id, candidate.number);
          continue;
        }
        await this.mergeCorner(
          candidate,
          {
            repository: candidate.repository,
            branch: candidate.branch,
            title: pr.title ?? candidate.title ?? `Pull request #${candidate.number}`,
            url: pr.url,
            number: candidate.number,
            targetBranch: pr.baseRef ?? candidate.target_branch,
            headSha: pr.headSha,
            ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
            ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
            ...(pr.mergedBy ? { mergedBy: pr.mergedBy } : {}),
            commits: 0,
            files: 0,
          },
          this.database,
          candidate.number,
        );
      } catch (error) {
        console.error(
          `[server] merged corner reconciliation failed for ${candidate.corner_id}:`,
          error,
        );
      }
    }
  }

  private async processBaseBranchPush(body: GitHubRecord, installationId: number): Promise<void> {
    const repository = repositoryName(body);
    const branch = branchForEvent('push', body);
    const deliveredSha = text(body.after);
    if (
      !repository ||
      !branch ||
      !deliveredSha ||
      !/^[a-f0-9]{40,64}$/i.test(deliveredSha) ||
      /^0+$/.test(deliveredSha)
    )
      return;
    const affected = await this.database.query<{
      corner_id: string;
      repository_id: string;
      base_sha: string | null;
      head_sha: string;
    }>(
      `SELECT fact.corner_id,github.repository_id,
              fact.lifecycle->'pr'->>'baseSha' base_sha,
              fact.lifecycle->'pr'->>'headSha' head_sha
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN github_repositories github ON github.installation_id=$1
         AND lower(github.full_name)=lower($2) AND github.active
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND parent.github_installation_id=$1
         AND lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)
         AND fact.lifecycle->'pr'->>'targetBranch'=$3
         AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL`,
      [installationId, repository, branch],
    );
    if (!affected.rows.length) return;
    const token = await this.app.installationToken(installationId, {
      repositoryIds: [Number(affected.rows[0]!.repository_id)],
    });
    const baseSha = await this.app.readBranchHead(token.token, repository, branch);
    for (const row of affected.rows) {
      let changed = false;
      await this.database.transaction(async (tx) => {
        const lifecycle = (
          await tx.query<{ lifecycle: CornerLifecycleView }>(
            `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
            [row.corner_id],
          )
        ).rows[0]?.lifecycle;
        if (
          !lifecycle?.pr ||
          lifecycle.pr.targetBranch !== branch ||
          lifecycle.pr.headSha !== row.head_sha ||
          (lifecycle.pr.baseSha ?? null) !== row.base_sha ||
          lifecycle.pr.baseSha === baseSha
        )
          return;
        await this.updateLifecycle(
          row.corner_id,
          {
            pr: { ...lifecycle.pr, baseSha, mergeability: 'unknown' },
          },
          tx,
        );
        changed = true;
      });
      if (changed) await this.refreshStaleMergeability(row.corner_id);
    }
  }

  /**
   * Room-level repository activity. Issues and pull requests post on
   * opened/closed. Raw pushes and CI do NOT post: commit churn and
   * mainline check results are not Room conversation. Corner PRs use the
   * same repository events; CI stays on processCornerEvent.
   */
  private async processRepositoryEvent(event: string, body: GitHubRecord, installationId: number, database: SqlDatabase = this.database) {
    if (event !== 'issues' && event !== 'pull_request') return;
    const repository = repositoryName(body);
    if (!repository) return;

    const actor = text(record(body.sender)?.login) || 'github';
    const action = text(body.action);
    if (action !== 'opened' && action !== 'closed') return;
    const subject = record(body[event === 'issues' ? 'issue' : 'pull_request']);
    const title = text(subject?.title)?.trim();
    const url = githubUrl(subject?.html_url);
    if (!title || !url) return;
    const merged = event === 'pull_request' && action === 'closed' && subject?.merged === true;
    const cardAction = merged ? 'merged' : action;
    const branch = event === 'pull_request' ? text(record(subject?.head)?.ref) : undefined;
    const headRepository = event === 'pull_request'
      ? text(record(record(subject?.head)?.repo)?.full_name)
      : undefined;
    const fallbackBranch = headRepository && headRepository.toLowerCase() !== repository.toLowerCase()
      ? null : branch ?? null;
    const targetBranch = event === 'pull_request' ? text(record(subject?.base)?.ref) : undefined;
    const card = {
      type: (event === 'issues' ? 'issue' : 'pull-request') as 'issue' | 'pull-request',
      action: cardAction,
      actor,
      title,
      url,
      ...(branch ? { branch } : {}),
      ...(targetBranch ? { targetBranch } : {}),
    };
    const dedupeKey = url;

    // Resolve the destination within each linked Room, including archived corners.
    const rooms = await database.query<{ room_id: string; author_id: string; corner_id: string | null }>(
      `SELECT room.id room_id,COALESCE(room.created_by,author.identity_id) author_id,
         destination.corner_id
       FROM rooms room
       LEFT JOIN LATERAL (
         SELECT corner.id corner_id FROM rooms corner
         JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE corner.parent_id=room.id AND $3::text IS NOT NULL
           AND (fact.lifecycle->'pr'->>'url'=$3 OR ($4::text IS NOT NULL AND
             (fact.feature_branch=$4 OR ($5::text ~ '^feature/corner-[0-9a-f]{12}$'
               AND left(replace(corner.id::text,'-',''),12)=right($5,12)))))
         ORDER BY corner.created_at,corner.id LIMIT 1
       ) destination ON true
       LEFT JOIN LATERAL(
         SELECT membership.identity_id FROM effective_memberships membership
         WHERE membership.room_id=room.id AND membership.removed_at IS NULL
         ORDER BY membership.joined_at LIMIT 1
       )author ON true
       WHERE room.parent_id IS NULL AND room.archived_at IS NULL
         AND room.github_installation_id=$1
         AND COALESCE(room.created_by,author.identity_id) IS NOT NULL
         AND lower(regexp_replace(regexp_replace(
           COALESCE(room.repository_remote,room.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)`,
      [installationId, repository, event === 'pull_request' ? url : null,
        fallbackBranch, fallbackBranch],
    );
    for (const room of rooms.rows) {
      const note = await systemLine(database, {
        id: hash(`beeline:${room.room_id}:github-event:${event}:${card.action}:${dedupeKey}`),
        roomId: room.room_id,
        authorId: room.author_id,
        subject: { kind: 'github', name: card.actor },
        verb: card.action,
        object: { text: card.title, url: card.url },
        presentation: 'card',
        cardType: 'github-event',
        card: { ...card, ...(room.corner_id ? { cornerId: room.corner_id } : {}) },
      });
      if (note.inserted) this.onRoomChanged?.(room.room_id);
    }
  }

  private async processCornerEvent(event: string, body: GitHubRecord, installationId: number) {
    const database = this.database;
    const repository = repositoryName(body);
    const branch = branchForEvent(event, body);
    if (!repository || !branch) return;
    const headRepository = event === 'pull_request'
      ? text(record(record(record(body.pull_request)?.head)?.repo)?.full_name)
      : undefined;
    const cornerPrefix = headRepository && headRepository.toLowerCase() !== repository.toLowerCase()
      ? null
      : /^feature\/corner-([0-9a-f]{12})$/.exec(branch)?.[1] ?? null;
    const matches = await this.database.query<CornerWebhookTarget & {
      feature_branch: string | null;
      lifecycle_branch: string | null;
      has_pr: boolean;
      pr_number: string | null;
    }>(
      `SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
         COALESCE(fact.owner_agent_id,first_agent.author_id,corner.created_by,parent.created_by) author_id,
         fact.objective summary,
         fact.feature_branch, fact.lifecycle->>'branch' lifecycle_branch,
         fact.lifecycle->'pr' IS NOT NULL has_pr,
         fact.lifecycle->'pr'->>'number' pr_number,
         github.repository_id,github.installation_id
       FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_facts fact ON fact.corner_id=corner.id
       JOIN github_repositories github ON github.installation_id=$1
         AND lower(github.full_name)=lower($2) AND github.active
       -- Opening a corner copies the parent's memberships, roles included, so an
       -- owner membership can name a parent owner such as Candy. Without a
       -- recorded owner, credit the first agent that spoke in the corner; system
       -- lines are skipped because their author came from this same fallback.
       LEFT JOIN LATERAL(
         SELECT message.author_id FROM messages message
         JOIN identities identity ON identity.id=message.author_id AND identity.kind='agent'
         WHERE message.room_id=corner.id AND message.system_event IS NULL
         ORDER BY message.created_at,message.id LIMIT 1
       )first_agent ON fact.owner_agent_id IS NULL
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND (fact.feature_branch=$3 OR ($4::text IS NOT NULL
           AND left(replace(corner.id::text,'-',''),12)=$4))
         AND parent.github_installation_id=$1
         AND lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)`,
      [installationId, repository, branch, cornerPrefix],
    );
    const exact = matches.rows.filter((target) => target.feature_branch === branch);
    let targets = exact;
    if (!exact.length && cornerPrefix) {
      const candidates = matches.rows.filter((target) =>
        !target.has_pr && (!target.lifecycle_branch || target.lifecycle_branch === branch),
      );
      // A prefix is only a recovery hint. It must identify one corner in this
      // installation and repository, and never displace another PR association.
      if (matches.rows.length === 1 && candidates.length === 1) {
        const candidate = candidates[0]!;
        const assignedElsewhere = await database.query(
          `SELECT 1 FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
           JOIN rooms parent ON parent.id=corner.parent_id
           WHERE fact.feature_branch=$1 AND fact.corner_id<>$2
             AND parent.github_installation_id=$3
             AND lower(regexp_replace(regexp_replace(
               COALESCE(parent.repository_remote,parent.repository_key,''),
               '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($4)
           LIMIT 1`,
          [branch, candidate.corner_id, installationId, repository],
        );
        if (!assignedElsewhere.rowCount) {
          await database.query(
            `UPDATE corner_facts SET feature_branch=$2,updated_at=now()
             WHERE corner_id=$1 AND feature_branch IS DISTINCT FROM $2`,
            [candidate.corner_id, branch],
          );
          targets = [candidate];
        }
      }
    }
    const actorLogin = text(record(body.sender)?.login);
    const actor = (login?: string) =>
      login ? { kind: 'github' as const, name: login } : GITHUB_SUBJECT;
    for (const target of targets) {
      if (!target.author_id) continue;
      if (event === 'pull_request') {
        const pullRequest = record(body.pull_request);
        const title =
          text(pullRequest?.title) ?? `Pull request #${integer(pullRequest?.number) ?? ''}`;
        const url = text(pullRequest?.html_url);
        const merged = body.action === 'closed' && pullRequest?.merged === true;
        const number = integer(pullRequest?.number);
        // A replacement can arrive before the previous close webhook.
        // Confirm both live states before replacing the association; delayed
        // events for an older PR must never displace its newer replacement.
        const recordedPrNumber = target.pr_number ? Number(target.pr_number) : undefined;
        if (recordedPrNumber && number && recordedPrNumber !== number) {
          if (number < recordedPrNumber || !['opened', 'reopened'].includes(String(body.action))) continue;
          const token = await this.app.installationToken(Number(target.installation_id), {
            repositoryIds: [Number(target.repository_id)],
          });
          const previous = await this.app.readPullRequest(token.token, repository, recordedPrNumber);
          if (previous.state !== 'closed' || previous.merged) continue;
          const replacement = await this.app.readPullRequest(token.token, repository, number);
          if (replacement.state !== 'open' || replacement.headRef !== branch) continue;
          await this.recordClosedCornerPullRequest(target.corner_id, recordedPrNumber, database);
        }
        const targetBranch = text(record(pullRequest?.base)?.ref);
        const webhookBaseSha = text(record(pullRequest?.base)?.sha);
        let headSha = text(record(pullRequest?.head)?.sha);
        // Reopening may be delivered after a push with the closed PR's old
        // head. Restore the association from GitHub, not that cached payload.
        if (body.action === 'reopened' && number) {
          const token = await this.app.installationToken(Number(target.installation_id), {
            repositoryIds: [Number(target.repository_id)],
          });
          const live = await this.app.readPullRequest(token.token, repository, number);
          if (live.state === 'closed' || live.merged) continue;
          headSha = live.headSha;
        }
        const mergeabilityValue = text(pullRequest?.mergeable_state);
        let mergeability = githubMergeability(mergeabilityValue);
        let differentPr = false;
        if (!merged && url && number && targetBranch && headSha && body.action !== 'closed') {
          await database.transaction(async (tx) => {
            const previous = (
              await tx.query<{ lifecycle: CornerLifecycleView }>(
                `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
                [target.corner_id],
              )
            ).rows[0]?.lifecycle;
            // Re-check under the row lock: a concurrent event must not have
            // recorded a different pull request since the branch match.
            if (previous?.pr?.number !== undefined && previous?.pr?.number !== number) {
              differentPr = true;
              return;
            }
            const sameHead = previous?.pr?.headSha === headSha;
            const staleBase = Boolean(
              sameHead && previous?.pr?.baseSha && previous.pr.baseSha !== webhookBaseSha,
            );
            if (staleBase) mergeability = previous!.pr!.mergeability ?? 'unknown';
            if (
              !staleBase &&
              mergeability === 'unknown' &&
              sameHead &&
              previous.pr.mergeability &&
              previous.pr.mergeability !== 'unknown'
            )
              mergeability = previous.pr.mergeability;
            const baseSha = staleBase
              ? previous!.pr!.baseSha
              : (webhookBaseSha ?? (sameHead ? previous?.pr?.baseSha : undefined));
            // A webhook's mergeable_state is a cached field. Never wake the
            // implementer from it; keep an unconfirmed verdict as unknown and
            // let refreshStaleMergeability confirm it against the live PR.
            await this.updateLifecycle(
              target.corner_id,
              {
                lifecycle: 'in-review',
                branch,
                pr: {
                  number,
                  url,
                  title,
                  targetBranch,
                  headSha,
                  mergeability: mergeability === 'dirty' ? 'unknown' : mergeability,
                  ...(baseSha ? { baseSha } : {}),
                },
              },
              tx,
            );
          });
          if (differentPr) continue;
          if (mergeability === 'unknown' || mergeability === 'dirty')
            await this.refreshStaleMergeability(target.corner_id);
          if (body.action === 'opened' || body.action === 'synchronize' || body.action === 'reopened')
            await this.refreshCheckRollup({ ...target, has_pr: true, pr_number: String(number) }, repository,
              { name: 'Pull request checks', status: 'pending', headSha, url }, database);
        }
        if (merged && url) {
          await this.mergeCorner(
            target,
            {
              repository,
              branch,
              title,
              url,
              ...(number ? { number } : {}),
              ...(targetBranch ? { targetBranch } : {}),
              ...(headSha ? { headSha } : {}),
              ...(text(pullRequest?.merged_at) ? { mergedAt: text(pullRequest?.merged_at)! } : {}),
              ...(text(pullRequest?.merge_commit_sha)
                ? { mergeCommitSha: text(pullRequest?.merge_commit_sha)! }
                : {}),
              ...(text(record(pullRequest?.merged_by)?.login)
                ? { mergedBy: text(record(pullRequest?.merged_by)?.login)! }
                : {}),
              commits: integer(pullRequest?.commits) ?? 0,
              files: integer(pullRequest?.changed_files) ?? 0,
            },
            database,
          );
        } else if (body.action === 'closed' && number) {
          await this.recordClosedCornerPullRequest(target.corner_id, number, database);
        } else if (body.action === 'opened' && url) {
          await this.systemNote(
            target.corner_id,
            target.author_id,
            {
              subject: actor(text(record(pullRequest?.user)?.login) ?? actorLogin),
              verb: 'opened a pull request',
              object: { text: title, url },
            },
            `github:pull-request:opened:${url}`,
            database,
          );
        }
        continue;
      }
      if (event === 'push') {
        // Deleting a branch emits an all-zero after SHA. It is not a new head.
        if (body.deleted === true || /^0+$/.test(text(body.after) ?? '')) continue;
        const compare = text(body.compare);
        const commits =
          integer(body.size) ?? (Array.isArray(body.commits) ? body.commits.length : 0);
        const head = text(body.after);
        if (head) {
          const lifecycle = await this.lifecycle(target.corner_id, database);
          await this.updateLifecycle(
            target.corner_id,
            {
              branch,
              checks: 'unknown',
              checksSummary: {
                status: 'unknown',
                total: 0,
                failing: [],
                checks: [],
                updatedAt: Math.floor((await database.query<{ now: number }>(`SELECT extract(epoch FROM clock_timestamp())::double precision now`)).rows[0]!.now),
              },
              ...(lifecycle.pr ? { pr: { ...lifecycle.pr, headSha: head } } : {}),
            },
            database,
          );
          await advanceCorner(database, target.corner_id, {
            kind: 'push',
            headSha: head,
            contents: {
              summary: `pushed to ${branch}`,
              headSha: head,
              ...(lifecycle.pr?.url ? { prUrl: lifecycle.pr.url } : {}),
            },
          });
        }
        await this.systemNote(
          target.corner_id,
          target.author_id,
          {
            subject: actor(text(record(body.pusher)?.name) ?? actorLogin),
            verb: 'pushed',
            object: {
              text: `${commits ? `${commits} commit${commits === 1 ? '' : 's'} to ` : ''}${branch}`,
              ...(compare ? { url: compare } : {}),
            },
            ...(head ? { consequence: `at ${head.slice(0, 12)}` } : {}),
          },
          `github:push:${text(body.after) ?? hash(JSON.stringify(body))}`,
          database,
        );
        continue;
      }
      const check = checkFact(event, body);
      if (check?.headSha) await this.refreshCheckRollup(target, repository, check, database);
    }
  }

  /** Drain persisted failed refreshes without needing another GitHub webhook. */
  async refreshQueuedChecks(): Promise<void> {
    const rows = await this.database.query<CornerWebhookTarget & {
      repository: string; pr_number: string; head_sha: string;
    }>(`SELECT fact.corner_id,corner.parent_id,corner.name corner_name,
        fact.owner_agent_id author_id,github.full_name repository,
        github.repository_id,github.installation_id,
        fact.lifecycle->'pr'->>'number' pr_number,
        fact.lifecycle->'checkRefreshRetry'->>'headSha' head_sha
      FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
      JOIN rooms parent ON parent.id=corner.parent_id
      JOIN github_repositories github ON github.installation_id=parent.github_installation_id
        AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
          COALESCE(parent.repository_remote,parent.repository_key,''),
          '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
      WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
        AND fact.lifecycle->'checkRefreshRetry'->>'headSha'=fact.lifecycle->'pr'->>'headSha'
        AND (fact.lifecycle->'checkRefreshRetry'->>'after')::double precision
          <= extract(epoch FROM clock_timestamp())
      ORDER BY fact.updated_at LIMIT 20`);
    for (const target of rows.rows) {
      // Lease the item in one committed statement; no lock spans a provider read.
      const claimed = await this.database.query(`UPDATE corner_facts SET lifecycle=jsonb_set(
          lifecycle,'{checkRefreshRetry,after}',to_jsonb(extract(epoch FROM clock_timestamp())+300))
        WHERE corner_id=$1 AND lifecycle->'checkRefreshRetry'->>'headSha'=$2
          AND lifecycle->'pr'->>'headSha'=$2
          AND (lifecycle->'checkRefreshRetry'->>'after')::double precision
            <= extract(epoch FROM clock_timestamp()) RETURNING corner_id`,
        [target.corner_id, target.head_sha]);
      if (!claimed.rowCount) continue;
      try {
        await this.refreshCheckRollup({ ...target, has_pr: true }, target.repository,
          { name: 'Pull request checks', status: 'pending', headSha: target.head_sha }, this.database);
      } catch (error) {
        if (!transientGitHubError(error)) {
          await this.database.query(`UPDATE corner_facts SET lifecycle=lifecycle-'checkRefreshRetry'
            WHERE corner_id=$1 AND lifecycle->'checkRefreshRetry'->>'headSha'=$2`,
            [target.corner_id, target.head_sha]);
        }
        if (error instanceof GitHubHttpError && error.rateLimited) continue;
        captureServerError(error, { background_job: 'github-check-refresh' });
        console.error('[github] queued check refresh failed:', error);
      }
    }
  }

  /**
   * Re-read open corners still stored as pending. A deploy uses this so a head
   * whose only unfinished suites are empty app placeholders moves on without
   * waiting for another check event. Corners that are actually still running
   * stay pending. One pass; a rate limit stops the pass and the next leader
   * tries again.
   */
  async refreshOpenPendingChecks(): Promise<void> {
    const rows = await this.database.query<CornerWebhookTarget & {
      repository: string; pr_number: string; head_sha: string;
    }>(`SELECT fact.corner_id,corner.parent_id,corner.name corner_name,
        '' AS summary,fact.owner_agent_id author_id,github.full_name repository,
        github.repository_id,github.installation_id,
        fact.lifecycle->'pr'->>'number' pr_number,
        fact.lifecycle->'pr'->>'headSha' head_sha
      FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
      JOIN rooms parent ON parent.id=corner.parent_id
      JOIN github_repositories github ON github.installation_id=parent.github_installation_id
        AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
          COALESCE(parent.repository_remote,parent.repository_key,''),
          '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
      WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
        AND fact.lifecycle->>'checks'='pending'
        AND fact.owner_agent_id IS NOT NULL
        AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL
        AND fact.lifecycle->'pr'->>'number' ~ '^[0-9]+$'
      ORDER BY fact.updated_at LIMIT 100`);
    for (const target of rows.rows) {
      try {
        await this.refreshCheckRollup(
          { ...target, has_pr: true, pr_number: target.pr_number },
          target.repository,
          { name: 'Pull request checks', status: 'pending', headSha: target.head_sha },
          this.database,
          { quiet: true },
        );
      } catch (error) {
        if (error instanceof GitHubHttpError && error.rateLimited) {
          console.error('[github] pending check re-read stopped on a rate limit');
          return;
        }
        captureServerError(error, { background_job: 'github-pending-checks' });
        console.error('[github] pending check re-read failed:', error);
      }
    }
  }

  private async refreshCheckRollup(
    target: CornerWebhookTarget & { has_pr?: boolean; pr_number?: string | null }, repository: string,
    check: NonNullable<ReturnType<typeof checkFact>>, database: SqlDatabase,
    options?: { quiet?: boolean },
  ) {
    const checkHeadSha = check.headSha!;
    let fetchStartedAt = 0;
    let confirmedPr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>> | undefined;
    try {
        // Use the database clock across server instances, with subsecond precision
        // to order overlapping fetches while keeping updatedAt in epoch seconds.
        fetchStartedAt = (await database.query<{ started_at: number }>(
          `SELECT extract(epoch FROM clock_timestamp())::double precision started_at`,
        )).rows[0]!.started_at;
        const token = await retryGitHubRead(() => this.app.installationToken(Number(target.installation_id), {
          repositoryIds: [Number(target.repository_id)],
        }));
        const rollup = await this.app.readCommitCheckRollup(token.token, repository, checkHeadSha);
        // A push can move GitHub's PR head before either its push or synchronize
        // webhook reaches us. The stored head alone cannot authorize a verdict.
        // A cancelled job (GitHub cancelled it before a runner picked it up:
        // no steps, and its log answers 404) carries no code verdict, so it is
        // never a repair wake. `conclusion` is checked as well as `status` so a
        // provider read that still maps CANCELLED to failed is also excluded.
        const interruptedNames = new Set(
          rollup.checks
            .filter(
              item =>
                item.status === 'cancelled' ||
                String(item.conclusion ?? '').toUpperCase() === 'CANCELLED',
            )
            .map(item => item.name),
        );
        const failedChecks = rollup.checks.filter(
          item => item.status === 'failed' && !interruptedNames.has(item.name),
        );
        const interruptedOnly = failedChecks.length === 0 && interruptedNames.size > 0;
        const livePr = target.pr_number && (rollup.state === 'passed' || rollup.state === 'failed' || failedChecks.length > 0)
          ? await retryGitHubRead(() => this.app.readPullRequest(token.token, repository, Number(target.pr_number)))
          : undefined;
        confirmedPr = livePr;
        if (livePr?.state === 'closed' && !livePr.merged) {
          await this.recordClosedCornerPullRequest(target.corner_id, Number(target.pr_number), database);
          return;
        }
        if (livePr && (livePr.merged || livePr.headSha !== checkHeadSha)) return;
        const beforeFetch = await this.lifecycle(target.corner_id, database);
        if (beforeFetch.pr?.headSha && beforeFetch.pr.headSha !== checkHeadSha) return;
        const oldReport = beforeFetch.checksSummary as (typeof beforeFetch.checksSummary & {
          reportedHeadSha?: string; reportedFailing?: readonly string[]; failureFollowupSent?: boolean; attempt?: number;
        }) | undefined;
        const restarting = checksRestarted(oldReport?.checks, rollup.checks);
        const alreadyReported = oldReport?.reportedHeadSha === checkHeadSha && !restarting
          ? oldReport.reportedFailing ?? [] : [];
        const candidateFailures = failedChecks.filter(item => !alreadyReported.includes(item.name));
        const logCandidates = candidateFailures.length &&
          (!alreadyReported.length || (checksSettled(rollup.checks) && !oldReport?.failureFollowupSent))
          ? candidateFailures : [];
        const jobLogs = await Promise.all(logCandidates.map(async item => {
          const jobId = actionsJobId(item.url);
          if (!jobId) return { name: item.name, ...(item.url ? { url: item.url } : {}) };
          try {
            const errorLines = jobErrorLines(await this.app.readJobLog(token.token, repository, jobId));
            return { name: item.name, url: item.url, jobId, ...(errorLines ? { errorLines } : {}) };
          } catch {
            return { name: item.name, url: item.url, jobId };
          }
        }));
        await database.transaction(async (database) => {
          await lockCornerLifecycle(database, target.corner_id);
          // Webhooks signal a refresh. Revalidate its head and age only after
          // the provider has replied, under the run lock then the fact row lock.
          const current = (
            await database.query<{ lifecycle: CornerLifecycleView & {
              checksSummary?: { fetchStartedAt?: number };
            } }>(
              `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
              [target.corner_id],
            )
          ).rows[0]?.lifecycle;
          if (!current) return;
          if (livePr && current.pr?.number !== livePr.number) return;
          // GitHub may deliver a completed run for the previous branch head after a push.
          if (current.pr?.headSha && checkHeadSha !== current.pr.headSha) return;
          // A PR removed during the fetch invalidates it; a pre-PR corner can record checks.
          if (target.has_pr && !current.pr?.headSha) return;
          const latestFetch = current.checksSummary?.fetchStartedAt ?? current.checksSummary?.updatedAt ?? 0;
          if (fetchStartedAt < latestFetch) return;
          // An empty rollup is only "no checks" once GitHub says so; a null
          // rollup (state pending) is the race before workflows register.
          await database.query(`UPDATE corner_facts SET lifecycle=lifecycle-'checkRefreshRetry'
            WHERE corner_id=$1 AND COALESCE((lifecycle->'checkRefreshRetry'->>'failedAt')::double precision,0)<=$2`,
            [target.corner_id, fetchStartedAt]);
          const summary = {
            status:
              failedChecks.length ? ('failing' as const) : rollup.total === 0 && rollup.state !== 'pending' ? ('unknown' as const) : rollup.state === 'passed'
                ? ('passing' as const)
                : rollup.state === 'failed' && interruptedOnly && checksSettled(rollup.checks)
                  ? ('unknown' as const)
                  : rollup.state === 'failed'
                    ? ('failing' as const)
                    : ('pending' as const),
            total: rollup.total,
            failing: failedChecks.length
              ? failedChecks.map(item => item.name)
              : rollup.failing.filter(name => !interruptedNames.has(name)),
            checks: rollup.checks,
            updatedAt: Math.floor(fetchStartedAt),
            fetchStartedAt,
          };
          const priorReport = current.checksSummary as (typeof current.checksSummary & {
            reportedHeadSha?: string; reportedFailing?: readonly string[]; failureFollowupSent?: boolean; attempt?: number;
          }) | undefined;
          const sameReportedHead = priorReport?.reportedHeadSha === checkHeadSha;
          const newAttempt = sameReportedHead && checksRestarted(priorReport.checks, summary.checks);
          const attempt = sameReportedHead ? (priorReport.attempt ?? 0) + (newAttempt ? 1 : 0) : 0;
          const reported = sameReportedHead && !newAttempt ? priorReport.reportedFailing ?? [] : [];
          const newFailures = summary.failing.filter(name => !reported.includes(name));
          const firstFailure = summary.status === 'failing' && newFailures.length > 0 && !reported.length;
          const followup = summary.status === 'failing' && reported.length > 0 &&
            checksSettled(summary.checks) && !checksSettled(priorReport?.checks ?? []) &&
            !(sameReportedHead && !newAttempt && priorReport.failureFollowupSent);
          const reportFailure = firstFailure || followup;
          const storedSummary = {
            ...summary,
            attempt,
            reportedHeadSha: checkHeadSha,
            reportedFailing: reportFailure ? [...reported, ...newFailures] : reported,
            failureFollowupSent: Boolean((sameReportedHead && !newAttempt && priorReport.failureFollowupSent) || followup),
          };
          await this.updateLifecycle(
            target.corner_id,
            {
              checks: summary.status,
              checksSummary: storedSummary,
            },
            database,
          );
          // A re-run on the same head reopens checks; its verdict is reported
          // by the check note below once it lands.
          if ((newAttempt && !checksSettled(summary.checks)) || (summary.status === 'pending' &&
            (current.checks === 'passing' || current.checks === 'failing')))
            await advanceCorner(database, target.corner_id, { kind: 'checks-pending' });
          const label =
            check.status === 'pending'
              ? 'started'
              : String(check.conclusion ?? '').toUpperCase() === 'CANCELLED'
                ? 'cancelled'
                : check.status;
          const becamePassing = summary.status === 'passing' && (current.checks !== 'passing' || !sameReportedHead || newAttempt);
          // The first failed job wakes immediately. Completion wakes once
          // more even when the same job still fails, so a promised rerun or
          // log read has a turn to finish it. Replays share the attempt's id.
          const becameFailing = reportFailure;
          // A green/red rollup is a property of the whole head, not of the one
          // check that happened to arrive last. Name the actual failing jobs
          // on a failure, so the implementer knows what to fix and a passing
          // check can never be described as the failure.
          const failing = reportFailure && newFailures.length ? newFailures : summary.failing?.length ? summary.failing : [check.name];
          if (!options?.quiet || becamePassing || becameFailing)
          await this.systemNote(
            target.corner_id,
            target.author_id,
            {
              subject: GITHUB_SUBJECT,
              verb: becameFailing ? 'found failing checks on' : `${label} a check`,
              // A check that is still running is not yet a fact to react to.
              ...(becamePassing
                ? { kind: 'check-passed' as const }
                : becameFailing
                  ? { kind: 'check-failed' as const }
                  : {}),
              object: becameFailing
                ? {
                    text:
                      current.pr?.title ??
                      (current.pr?.number ? `pull request #${current.pr.number}` : 'the pull request'),
                    ...(current.pr?.url ? { url: current.pr.url } : {}),
                    ...(check.headSha ? { headSha: check.headSha } : {}),
                  }
                : {
                    text: check.name,
                    ...(check.url ? { url: check.url } : {}),
                    ...(check.headSha ? { headSha: check.headSha } : {}),
                  },
              ...(becameFailing
                ? { consequence: `failing ${failing.join(', ')}` }
                : check.status === 'failed' && check.conclusion && check.conclusion !== 'failure'
                  ? { consequence: check.conclusion }
                  : {}),
              ...(becameFailing ? { payload: {
                failedJobs: jobLogs.filter(item => newFailures.includes(item.name)),
                // A failure in a run that still has jobs going cannot be
                // re-run on GitHub; the wake says so instead of implying a
                // repair is available now.
                ...(!checksSettled(summary.checks) ? { runInProgress: true } : {}),
                ...(followup || newAttempt ? { followup: true } : {}),
              } } : {}),
            },
            becamePassing
              ? `github:checks:green:${check.headSha}:${attempt}`
              : becameFailing
                ? `github:checks:failed:${check.headSha}:${attempt}:${followup ? 'followup' : 'first'}`
              : `github:checks:${label}:${check.name}:${check.headSha ?? hash(JSON.stringify(check))}`,
            database,
          );
          if (summary.status === 'failing' && !becameFailing)
            await reconcileCornerMergeBlockers(database, target.corner_id);
        });
    } catch (error) {
      if (transientGitHubError(error)) {
        await database.query(`UPDATE corner_facts SET lifecycle=jsonb_set(
            jsonb_set(jsonb_set(lifecycle,'{checks}','"pending"'::jsonb),
              '{checksSummary}',jsonb_build_object('total',0,'failing','[]'::jsonb,
                'checks','[]'::jsonb,'updatedAt',floor(extract(epoch FROM clock_timestamp()))) ||
                COALESCE(lifecycle->'checksSummary','{}'::jsonb) || '{"status":"pending"}'::jsonb),'{checkRefreshRetry}',
            jsonb_build_object('headSha',$2::text,'failedAt',extract(epoch FROM clock_timestamp()),
              'after',extract(epoch FROM clock_timestamp())+$3::double precision)),updated_at=now()
          WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2
            AND COALESCE((lifecycle->'checksSummary'->>'fetchStartedAt')::double precision,0)<=$4`,
          [target.corner_id, checkHeadSha, githubRetryDelay(error, 60_000) / 1000, fetchStartedAt]);
      }
      throw error;
    }
    await this.refreshStaleMergeability(target.corner_id, confirmedPr);
  }

  private async lifecycle(
    cornerId: string,
    database: SqlDatabase = this.database,
  ): Promise<CornerLifecycleView> {
    return (
      (
        await database.query<{ lifecycle: CornerLifecycleView }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0]?.lifecycle ?? { lifecycle: 'unknown', checks: 'unknown' }
    );
  }

  private async updateLifecycle(
    cornerId: string,
    patch: Partial<CornerLifecycleView>,
    database: SqlDatabase = this.database,
  ) {
    const previous = await this.lifecycle(cornerId, database);
    const lifecycle = { ...previous, ...patch };
    await database.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,
       updated_at=now() WHERE corner_id=$1`,
      [cornerId, JSON.stringify(lifecycle)],
    );
    // The outcome ledger records the TRANSITION, not the state: a corner that
    // was already green and is re-read green did not reach green again, and a
    // second row would move the measured cohort's clock for nothing.
    if (patch.checks === 'passing' && previous.checks !== 'passing') {
      await recordInstitutionalCornerOutcome(database, {
        cornerId,
        kind: 'ci_green',
        detail: { checks: 'passing' },
      });
    }
  }

  private async systemNote(
    roomId: string,
    authorId: string,
    phrase: SystemPhrase,
    dedupe: string,
    database: SqlDatabase = this.database,
  ) {
    const note = await systemLine(database, {
      id: hash(`beeline:${roomId}:${dedupe}`),
      roomId,
      authorId,
      ...phrase,
      cardType: 'github-corner-note',
      card: { source: 'github', dedupe },
    });
    if (note.inserted) this.onRoomChanged?.(roomId);
    // A previously written green fact can outlive a lost dispatch. Its note
    // remains idempotent, but the command routing must be retried.
    if (!note.inserted && (phrase.kind === 'check-passed' || phrase.kind === 'check-failed'))
      await routeSystemCommand(database, {
        roomId,
        sourceMessageId: note.id,
        kind: phrase.kind,
        targets: [],
        followup: phrase.kind === 'check-failed' &&
          Boolean((phrase.payload as { followup?: unknown } | undefined)?.followup),
      });
  }

  private async mergeCorner(
    target: CornerWebhookTarget,
    pullRequest: {
      repository: string;
      branch: string;
      title: string;
      url: string;
      number?: number;
      targetBranch?: string;
      headSha?: string;
      mergedAt?: string;
      mergeCommitSha?: string;
      mergedBy?: string;
      commits: number;
      files: number;
    },
    database: SqlDatabase = this.database,
    expectedPrNumber?: number,
    unfinishedClaimHead?: string,
  ) {
    const mergeKey = `github:pull-request:merged:${pullRequest.url}`;
    let updated = false;
    await retryOnDeadlock(() => database.transaction(async (database) => {
      updated = false;
      await lockCornerLifecycle(database, target.corner_id);
      if (unfinishedClaimHead) {
        const claim = (await unfinishedCornerMergeClaims(database, target.corner_id))[0];
        if (claim?.head_sha !== unfinishedClaimHead || claim.number !== expectedPrNumber) return;
      }
      const current = (
        await database.query<{ lifecycle: CornerLifecycleView; feature_branch: string | null; locked: boolean }>(
          `SELECT lifecycle,feature_branch,locked FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
          [target.corner_id],
        )
      ).rows[0];
      if (unfinishedClaimHead && current?.feature_branch !== pullRequest.branch) return;
      const currentLifecycle = current?.lifecycle;
      if (expectedPrNumber && currentLifecycle?.pr?.number !== expectedPrNumber) return;
      // The branch lookup runs outside this transaction, so a second pull
      // request on the same branch can be recorded between the lookup and this
      // lock. Never archive a corner for a number it has since replaced.
      const recordedPrNumber = currentLifecycle?.pr?.number;
      if (
        pullRequest.number !== undefined &&
        recordedPrNumber !== undefined &&
        recordedPrNumber !== pullRequest.number
      )
        return;
      const currentPr = currentLifecycle?.pr;
      const mergedPr =
        currentPr ??
        (pullRequest.number && pullRequest.targetBranch && pullRequest.headSha
          ? {
              number: pullRequest.number,
              url: pullRequest.url,
              title: pullRequest.title,
              targetBranch: pullRequest.targetBranch,
              headSha: pullRequest.headSha,
            }
          : undefined);
      if (!(await database.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NULL`,
        [target.corner_id])).rowCount) return;
      const locked = current?.locked === true;
      // Locked standing corners retain their active work and wake sources after a merge.
      if (!locked) {
        // Command output locks commands before dispatch takes FOR SHARE on rooms.
        // Cancel commands before updating rooms, matching that shared lock order.
        await cancelCornerAgentCommands(database, target.corner_id);
        const changed = await database.query(
          `UPDATE rooms SET archived_at=now(),updated_at=now()
           WHERE id=$1 AND archived_at IS NULL`,
          [target.corner_id],
        );
        if (!changed.rowCount) return;
      }
      updated = true;
      if (!locked) await abandonCornerWorkflowRuns(database, target.corner_id);
      if (!locked) await deleteCornerWakeSources(database, [target.corner_id]);
      await database.query(
        `UPDATE corner_facts SET close_requested=$3,merge_attempt_head=NULL,
           lifecycle=(lifecycle-'mergeRecovery'-'mergeQueue')||$2::jsonb,
           updated_at=now() WHERE corner_id=$1`,
        [
          target.corner_id,
          JSON.stringify({
            lifecycle: locked ? 'working' : 'done',
            checks: 'passing',
            outcome: 'landed',
            ...(mergedPr
              ? {
                  pr: {
                    ...mergedPr,
                    mergedAt: pullRequest.mergedAt ?? new Date().toISOString(),
                    ...(pullRequest.mergeCommitSha
                      ? { mergeCommitSha: pullRequest.mergeCommitSha }
                      : {}),
                    ...(pullRequest.mergedBy ? { mergedBy: pullRequest.mergedBy } : {}),
                  },
                }
              : {}),
          }),
          !locked,
        ],
      );
      const merged: SystemPhrase = {
        subject: pullRequest.mergedBy
          ? { kind: 'github', name: pullRequest.mergedBy }
          : GITHUB_SUBJECT,
        verb: 'merged',
        kind: 'merged',
        object: { text: pullRequest.title, url: pullRequest.url },
      };
      await systemLine(database, {
        id: hash(`beeline:${target.corner_id}:${mergeKey}`),
        roomId: target.corner_id,
        authorId: target.author_id,
        ...merged,
        cardType: 'github-corner-note',
        card: { source: 'github', dedupe: mergeKey },
      });
      await recordInstitutionalCornerOutcome(database, {
        cornerId: target.corner_id,
        kind: 'merged',
        detail: {
          repository: pullRequest.repository,
          ...(pullRequest.number !== undefined ? { pullRequestNumber: pullRequest.number } : {}),
          ...(pullRequest.mergeCommitSha ? { mergeCommitSha: pullRequest.mergeCommitSha } : {}),
        },
      });
      // Settle private call sites only; the Room opening is a historical fact.
      await database.query(
        `UPDATE messages SET card=card||$2::jsonb
         WHERE card_type='daemon-fact' AND card->>'cornerId'=$1 AND card->>'type'='corner-open'
           AND room_id<>$3 AND card->>'sourceMessageId' IS NOT NULL`,
        [target.corner_id, JSON.stringify({ type: 'corner-complete', outcome: 'landed',
          pullRequest: { number: pullRequest.number, title: pullRequest.title, url: pullRequest.url } }), target.parent_id],
      );
      if (!locked) await enqueueCornerBranchDeletion(database, target.corner_id);
      if (!locked) await advanceCorner(database, target.corner_id, {
        kind: 'merged',
        contents: { mergeVerdict: 'merged', pullRequestUrl: pullRequest.url },
      });
      // Direct landings and missed-webhook recovery publish the same PR event.
      // The repository event id deduplicates this against the normal webhook.
      await this.processRepositoryEvent('pull_request', {
        action: 'closed', repository: { full_name: pullRequest.repository },
        ...(pullRequest.mergedBy ? { sender: { login: pullRequest.mergedBy } } : {}),
        pull_request: { merged: true, title: pullRequest.title, html_url: pullRequest.url,
          head: { ref: pullRequest.branch }, base: { ref: pullRequest.targetBranch } },
      }, Number(target.installation_id), database);
    }), { attempts: 3, delayMs: attempt => 50 * attempt + Math.floor(Math.random() * 50) });
    if (!updated) return;
    this.onRoomChanged?.(target.corner_id);
    this.onRoomChanged?.(target.parent_id);
    await this.retryBranchDeletions(target.corner_id);
  }

  async retryBranchDeletions(cornerId?: string) {
    await retryCornerBranchDeletions(this.database, this.app, cornerId);
  }

  private async syncInstallation(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const account = await this.app.installationAccount(installationId);
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT(installation_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,account_id=EXCLUDED.account_id,account_login=EXCLUDED.account_login,account_type=EXCLUDED.account_type,account_avatar_url=EXCLUDED.account_avatar_url,repository_selection=EXCLUDED.repository_selection,status='active',updated_at=now()
       WHERE (github_installations.owner_id,github_installations.account_id,github_installations.account_login,github_installations.account_type,github_installations.account_avatar_url,github_installations.repository_selection,github_installations.status)
         IS DISTINCT FROM (EXCLUDED.owner_id,EXCLUDED.account_id,EXCLUDED.account_login,EXCLUDED.account_type,EXCLUDED.account_avatar_url,EXCLUDED.repository_selection,EXCLUDED.status)`,
      [
        installationId,
        viewerId,
        account.id,
        account.login,
        account.type,
        account.avatarUrl ?? null,
        account.repositorySelection,
      ],
    );
    const repositories = await this.app.listRepositories(installationId);
    for (const repository of repositories) await this.storeRepository(repository, database);
    await database.query(
      `UPDATE github_repositories SET active=false,updated_at=now()
       WHERE installation_id=$1 AND NOT (repository_id=ANY($2::bigint[])) AND active`,
      [installationId, repositories.map((repository) => repository.id)],
    );
  }
  /**
   * GET /user/installations is keyed to the OAuth lookup token's visibility:
   * user-owned installations always appear, but an unscoped OAuth token
   * generally cannot list ORGANIZATION installations. Production answered that
   * listing with HTTP 404. Treat 404 as unavailable (same as the install
   * callback), never as a throw that aborts refresh.
   */
  private async listAdministeredInstallations(token: string): Promise<Set<number> | undefined> {
    try {
      return new Set(await this.app.listUserInstallationIds(token));
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * GET /user/installations is keyed to the OAuth lookup token's visibility:
   * user-owned installations always appear, but an unscoped OAuth token
   * generally cannot list ORGANIZATION installations, so demanding a
   * positive match here strands every org install behind an exception or a
   * false negative. For an Organization target, GitHub's state-bound
   * redirect — only the installing admin's browser receives it, bound to
   * this flow's one-time state — is the authority; the listing still refuses
   * when it definitively denies access, and its failures are logged rather
   * than fatal. Canonical comment: apps/auth/src/server-context.ts.
   */
  private async userCanAdministerInstallation(
    token: string,
    installationId: number,
    accountType: 'User' | 'Organization',
  ): Promise<boolean | undefined> {
    try {
      return await this.app.userCanAccessInstallation(token, installationId);
    } catch (error) {
      if (accountType !== 'Organization') throw error;
      console.warn(
        `[server] GitHub installation listing unavailable for organization verification installation=${installationId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }

  private async assertInstallationAccess(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const account = await this.app.installationAccount(installationId);
    const credential = await this.userCredential(viewerId, database);
    if (!credential?.token) throw new Error('GitHub installation access denied');

    let accessible: boolean | undefined;
    try {
      accessible = await this.userCanAdministerInstallation(
        credential.token,
        installationId,
        account.type,
      );
    } catch (error) {
      const shouldRotate =
        Boolean(credential.refreshToken) &&
        error instanceof GitHubHttpError &&
        error.status === 401;
      if (!shouldRotate) throw error;
      const rotated = await this.rotateUserCredential(credential, database);
      if (!rotated) throw new Error('GitHub installation access denied');
      accessible = await this.userCanAdministerInstallation(rotated, installationId, account.type);
    }

    const accessConfirmed = account.type === 'User' ? accessible === true : accessible !== false;
    if (!accessConfirmed) throw new Error('GitHub installation access denied');
  }
  private async userCredential(
    viewerId: string,
    database: SqlDatabase,
  ): Promise<
    { subject: string; token?: string; refreshToken?: string; reconnectNeeded?: true } | undefined
  > {
    const credential = (
      await database.query<{
        subject: string;
        stale_at: string | Date | null;
        encrypted_token: string | null;
        encrypted_refresh_token: string | null;
        expires_at: string | Date | null;
      }>(
        `SELECT l.subject,t.encrypted_token,t.encrypted_refresh_token,t.expires_at,t.stale_at FROM identity_external_links l LEFT JOIN github_user_tokens t ON t.subject=l.subject WHERE l.provider='github' AND l.identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (!credential) return undefined;
    const sealed =
      credential.encrypted_token ?? (await this.resolveSealedUserToken?.(credential.subject));
    if (!sealed) return { subject: credential.subject };
    const refreshToken = credential.encrypted_refresh_token
      ? this.open(credential.encrypted_refresh_token)
      : undefined;
    if (credential.stale_at && !refreshToken) return { subject: credential.subject };
    const token = this.open(sealed);
    const expiresAt = credential.expires_at ? new Date(credential.expires_at).getTime() : undefined;
    if (
      refreshToken &&
      (credential.stale_at || (expiresAt !== undefined && expiresAt - Date.now() < 60_000))
    ) {
      const rotated = await this.rotateUserCredential(
        { subject: credential.subject, refreshToken },
        database,
      );
      // Do not reuse the consumed refresh grant after proactive rotation.
      return rotated
        ? { subject: credential.subject, token: rotated }
        : { subject: credential.subject };
    }
    return {
      subject: credential.subject,
      token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(!refreshToken && expiresAt !== undefined && expiresAt <= Date.now()
        ? { reconnectNeeded: true as const }
        : {}),
    };
  }
  private async rotateUserCredential(
    credential: { subject: string; refreshToken?: string },
    database: SqlDatabase,
  ): Promise<string | undefined> {
    if (!credential.refreshToken) return undefined;
    return database.transaction(async (database) => {
      // Serialize one-use refresh grants with each other and fresh reconnects.
      const row = (
        await database.query<{
          encrypted_token: string;
          encrypted_refresh_token: string | null;
          stale_at: Date | null;
        }>(
          `SELECT encrypted_token,encrypted_refresh_token,stale_at FROM github_user_tokens WHERE subject=$1 FOR UPDATE`,
          [credential.subject],
        )
      ).rows[0];
      if (!row) return undefined;
      if (
        !row.encrypted_refresh_token ||
        this.open(row.encrypted_refresh_token) !== credential.refreshToken
      ) {
        return this.open(row.encrypted_token);
      }
      try {
        const refreshed = await this.oauth.refreshUserToken(credential.refreshToken);
        await database.query(
          `UPDATE github_user_tokens SET encrypted_token=$2,encrypted_refresh_token=COALESCE($3,encrypted_refresh_token),expires_at=$4,stale_at=NULL,updated_at=now() WHERE subject=$1`,
          [
            credential.subject,
            this.seal(refreshed.accessToken),
            refreshed.refreshToken ? this.seal(refreshed.refreshToken) : null,
            refreshed.tokenExpiresIn
              ? new Date(Date.now() + refreshed.tokenExpiresIn * 1000)
              : null,
          ],
        );
        return refreshed.accessToken;
      } catch (error) {
        if (!(error instanceof GitHubCredentialRejectedError)) throw error;
        await database.query(
          `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,stale_at=now(),updated_at=now() WHERE subject=$1`,
          [credential.subject],
        );
        return undefined;
      }
    });
  }
  private async storeRepository(
    repository: {
      id: number;
      installationId: number;
      fullName: string;
      defaultBranch: string;
      private: boolean;
      allowAutoMerge: boolean;
    },
    database: SqlDatabase,
  ) {
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,private,allow_auto_merge) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(repository_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,default_branch=EXCLUDED.default_branch,private=EXCLUDED.private,allow_auto_merge=EXCLUDED.allow_auto_merge,active=true,updated_at=now()
       WHERE (github_repositories.installation_id,github_repositories.full_name,github_repositories.default_branch,github_repositories.private,github_repositories.allow_auto_merge,github_repositories.active)
         IS DISTINCT FROM (EXCLUDED.installation_id,EXCLUDED.full_name,EXCLUDED.default_branch,EXCLUDED.private,EXCLUDED.allow_auto_merge,true)`,
      [
        repository.id,
        repository.installationId,
        repository.fullName,
        repository.defaultBranch,
        repository.private,
        repository.allowAutoMerge,
      ],
    );
  }
  private seal(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((value) => value.toString('base64url'))
      .join('.');
  }
  private open(sealed: string) {
    const parts = sealed.split('.').map((value) => Buffer.from(value, 'base64url'));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16)
      throw new Error('stored GitHub token is invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, parts[0]!);
    decipher.setAuthTag(parts[1]!);
    return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8');
  }
}
