import { NotificationWork } from './notification-work.js';
import { CommandRefusalError } from './command-refusal.js';
import type { RepositorySignals } from './repository-onboarding.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import type { CornerLifecycleView, PhoneOperationMap } from '@beeline/api-contract/phone';
import type { CornerPullRequestResult } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { type SystemPhrase } from './system-line.js';
import { fireRepositorySubscriptions } from './agent-subscriptions.js';
import { gitHubOperationsBeginIdentity, gitHubOperationsCompleteIdentity, gitHubOperationsBeginInstallation, gitHubOperationsCompleteInstallation, gitHubOperationsRefresh, gitHubOperationsRepositoryStarred, gitHubOperationsStarRepository, gitHubOperationsOnboardingSignals, gitHubOperationsCreateRepository, gitHubOperationsRoomAnchorTarget, gitHubOperationsRoomWorkflowTarget, gitHubOperationsAssertCornerReviewerNotAuthor, gitHubOperationsListRoomWorkflows, gitHubOperationsDispatchRoomWorkflow, gitHubOperationsDispatchProductionRelease, gitHubOperationsResolveUnregisteredCornerPullRequest, gitHubOperationsRefreshCornerReviewHead, gitHubOperationsPrChecksStatus } from './github-operations-begin-identity.js';
import { gitHubOperationsReadPrChecksStatus, gitHubOperationsApproveCornerMerge, gitHubOperationsLandCorner, gitHubOperationsLandCornerOutcome, gitHubOperationsCloseCornerPullRequest, gitHubOperationsRecordClosedCornerPullRequest, gitHubOperationsReadCornerPullRequest, gitHubOperationsRefreshStaleMergeability } from './github-operations-read-pr-checks-status.js';
import { gitHubOperationsReconcileQueuedCorners, gitHubOperationsRecordConfirmedCornerMerge, gitHubOperationsProcessBaseBranchPush, gitHubOperationsProcessRepositoryEvent, gitHubOperationsProcessCornerEvent } from './github-operations-reconcile-queued-corners.js';
import { gitHubOperationsRefreshCheckRollup, gitHubOperationsLifecycle, gitHubOperationsUpdateLifecycle, gitHubOperationsSystemNote, gitHubOperationsMergeCorner, gitHubOperationsDeleteCornerBranch, gitHubOperationsSyncInstallation, gitHubOperationsListAdministeredInstallations, gitHubOperationsUserCanAdministerInstallation, gitHubOperationsAssertInstallationAccess } from './github-operations-refresh-check-rollup.js';
import { gitHubOperationsUserCredential, gitHubOperationsRotateUserCredential, gitHubOperationsStoreRepository } from './github-operations-user-credential.js';

export class GitHubOperations {

  readonly #key: Buffer;

  readonly #webhooks = new NotificationWork(1);

  readonly #checkWork = new Set<Promise<unknown>>();

  #stoppingChecks = false;


