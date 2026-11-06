import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerObjectiveSql } from './corner-objective.js';
import { commandOwnerLiveSql } from './turn-ownership.js';
import { cornerOwnerSql } from './corner-worker.js';
import { cornerRunOutcomeSql } from './corner-run.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { cornerFeatureBranchSql } from './corner-branch.js';
import { GitHubAppClient, GitHubHttpError } from '@beeline/auth/github';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import type { CornerPullRequestResult } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import { recordPersonMergeYes, withdrawPullRequestMergeApprovals } from './corner-merge-approval.js';
import { assertCornerBriefAllowsMerge } from './corner-brief.js';
import { advanceCorner, cornerReviewWokenSql, blockingReview, confirmCornerMergeAuthority, lockCornerLifecycle, cornerMergeGate, cornerMergeability } from './corner-lifecycle.js';
import { queueCornerMergeConflict, reconcileCornerMergeBlockers } from './agent-command.js';
import { GitHubOperations, reviewerWakeFromFacts, Input, LandCornerOutcome, CornerWebhookTarget, record, mergeConflictKey, hash, text } from './github-operations.js';



  export async function gitHubOperationsReadPrChecksStatus(ctx: GitHubOperations, input: { cornerId: string; pullRequest?: number | string }, confirmZeroChecks: boolean) {
    const corner = (
      await ctx.database.query<{
        parent_id: string;
        workspace_id: string;
        lifecycle: CornerLifecycleView;
        archived: boolean;
        review_woken: boolean;
        configured_reviewer_id: string | null;
        reviewer_identity_id: string | null;
        parent_reviewer_id: string | null;
        corner_reviewer_id: string | null;
        reviewer_handle: string | null;
        author_id: string;
        corner_name: string;
      }>(
        `SELECT r.parent_id,parent.workspace_id,f.lifecycle,
                COALESCE(${cornerOwnerSql('r.id')},r.created_by,parent.created_by) author_id,r.name corner_name,
                r.archived_at IS NOT NULL archived,
                ${cornerReviewWokenSql('r.id')} review_woken,
                ${cornerReviewerSql('r')} configured_reviewer_id,
                reviewer_identity.id reviewer_identity_id,
                parent_member.identity_id parent_reviewer_id,
                corner_member.identity_id corner_reviewer_id,
                reviewer_identity.handle reviewer_handle
         FROM rooms r
         JOIN corner_github_cache f ON f.corner_id=r.id
         JOIN rooms parent ON parent.id=r.parent_id
         LEFT JOIN identities reviewer_identity ON reviewer_identity.id=${cornerReviewerSql('r')}
           AND reviewer_identity.kind='agent'
         LEFT JOIN room_access parent_member ON parent_member.room_id=parent.id
           AND parent_member.identity_id=${cornerReviewerSql('r')} AND parent_member.removed_at IS NULL
         LEFT JOIN room_access corner_member ON corner_member.room_id=r.id
           AND corner_member.identity_id=${cornerReviewerSql('r')} AND corner_member.removed_at IS NULL
         WHERE r.id=$1`,
        [input.cornerId],
      )
    ).rows[0];
    if (!corner?.parent_id) throw new Error('corner not found');
    const target = await ctx.roomWorkflowTarget(corner.parent_id);
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
    const fetchStartedAt = (await ctx.database.query<{ started_at: number }>(
      `SELECT extract(epoch FROM clock_timestamp())::double precision started_at`,
    )).rows[0]!.started_at;
    const pr = await ctx.app.readPullRequest(target.token, target.repository, number);
    // Explicit reconciliation also observes an unmerged close even when the
    // check verdict is unchanged. No clock scans for missed close webhooks.
    if (!corner.archived && pr.state === 'closed' && !pr.merged && corner.lifecycle.pr?.number === number) {
      await ctx.recordClosedCornerPullRequest(input.cornerId, number);
    }
    // A delayed landing wake may be the first observer of a missed merge webhook.
    // Reconcile the recorded PR through the same idempotent archival path.
    if (!corner.archived && pr.merged && pr.headRef && corner.author_id &&
      corner.lifecycle.pr?.number === number) {
      await ctx.mergeCorner({ ...target, corner_id: input.cornerId,
        parent_id: corner.parent_id, author_id: corner.author_id,
        corner_name: corner.corner_name, summary: '' }, {
        repository: target.repository, branch: pr.headRef, title: pr.title ?? `Pull request #${number}`,
        url: pr.url, number, targetBranch: pr.baseRef, headSha: pr.headSha,
        mergedAt: pr.mergedAt, mergeCommitSha: pr.mergeCommitSha, mergedBy: pr.mergedBy,
        commits: 0, files: 0,
      }, ctx.database, number);
    }
    let rollup = await ctx.app.readCommitCheckRollup(
      target.token,
      target.repository,
      pr.headSha,
    );
    let zeroChecksConfirmed = false;
    if (confirmZeroChecks && rollup.total === 0 && rollup.state === 'pending') {
      const absent = await ctx.app.confirmNoChecks(target.token, target.repository, pr.headSha);
      // Re-read after registration evidence: neither a new head nor a newly
      // registered status context can inherit the earlier empty rollup.
      const latestPr = await ctx.app.readPullRequest(target.token, target.repository, number);
      rollup = await ctx.app.readCommitCheckRollup(target.token, target.repository, pr.headSha);
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
    const summaryStatus = checks === 'passed' ? 'passing' : checks === 'failed' ? 'failing' : 'pending';
    // The live read and phone header must retain the same provider snapshot.
    // Reuse the event path, including its head/age guards and review transition,
    // without fetching GitHub again. Explicit reads of another PR cannot change
    // this corner, and zero-check completion retains its worker-only authority.
    if (!corner.archived && !pr.merged && rollup.total > 0 && corner.author_id &&
      corner.lifecycle.pr?.number === number && corner.lifecycle.pr.headSha === pr.headSha &&
      (corner.lifecycle.checksSummary?.total !== rollup.total ||
        JSON.stringify(corner.lifecycle.checksSummary?.checks) !== JSON.stringify(rollup.checks) ||
        corner.lifecycle.checksSummary?.status !== summaryStatus || corner.lifecycle.checks !== summaryStatus)) {
      await ctx.refreshCheckRollup({ ...target, corner_id: input.cornerId,
        parent_id: corner.parent_id, author_id: corner.author_id, corner_name: corner.corner_name,
        summary: '', has_pr: true, pr_number: String(number) }, target.repository,
      { name: 'Pull request checks', status: 'pending', headSha: pr.headSha }, ctx.database,
      { quiet: true, snapshot: { rollup, pr, fetchStartedAt, token: target.token } });
      corner.review_woken = (await ctx.database.query<{ review_woken: boolean }>(
        `SELECT ${cornerReviewWokenSql('$1::uuid')} review_woken`,
        [input.cornerId],
      )).rows[0]?.review_woken ?? false;
    }
    corner.archived = (await ctx.database.query<{ archived: boolean }>(
      `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [input.cornerId],
    )).rows[0]?.archived ?? true;
    const configuredReviewerId = corner.configured_reviewer_id;
    // The same gate the server merges on (`cornerMergeGate`), for this exact head.
    const gate = await cornerMergeGate(ctx.database, input.cornerId, {
      number,
      headSha: pr.headSha,
    });
    const { reviewerExists } = gate;
    const reviewer = configuredReviewerId && corner.reviewer_handle ? `@${corner.reviewer_handle}` : null;
    let reviewerWake = reviewerWakeFromFacts({
      configuredReviewerId,
      reviewerHandle: corner.reviewer_handle,
      parentMember: Boolean(configuredReviewerId && corner.reviewer_identity_id && corner.parent_reviewer_id),
      cornerMember: Boolean(configuredReviewerId && corner.reviewer_identity_id && corner.corner_reviewer_id),
      checks,
      reviewWoken: corner.review_woken,
    });
    if (reviewerWake.status === 'dispatched' && !gate.approved) {
      const delivery = (await ctx.database.query<{ ended: boolean; live: boolean }>(
        `SELECT bool_or(command.state='complete') ended,
           bool_or(command.state='pending' OR (command.state='claimed' AND ${commandOwnerLiveSql('command')})) live
         FROM agent_commands command WHERE command.room_id=$1
           AND command.review_context->>'headSha'=$2 AND command.review_context->'pullRequest'=$3::jsonb
           AND command.review_context->>'purpose' IS NULL`,
        [input.cornerId,pr.headSha,JSON.stringify(number)])).rows[0];
      if (delivery?.ended && !delivery.live && !await blockingReview(ctx.database,input.cornerId,pr.headSha))
        reviewerWake = {status:'waiting',detail:'The reviewer ended without a verdict; ownership returns to the implementer or commander once.'};
    }
    const mergeDecision = cornerMergeability({
      checks,
      approved: gate.approved,
      evidenceMissing: gate.evidenceMissing,
      held: gate.held,
      holds: gate.holds,
      archived: corner.archived,
      merged: pr.merged,
      expectedHeadSha: corner.lifecycle.pr?.headSha,
      currentHeadSha: pr.headSha,
      mergeability: pr.mergeability,
    });
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
      ...mergeDecision,
    };
  }


  /**
   * The phone's approve: a Workspace owner or admin's yes on the current head
   * (`recordPersonMergeYes`), then the one merge path, `landCorner`. Checks
   * must be green and no hold may stand; a yes given early merges when the
   * implementer's `merge_corner` runs after green checks.
   */
  export async function gitHubOperationsApproveCornerMerge(ctx: GitHubOperations, viewerId: string, input: Input<'approveCornerMerge'>) {
    const corner = (
      await ctx.database.query<{ archived: boolean; lifecycle: CornerLifecycleView }>(
        `SELECT corner.archived_at IS NOT NULL archived,fact.lifecycle
         FROM rooms corner JOIN corner_github_cache fact ON fact.corner_id=corner.id
         WHERE corner.id=$1`,
        [input.cornerId],
      )
    ).rows[0];
    const pullRequest = corner?.lifecycle.pr;
    if (!corner || !pullRequest) throw new Error('corner has no pull request to merge');
    if (corner.archived || corner.lifecycle.lifecycle === 'done')
      return { status: 'already-merged' as const, pullRequestUrl: pullRequest.url };
    const yes = await recordPersonMergeYes(ctx.database, input.cornerId, viewerId);
    await ctx.landCorner(input.cornerId);
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
  export async function gitHubOperationsLandCorner(ctx: GitHubOperations, cornerId: string): Promise<boolean> {
    return (await ctx.landCornerOutcome(cornerId)).status !== 'not-attempted';
  }


  /**
   * `landCorner`, telling a started merge apart from one GitHub refused, so
   * `merge_corner` can report the refusal instead of `merge-started`.
   */
  export async function gitHubOperationsLandCornerOutcome(ctx: GitHubOperations, cornerId: string, onBlocked?: (reason: string) => void): Promise<LandCornerOutcome> {
    const notAttempted = (reason: string) => {
      onBlocked?.(reason);
      return { status: 'not-attempted' } as const;
    };
    await assertCornerBriefAllowsMerge(ctx.database, cornerId);
    let status: Awaited<ReturnType<GitHubOperations['prChecksStatus']>>;
    try {
      status = await ctx.prChecksStatus({ cornerId });
    } catch (error) {
      console.error(
        `[server] corner ${cornerId} merge gate read failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return notAttempted('GitHub merge gate read failed');
    }
    if (status.stage === 'waiting_for_yes' && status.blockedReason && status.checks === 'passed' && status.approved && !status.held) {
      const reviewerPass = await ctx.database.query(`SELECT 1 FROM corner_merge_approvals approval
        JOIN identities reviewer ON reviewer.id=approval.approved_by AND reviewer.kind='agent'
        JOIN rooms corner ON corner.id=approval.corner_id
        JOIN rooms parent ON parent.id=corner.parent_id
        JOIN corner_facts fact ON fact.corner_id=corner.id
        WHERE approval.corner_id=$1 AND approval.head_sha=$2
          AND approval.approved_by=${cornerReviewerSql('corner')}`, [cornerId, status.headSha]);
      if (!reviewerPass.rowCount) return notAttempted('PR is a draft; waiting for reviewer PASS');
      const draftHeadSha = status.headSha;
      try {
        const parent = (await ctx.database.query<{ parent_id: string }>('SELECT parent_id FROM rooms WHERE id=$1', [cornerId])).rows[0]!;
        const target = await ctx.roomWorkflowTarget(parent.parent_id);
        await ctx.app.markPullRequestReadyForReview(target.token, target.repository,
          Number(status.pullRequest.split('/').at(-1)), status.headSha);
        await ctx.database.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'draftReadyFailure' WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2`, [cornerId, status.headSha]);
        status = await ctx.prChecksStatus({ cornerId });
        if (status.blockedReason?.includes('PR is a draft')) throw new Error(status.blockedReason);
      } catch (error) {
        await ctx.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(jsonb_set(lifecycle,
          '{pr,mergeability}','"draft"'::jsonb),'{draftReadyFailure}',jsonb_build_object('headSha',$2::text)) WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2`,
          [cornerId, draftHeadSha]);
        await reconcileCornerMergeBlockers(ctx.database, cornerId);
        return notAttempted(`PR is a draft: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!status.mergeAllowed) return notAttempted(status.blockedReason ?? 'the merge gate is closed');
    const target = (
      await ctx.database.query<CornerWebhookTarget & {
        number: number;
        branch: string;
        full_name: string;
      }>(
        `SELECT (fact.lifecycle->'pr'->>'number')::int number,${cornerFeatureBranchSql('corner')} branch,
           repository.repository_id,repository.installation_id,repository.full_name,
           corner.id corner_id,parent.id parent_id,corner.name corner_name,
           COALESCE(${cornerOwnerSql('corner.id')},corner.created_by,parent.created_by) author_id,${cornerObjectiveSql('corner')} summary
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_github_cache fact ON fact.corner_id=corner.id
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
    if (!(await confirmCornerMergeAuthority(ctx.database, cornerId, status.headSha, onBlocked)))
      return { status: 'not-attempted' };
    try {
      const result = await ctx.app.mergePullRequest(
        Number(target.installation_id),
        Number(target.repository_id),
        target.full_name,
        target.number,
        status.headSha,
      );
      if (result === 'queued') {
        await ctx.database.query(
          `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{mergeQueue}',
             jsonb_build_object('headSha',$2::text))
           WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2`, [cornerId, status.headSha],
        );
        await ctx.reconcileQueuedCorners(cornerId);
        ctx.onRoomChanged?.(cornerId);
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
        const token = await ctx.app.installationToken(Number(target.installation_id), {
          repositoryIds: [Number(target.repository_id)],
        });
        pr = await ctx.app.readPullRequest(token.token, target.full_name, target.number);
        if (!pr.merged) {
          const queue = await ctx.app.readPullRequestQueue(token.token, target.full_name, target.number);
          confirmedUnqueued = !queue.entry;
          if (queue.entry && queue.headSha === status.headSha) {
            await ctx.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{mergeQueue}',
              jsonb_build_object('headSha',$2::text)) WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2`,
              [cornerId, status.headSha]);
            await ctx.reconcileQueuedCorners(cornerId);
            ctx.onRoomChanged?.(cornerId);
            return { status: 'queued' };
          }
        }
      } catch (readError) {
        console.error(`[server] merge outcome read failed for ${cornerId}:`, readError);
      }
      if (pr?.merged && pr.headSha === status.headSha && pr.headRef === target.branch) {
        await ctx.recordConfirmedCornerMerge(target, target.full_name, target.number, pr);
        return { status: 'started' };
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (queueAttempted && !confirmedUnqueued) {
        // Enqueue acceptance cannot be read yet: inscribe no refusal. The
        // merge_group webhook, or the next hold or yes, reads the queue live.
        return { status: 'refused', reason };
      }
      await advanceCorner(ctx.database, cornerId, {
        kind: 'merge-refused',
        headSha: status.headSha,
        confirmedUnmerged: confirmedUnqueued && pr?.merged === false
          && pr.headSha === status.headSha && pr.headRef === target.branch,
        reason,
      });
      ctx.onRoomChanged?.(cornerId);
      return { status: 'refused', reason };
    }
    // Do not depend on delivery of the closed webhook after a successful
    // merge. A failed confirmation is settled by the merge webhook or merged-PR reconciliation.
    try {
      const token = await ctx.app.installationToken(Number(target.installation_id), {
        repositoryIds: [Number(target.repository_id)],
      });
      const pr = await ctx.app.readPullRequest(token.token, target.full_name, target.number);
      if (pr.merged && pr.headSha === status.headSha && pr.headRef === target.branch)
        await ctx.recordConfirmedCornerMerge(target, target.full_name, target.number, pr);
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
  export async function gitHubOperationsCloseCornerPullRequest(ctx: GitHubOperations,
    cornerId: string,
  ): Promise<
    | { status: 'closed'; number: number; url: string; title: string }
    | { status: 'blocked'; blocker: string }
  > {
    const target = (
      await ctx.database.query<{
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
         JOIN corner_github_cache fact ON fact.corner_id=corner.id
         LEFT JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
           AND repository.active AND lower(repository.full_name)=lower(regexp_replace(regexp_replace(
             COALESCE(parent.repository_remote,parent.repository_key,''),
             '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         WHERE corner.id=$1 AND ${cornerRunOutcomeSql('corner.id')} IS DISTINCT FROM 'landed'`,
        [cornerId],
      )
    ).rows[0];
    if (!target) return { status: 'blocked', blocker: 'no corner found' };
    if (!target.number || !target.url)
      return { status: 'blocked', blocker: 'the corner has no pull request' };
    if (!target.repository_id || !target.installation_id || !target.full_name)
      return { status: 'blocked', blocker: 'the GitHub app cannot reach this repository' };
    await ctx.app.closePullRequest(
      Number(target.installation_id),
      Number(target.repository_id),
      target.full_name,
      target.number,
    );
    await ctx.recordClosedCornerPullRequest(cornerId, target.number);
    return {
      status: 'closed',
      number: target.number,
      url: target.url,
      title: target.title ?? `Pull request #${target.number}`,
    };
  }


  /** PR association and run state move together for tool calls and GitHub facts. */
  export async function gitHubOperationsRecordClosedCornerPullRequest(ctx: GitHubOperations,
    cornerId: string,
    number: number,
    database: SqlDatabase = ctx.database,
  ): Promise<void> {
    let changed = false;
    await database.transaction(async db => {
      await lockCornerLifecycle(db, cornerId);
      const removed = await db.query<{ archived: boolean }>(
        `UPDATE corner_github_cache fact SET
           lifecycle=(lifecycle-'pr'-'mergeQueue'-'checksSummary')||
             CASE WHEN corner.archived_at IS NULL THEN '{"lifecycle":"working","checks":"unknown"}'::jsonb
               ELSE '{}'::jsonb END
         FROM rooms corner WHERE fact.corner_id=$1 AND corner.id=fact.corner_id
           AND ${cornerRunOutcomeSql('fact.corner_id')} IS DISTINCT FROM 'landed'
           AND (fact.lifecycle->'pr'->>'number')::int=$2
         RETURNING corner.archived_at IS NOT NULL archived`,
        [cornerId, number],
      );
      if (!removed.rowCount) return;
      changed = true;
      await withdrawPullRequestMergeApprovals(db, cornerId, number);
      if (!removed.rows[0]!.archived)
        await advanceCorner(db, cornerId, { kind: 'pull-request-closed', number });
    });
    if (changed) ctx.onRoomChanged?.(cornerId);
  }


  /** Caller is authorized by DaemonService: it reaches the corner. */
  export async function gitHubOperationsReadCornerPullRequest(ctx: GitHubOperations, cornerId: string): Promise<CornerPullRequestResult> {
    const corner = (
      await ctx.database.query<{ parent_id: string; number: number | null }>(
        `SELECT corner.parent_id,(fact.lifecycle->'pr'->>'number')::int number
         FROM rooms corner JOIN corner_github_cache fact ON fact.corner_id=corner.id
         WHERE corner.id=$1 AND corner.parent_id IS NOT NULL`,
        [cornerId],
      )
    ).rows[0];
    if (!corner) return { status: 'blocked', blocker: 'corner not found' };
    if (!corner.number) return { status: 'blocked', blocker: 'the corner has no pull request' };
    const target = await ctx.roomWorkflowTarget(corner.parent_id);
    const [pr, discussion] = await Promise.all([
      ctx.app.readPullRequest(target.token, target.repository, corner.number),
      ctx.app.readPullRequestDiscussion(target.token, target.repository, corner.number),
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


  /**
   * Retry GitHub's asynchronous mergeability calculation for open corner PRs,
   * and re-read a stored 'dirty' PR so a conflict that GitHub has since
   * cleared stops re-firing the merge-conflict wake. An addressed refresh also
   * checks previously clean verdicts: checks can finish after the base moves
   * without a pull-request webhook carrying the new conflict.
   */
  export async function gitHubOperationsRefreshStaleMergeability(ctx: GitHubOperations,
    cornerId?: string,
    confirmedPr?: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>,
  ): Promise<void> {
    const rows = await ctx.database.query<{
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
              COALESCE(${cornerOwnerSql('corner.id')},corner.created_by) author_id,
              fact.lifecycle->'pr'->>'title' title,fact.lifecycle->'pr'->>'url' url,
              fact.lifecycle->'pr'->>'baseSha' base_sha,
              fact.lifecycle->'pr'->>'targetBranch' target_branch
       FROM corner_github_cache fact JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN github_repositories github ON github.installation_id=parent.github_installation_id
         AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND COALESCE(${cornerOwnerSql('corner.id')},corner.created_by) IS NOT NULL
         AND ($1::uuid IS NOT NULL OR fact.lifecycle->'pr'->>'mergeability' IN ('unknown','dirty','draft'))
         AND fact.lifecycle->'pr'->>'number' ~ '^[0-9]+$'
         AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL
         AND ($1::uuid IS NULL OR fact.corner_id=$1)`,
      [cornerId ?? null],
    );
    for (const row of rows.rows) {
      try {
        const token = await ctx.app.installationToken(Number(row.installation_id), {
          repositoryIds: [Number(row.repository_id)],
        });
        const pr = cornerId && confirmedPr?.number === row.number
          ? confirmedPr
          : await ctx.app.readPullRequest(token.token, row.repository, row.number);
        if (pr.mergeability === 'unknown') continue;
        const staleBase = Boolean(
          row.base_sha &&
            row.base_sha !== pr.baseSha &&
            (!pr.baseSha ||
              (await ctx.app.readBranchHead(token.token, row.repository, row.target_branch)) !==
                pr.baseSha),
        );
        // GitHub can leave a conflicting PR's base sha behind the branch head
        // indefinitely. A conflict is still reported against the base already
        // recorded; any other verdict waits for GitHub to reach that base.
        if (staleBase && pr.mergeability !== 'dirty') continue;
        const baseSha = staleBase ? row.base_sha! : pr.baseSha;
        await ctx.database.transaction(async (tx) => {
          const current = (
            await tx.query<{ lifecycle: CornerLifecycleView }>(
              `SELECT lifecycle FROM corner_github_cache WHERE corner_id=$1 FOR UPDATE`,
              [row.corner_id],
            )
          ).rows[0]?.lifecycle;
          if (
            !current?.pr ||
            current.pr.number !== row.number ||
            current.pr.headSha !== pr.headSha ||
            (current.pr.baseSha ?? null) !== row.base_sha ||
            (!cornerId && current.pr.mergeability !== 'unknown' && current.pr.mergeability !== 'dirty' && current.pr.mergeability !== 'draft')
          )
            return;
          await ctx.updateLifecycle(
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
            verb: systemMessage("github-operations.found-merge-conflicts-in"),
            object: {
              text: row.title ?? systemMessage("github-operations.pull-request-2", row.number),
              url: row.url,
              headSha: pr.headSha,
            },
            cardType: 'github-corner-note',
          });
          await queueCornerMergeConflict(tx, row.corner_id, note.id);
          if (note.inserted) ctx.onRoomChanged?.(row.corner_id);
        });
      } catch (error) {
        console.error(`[server] mergeability refresh failed for corner ${row.corner_id}:`, error);
      }
    }
  }