  /** HTTP close cannot drain work left alive by a caller's transaction deadline. */
  async stopCheckRefreshes(): Promise<void> {
    this.#stoppingChecks = true;
    await Promise.allSettled(this.#checkWork);
  }


   ownCheckWork<T>(run: () => Promise<T>): Promise<T> {
    if (this.#stoppingChecks)
      return Promise.reject(new CommandRefusalError('GitHub check service is shutting down', 409));
    const work = run();
    this.#checkWork.add(work);
    return work.finally(() => this.#checkWork.delete(work));
  }


  readonly #roomTokens = new Map<string, { token: string; expiresAt: number }>();

  readonly #roomTokenMints = new Map<string, Promise<{ token: string; expiresAt: number }>>();

  constructor(
     readonly database: SqlDatabase,
     readonly oauth: GitHubOAuthClient,
     readonly app: GitHubAppClient,
    clientSecret: string,
     readonly resolveSealedUserToken?: (subject: string) => Promise<string | undefined>,
     readonly onRoomChanged?: (roomId: string) => void,
  ) {
    this.#key = createHash('sha256').update(clientSecret).digest();
    this.armRoomTokenCache();
    this.app.setRateLimitStore?.({
      get: async installationId => {
        const row = (await this.database.query<{ retry_at: string | null }>(
          'SELECT api_retry_at::text retry_at FROM github_installations WHERE installation_id=$1', [installationId])).rows[0];
        return row?.retry_at ? Date.parse(row.retry_at) : 0;
      },
      set: async (installationId, retryAt) => {
        await this.database.query(`UPDATE github_installations SET api_retry_at=GREATEST(api_retry_at,$2::timestamptz)
          WHERE installation_id=$1`, [installationId, new Date(retryAt).toISOString()]);
      },
    });
  }
async beginIdentity(viewerId: string, input: Input<'beginGitHubIdentityBind'>) { return gitHubOperationsBeginIdentity(this, viewerId, input); }
async completeIdentity(viewerId: string, input: Input<'completeGitHubIdentityBind'>, recover: boolean) { return gitHubOperationsCompleteIdentity(this, viewerId, input, recover); }
async beginInstallation(viewerId: string, input: Input<'beginGitHubInstallation'>) { return gitHubOperationsBeginInstallation(this, viewerId, input); }
async completeInstallation(state: string, installationId?: number, code?: string, callbackUri?: string) { return gitHubOperationsCompleteInstallation(this, state, installationId, code, callbackUri); }
async refresh(viewerId: string): Promise<{
    githubReconnectNeeded?: boolean;
}> { return gitHubOperationsRefresh(this, viewerId); }
/** Whether the viewer starred `fullName`; 'unknown' without a usable token or answer. */
async repositoryStarred(viewerId: string, fullName: string): Promise<boolean | 'unknown'> { return gitHubOperationsRepositoryStarred(this, viewerId, fullName); }
/** Star `fullName` with the viewer's own token. False when GitHub refuses. */
async starRepository(viewerId: string, fullName: string): Promise<boolean> { return gitHubOperationsStarRepository(this, viewerId, fullName); }
/** Read signals with the Room's exact-repository installation token. */
async onboardingSignals(roomId: string): Promise<RepositorySignals> { return gitHubOperationsOnboardingSignals(this, roomId); }
async createRepository(viewerId: string, input: Input<'createGitHubRepository'>, database: SqlDatabase = this.database) { return gitHubOperationsCreateRepository(this, viewerId, input, database); }


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
      // A permission webhook may already have replaced this mint.
      if (this.#roomTokenMints.get(key) === mint) this.#roomTokenMints.delete(key);
    }
  }


  /**
   * Drop cached tokens for one installation. An in-flight mint still resolves
   * for its caller, but its cache write is ignored once the epoch has moved.
   */
   invalidateInstallationRoomTokens(installationId: number): void {
    bumpInstallationTokenEpoch(installationId);
    const prefix = `${installationId}:`;
    for (const key of [...this.#roomTokens.keys()]) {
      if (key.startsWith(prefix)) this.#roomTokens.delete(key);
    }
    for (const key of [...this.#roomTokenMints.keys()]) {
      if (key.startsWith(prefix)) this.#roomTokenMints.delete(key);
    }
  }


  /** See `wrapInstallationTokenMint`. The check lives on the map, not in `roomToken`. */
   armRoomTokenCache(): void {
    wrapInstallationTokenMint(this.app);
    const tokens = this.#roomTokens;
    const write = tokens.set.bind(tokens);
    tokens.set = (key, value) => {
      const installationId = Number(key.split(':')[0]);
      const started = installationTokenStamp;
      installationTokenStamp = undefined;
      if (started !== undefined && started !== installationTokenEpochNow(installationId)) return tokens;
      return write(key, value);
    };
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
async roomAnchorTarget(roomId: string, database: SqlDatabase = this.database) { return gitHubOperationsRoomAnchorTarget(this, roomId, database); }
async roomWorkflowTarget(roomId: string, database: SqlDatabase = this.database) { return gitHubOperationsRoomWorkflowTarget(this, roomId, database); }
/** Read every PR commit, including coauthors, using the repository installation. */
async assertCornerReviewerNotAuthor(cornerId: string, agentId: string, database: SqlDatabase = this.database): Promise<void> { return gitHubOperationsAssertCornerReviewerNotAuthor(this, cornerId, agentId, database); }
async listRoomWorkflows(roomId: string) { return gitHubOperationsListRoomWorkflows(this, roomId); }
async dispatchRoomWorkflow(roomId: string, workflowName: string): Promise<void> { return gitHubOperationsDispatchRoomWorkflow(this, roomId, workflowName); }
async dispatchProductionRelease(roomId: string, inputs: Record<string, string>): Promise<void> { return gitHubOperationsDispatchProductionRelease(this, roomId, inputs); }
/** Repair the opened-webhook race before a worker's done report transaction. */
async resolveUnregisteredCornerPullRequest(cornerId: string, agentId: string): Promise<void> { return gitHubOperationsResolveUnregisteredCornerPullRequest(this, cornerId, agentId); }
/** Resolve handoffs against GitHub even when the synchronize webhook is late. */
async refreshCornerReviewHead(cornerId: string): Promise<void> { return gitHubOperationsRefreshCornerReviewHead(this, cornerId); }
/** Caller is authorized by DaemonService against the requesting corner membership. */
prChecksStatus(input: {
    cornerId: string;
    pullRequest?: number | string;
}, confirmZeroChecks = false) { return gitHubOperationsPrChecksStatus(this, input, confirmZeroChecks); }
async readPrChecksStatus(input: {
    cornerId: string;
    pullRequest?: number | string;
}, confirmZeroChecks: boolean) { return gitHubOperationsReadPrChecksStatus(this, input, confirmZeroChecks); }
/**
 * The phone's approve: a Workspace owner or admin's yes on the current head
 * (`recordPersonMergeYes`), then the one merge path, `landCorner`. Checks
 * must be green and no hold may stand; a yes given early merges when the
 * implementer's `merge_corner` runs after green checks.
 */
async approveCornerMerge(viewerId: string, input: Input<'approveCornerMerge'>) { return gitHubOperationsApproveCornerMerge(this, viewerId, input); }
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
async landCorner(cornerId: string): Promise<boolean> { return gitHubOperationsLandCorner(this, cornerId); }
/**
 * `landCorner`, telling a started merge apart from one GitHub refused, so
 * `merge_corner` can report the refusal instead of `merge-started`.
 */
async landCornerOutcome(cornerId: string, onBlocked?: (reason: string) => void): Promise<LandCornerOutcome> { return gitHubOperationsLandCornerOutcome(this, cornerId, onBlocked); }
/**
 * Close a corner's own pull request without merging (`close_pull_request`).
 * The branch and its commits stay on GitHub. Clearing the recorded PR keeps
 * active corners open and repairs legacy archived corners without reopening
 * them. The merge gate reads "no pull request" until a new one opens.
 */
async closeCornerPullRequest(cornerId: string): Promise<{
    status: 'closed';
    number: number;
    url: string;
    title: string;
} | {
    status: 'blocked';
    blocker: string;
}> { return gitHubOperationsCloseCornerPullRequest(this, cornerId); }
/** PR association and run state move together for tool calls and GitHub facts. */
async recordClosedCornerPullRequest(cornerId: string, number: number, database: SqlDatabase = this.database): Promise<void> { return gitHubOperationsRecordClosedCornerPullRequest(this, cornerId, number, database); }
/** Caller is authorized by DaemonService: it reaches the corner. */
async readCornerPullRequest(cornerId: string): Promise<CornerPullRequestResult> { return gitHubOperationsReadCornerPullRequest(this, cornerId); }


  async processWebhook(event: string, payload: unknown, deliveryId?: string) {
    if (this.#stoppingChecks)
      throw new CommandRefusalError('GitHub check service is shutting down', 409);
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    this.#checkWork.add(work);
    let release: (() => void) | undefined;
    try {
      release = await this.#webhooks.acquire();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const body = payload as Record<string, unknown>;
      // The authenticated phone route uses this internal signal after a human message commits.
      // Retired: merge recovery no longer waits on a person's message.
      if (event === 'beeline:human-message') return;
      if (event === 'merge_group') {
        await this.reconcileQueuedCorners();
        return;
      }
      const installation = body.installation;
      if (!installation || typeof installation !== 'object' || Array.isArray(installation)) return;
      const install = installation as Record<string, unknown>;
      if (typeof install.id !== 'number') return;
      // Before any later return, so `new_permissions_accepted` drops stale tokens
      // even though this handler has no branch of its own for that action.
      if (event === 'installation' || event === 'installation_repositories') {
        this.invalidateInstallationRoomTokens(install.id);
      }
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
        event === 'workflow_run' ||
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
      release?.();
      this.#checkWork.delete(work);
      finish();
    }
  }
/**
 * Retry GitHub's asynchronous mergeability calculation for open corner PRs,
 * and re-read a stored 'dirty' PR so a conflict that GitHub has since
 * cleared stops re-firing the merge-conflict wake. An addressed refresh also
 * checks previously clean verdicts: checks can finish after the base moves
 * without a pull-request webhook carrying the new conflict.
 */
async refreshStaleMergeability(cornerId?: string, confirmedPr?: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>): Promise<void> { return gitHubOperationsRefreshStaleMergeability(this, cornerId, confirmedPr); }
/** Reconcile committed queue facts against GitHub; never enqueue from a wake. */
/**
 * Settles merge-queue entries against the live gate. For one corner (a hold,
 * a withdrawn yes, a merge attempt) it reads GitHub's queue live even when no
 * entry is cached, so an enqueue whose response was lost is still dequeued
 * once the gate closes.
 */
async reconcileQueuedCorners(cornerId?: string): Promise<void> { return gitHubOperationsReconcileQueuedCorners(this, cornerId); }
async recordConfirmedCornerMerge(target: CornerWebhookTarget, repository: string, number: number, pr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>) { return gitHubOperationsRecordConfirmedCornerMerge(this, target, repository, number, pr); }
async processBaseBranchPush(body: GitHubRecord, installationId: number): Promise<void> { return gitHubOperationsProcessBaseBranchPush(this, body, installationId); }
/**
 * Room-level repository activity. Issues and pull requests post on
 * opened/closed. Raw pushes and CI do NOT post: commit churn and
 * mainline check results are not Room conversation. Corner PRs use the
 * same repository events; CI stays on processCornerEvent.
 */
async processRepositoryEvent(event: string, body: GitHubRecord, installationId: number) { return gitHubOperationsProcessRepositoryEvent(this, event, body, installationId); }
async processCornerEvent(event: string, body: GitHubRecord, installationId: number) { return gitHubOperationsProcessCornerEvent(this, event, body, installationId); }
async refreshCheckRollup(target: CornerWebhookTarget & {
    has_pr?: boolean;
    pr_number?: string | null;
}, repository: string, check: NonNullable<ReturnType<typeof checkFact>>, database: SqlDatabase, options?: {
    quiet?: boolean;
    snapshot?: {
        rollup: Awaited<ReturnType<GitHubAppClient['readCommitCheckRollup']>>;
        pr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>;
        fetchStartedAt: number;
        token: string;
    };
}) { return gitHubOperationsRefreshCheckRollup(this, target, repository, check, database, options); }
async lifecycle(cornerId: string, database: SqlDatabase = this.database): Promise<CornerLifecycleView> { return gitHubOperationsLifecycle(this, cornerId, database); }
async updateLifecycle(cornerId: string, patch: Partial<CornerLifecycleView>, database: SqlDatabase = this.database) { return gitHubOperationsUpdateLifecycle(this, cornerId, patch, database); }
async systemNote(roomId: string, authorId: string, phrase: SystemPhrase, dedupe: string, database: SqlDatabase = this.database, deferNotification = false) { return gitHubOperationsSystemNote(this, roomId, authorId, phrase, dedupe, database, deferNotification); }
async mergeCorner(target: CornerWebhookTarget, pullRequest: {
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
}, database: SqlDatabase = this.database, expectedPrNumber?: number) { return gitHubOperationsMergeCorner(this, target, pullRequest, database, expectedPrNumber); }
/** One post-commit attempt; no persistent branch cleanup queue or retry. */
async deleteCornerBranch(cornerId: string) { return gitHubOperationsDeleteCornerBranch(this, cornerId); }
async syncInstallation(viewerId: string, installationId: number, transaction?: SqlDatabase) { return gitHubOperationsSyncInstallation(this, viewerId, installationId, transaction); }
/**
 * GET /user/installations is keyed to the OAuth lookup token's visibility:
 * user-owned installations always appear, but an unscoped OAuth token
 * generally cannot list ORGANIZATION installations. Production answered that
 * listing with HTTP 404. Treat 404 as unavailable (same as the install
 * callback), never as a throw that aborts refresh.
 */
async listAdministeredInstallations(token: string): Promise<Set<number> | undefined> { return gitHubOperationsListAdministeredInstallations(this, token); }
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
async userCanAdministerInstallation(token: string, installationId: number, accountType: 'User' | 'Organization'): Promise<boolean | undefined> { return gitHubOperationsUserCanAdministerInstallation(this, token, installationId, accountType); }
async assertInstallationAccess(viewerId: string, installationId: number, database: SqlDatabase = this.database) { return gitHubOperationsAssertInstallationAccess(this, viewerId, installationId, database); }
async userCredential(viewerId: string, database: SqlDatabase): Promise<{
    subject: string;
    token?: string;
    refreshToken?: string;
    reconnectNeeded?: true;
} | undefined> { return gitHubOperationsUserCredential(this, viewerId, database); }
async rotateUserCredential(credential: {
    subject: string;
    refreshToken?: string;
}, database: SqlDatabase): Promise<string | undefined> { return gitHubOperationsRotateUserCredential(this, credential, database); }
async storeRepository(repository: {
    id: number;
    installationId: number;
    fullName: string;
    defaultBranch: string;
    private: boolean;
    allowAutoMerge: boolean;
}, database: SqlDatabase) { return gitHubOperationsStoreRepository(this, repository, database); }

   seal(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((value) => value.toString('base64url'))
      .join('.');
  }

   open(sealed: string) {
    const parts = sealed.split('.').map((value) => Buffer.from(value, 'base64url'));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16)
      throw new Error('stored GitHub token is invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, parts[0]!);
    decipher.setAuthTag(parts[1]!);
    return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8');
  }
}



export type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];


export type GitHubRecord = Record<string, unknown>;


export function record(value: unknown): GitHubRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as GitHubRecord)
    : undefined;
}


export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}


export function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}


export function githubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}


export function repositoryName(body: GitHubRecord): string | undefined {
  return text(record(body.repository)?.full_name);
}


export function branchForEvent(event: string, body: GitHubRecord): string | undefined {
  if (event === 'push') {
    const ref = text(body.ref);
    return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  }
  if (event === 'pull_request') return text(record(record(body.pull_request)?.head)?.ref);
  if (event === 'check_run') return text(record(record(body.check_run)?.check_suite)?.head_branch);
  if (event === 'check_suite') return text(record(body.check_suite)?.head_branch);
  if (event === 'workflow_run') return text(record(body.workflow_run)?.head_branch);
  if (event === 'status') {
    const branches = Array.isArray(body.branches) ? body.branches : [];
    return branches.map((value) => text(record(value)?.name)).find(Boolean);
  }
  return undefined;
}


export function checksResult(event: string, body: GitHubRecord): 'passed' | 'failed' | undefined {
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


export function checkFact(event: string, body: GitHubRecord) {
  if (event === 'workflow_run' && body.action === 'completed') {
    const run = record(body.workflow_run);
    // Completion is a refresh signal; only the head's rollup supplies a verdict.
    return { name: 'Pull request checks', status: 'pending' as const,
      ...(text(run?.head_sha) ? { headSha: text(run?.head_sha)! } : {}) };
  }
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


export interface CornerWebhookTarget {
  corner_id: string;
  parent_id: string;
  author_id: string;
  corner_name: string;
  summary: string;
  repository_id: string;
  installation_id: string;
}


export function jobErrorLines(log: string): string {
  const lines = log.split(/\r?\n/);
  const picked = new Set<number>();
  for (let i = 0, errors = 0; i < lines.length && errors < 3; i++) {
    if (!/##\[error\]/i.test(lines[i]!)) continue;
    errors++;
    for (let j = Math.max(0, i - 3); j <= i; j++) picked.add(j);
  }
  return [...picked].map(i => lines[i]!.slice(0, 300)).join('\n').slice(0, 1_500);
}


export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// One conflict wake per pull-request head. The base is deliberately absent:
// every new commit on main moved it, so a stale 'dirty' verdict produced a
// fresh key and a fresh wake for an unchanged head.
export function mergeConflictKey(number: number, headSha: string): string {
  return `merge-conflict:${number}:${headSha}`;
}

export function challenge(value: string): string {
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


/**
 * GitHub fixes an installation token's permissions at mint time. A mint notes
 * the epoch when its expiry is read; a cache write after an installation
 * webhook is ignored. That check stays on the token map: repository onboarding
 * hashes `roomToken`'s returned expressions. Pending-map cleanup drops only
 * the mint that started it, so an older mint cannot erase its replacement.
 */
export const installationTokenEpoch = new Map<number, number>();

export let installationTokenStamp: number | undefined;

export const wrappedInstallationTokens = new WeakSet<object>();


export function bumpInstallationTokenEpoch(installationId: number): void {
  installationTokenEpoch.set(installationId, (installationTokenEpoch.get(installationId) ?? 0) + 1);
}


export function installationTokenEpochNow(installationId: number): number {
  return installationTokenEpoch.get(installationId) ?? 0;
}


export function wrapInstallationTokenMint(app: GitHubAppClient): void {
  const current = app.installationToken;
  if (typeof current !== 'function' || wrappedInstallationTokens.has(current)) return;
  const wrapped = new Proxy(current, {
    apply(target, thisArg, args: unknown[]) {
      const installationId = typeof args[0] === 'number' ? args[0] : Number(args[0]);
      const epoch = installationTokenEpochNow(installationId);
      const result = Reflect.apply(target, thisArg, args) as Promise<{ expiresAt?: string | number }>;
      return Promise.resolve(result).then((value) => {
        if (!value || typeof value !== 'object') return value;
        const expiresAt = value.expiresAt;
        return {
          ...value,
          get expiresAt() {
            installationTokenStamp = epoch;
            return expiresAt;
          },
        };
      });
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  wrappedInstallationTokens.add(wrapped);
  app.installationToken = wrapped as GitHubAppClient['installationToken'];
}


/** What one `landCornerOutcome` call did on GitHub. */
export type LandCornerOutcome =
  | { readonly status: 'not-attempted' }
  | { readonly status: 'started' }
  | { readonly status: 'queued' }
  | { readonly status: 'refused'; readonly reason: string };
