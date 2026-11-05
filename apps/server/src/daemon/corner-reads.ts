import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerObjectiveSql } from '../corner-objective.js';
import { cornerFeatureBranch } from '../corner-branch.js';
import { cornerKindSql, cornerOpenedFromSql, cornerRequestSql } from '../corner-opening.js';
import { cornerOwnerSql } from '../corner-worker.js';
import { missingReviewAttachments } from '../review-evidence.js';
import { assertIndependentCornerReviewer } from '../corner-reviewer.js';
import { CommandRefusalError } from '../commander.js';
import { activeCornerHolds } from '../corner-holds.js';
import { cornerFactsSql, cornerRowState, type CornerStateRow } from '../chat-corner-counts.js';
import { CornerVerdictRejectedError, recordCornerMergeApproval, isZeroCheckCommander } from '../corner-merge-approval.js';
import { cornerImplementerSql } from '../corner-worker.js';
import { CORNER_BRIEF_REVISION_SELECT, type CornerBriefRow, currentCornerBrief, projectCornerBrief } from '../corner-brief.js';
import { type SqlDatabase } from '../database.js';
import { advanceCorner, lockCornerLifecycle } from '../corner-lifecycle.js';
import { systemLine } from '../system-line.js';
import { isCornerReviewer } from '../agent-health.js';
import { cornerLifecycleSql } from '../corner-github-cache.js';
import type { DaemonContext } from './context.js';
import { id, Input, Output, seconds } from './values.js';
import { daemonReach } from './corner-messages.js';
import { daemonIdentity, daemonAccess } from './access.js';


  /**
   * The corners of this Room that this agent may carry.
   *
   * The branch on GitHub is the shared artifact. Parent Room access is the
   * authority, so every parent Room agent lists the corner
   * and can be addressed in it. The derived owner (`cornerOwnerSql`) is the
   * historical "opened by" — it still names `createdBy` here, and the phone
   * still shows it — but it no longer decides who may work. Listing on the
   * opener alone is what made the motivating incident silent: a helper that
   * never learns a corner exists never polls it, so a mention that resolved
   * perfectly produced no turn and no error.
   *
   * The opener is read with the same fallback `getAgentConfiguration` uses to
   * decide `reviewerHandle` — `COALESCE(owner_agent_id, created_by)` — because
   * the two answers meet in the reviewer's session. A corner whose
   * `owner_agent_id` predates the backfill would otherwise be reported as
   * opened by whoever happens to be polling, and a reviewer told by one query
   * that it holds the post is told by the other that it wrote the code: the
   * turn boots without `BEELINE_CORNER_REVIEWER` and never receives the
   * reviewer instruction naming the head to review. Reconciliation resurrects
   * exactly the old heads where that record is thinnest, so the two
   * derivations must agree.
   */
  /** `reachable` lists every corner under the Room instead of only the caller's own. */
  export async function daemonCorners(ctx: DaemonContext, roomId: string, agentId: string, activeOnly = false, reachable = false) {
    const rows = await ctx.database.query<{
      id: string;
      parent_id: string;
      created_by: string | null;
      archived: boolean;
      closed_at: Date | null;
      lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
      name: string;
      objective: string;
    }>(
      `SELECT r.id,r.parent_id,r.name,r.archived_at closed_at,${cornerObjectiveSql('r')} objective,${cornerLifecycleSql('f.corner_id')},
              COALESCE(${cornerOwnerSql('r.id')},r.created_by) created_by,
              r.archived_at IS NOT NULL archived
       FROM rooms r JOIN corner_facts f ON f.corner_id=r.id
       WHERE (r.parent_id=$1 OR (EXISTS(SELECT 1 FROM rooms dm WHERE dm.id=$1 AND dm.direct_participants IS NOT NULL)
         AND EXISTS(SELECT 1 FROM memberships target WHERE target.room_id=r.parent_id AND target.identity_id=$2 AND target.removed_at IS NULL))) ${activeOnly ? 'AND r.archived_at IS NULL' : ''} AND ($3 OR EXISTS(
         SELECT 1 FROM memberships m
         WHERE m.room_id=COALESCE(r.parent_id,r.id) AND m.identity_id=$2 AND m.removed_at IS NULL))`,
      [roomId, agentId, reachable],
    );
    return {
      corners: rows.rows.map((row) => ({
        cornerId: row.id,
        parentRoomId: row.parent_id,
        createdBy: row.created_by ?? agentId,
        archived: row.archived,
        ...(row.closed_at
          ? { closedAt: Math.floor(new Date(row.closed_at).getTime() / 1_000) }
          : {}),
        ...(row.lifecycle?.pr?.number ? { pullRequestNumber: row.lifecycle.pr.number } : {}),
        ...(row.lifecycle?.pr?.mergeCommitSha
          ? { mergeCommitSha: row.lifecycle.pr.mergeCommitSha }
          : {}),
        name: row.name,
        objective: row.objective,
      })),
    };
  }

  export async function daemonCornerRestore(ctx: DaemonContext, cornerId: string, agentId: string) {
    const brief = await currentCornerBrief(ctx.database, cornerId);
    const facts = cornerFactsSql('$2');
    const row = (
      await ctx.database.query<CornerStateRow & {
        parent_room_id: string;
        opened_from_corner_id: string | null;
        objective: string;
        implementer_agent_id: string | null;
        title: string;
        kind: 'agent' | 'human';
        request_id: string | null;
        lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
        pull_request_number: number | null;
        approval_head_sha: string | null;
        last_author_id: string | null;
        last_created_at: Date | null;
        last_type: 'message' | 'system' | null;
        last_excerpt: string | null;
      }>(
        `SELECT c.parent_id parent_room_id,c.archived_at,${facts.columns},
           ${cornerOpenedFromSql('c.id')} opened_from_corner_id,${cornerImplementerSql('f', 'c')} implementer_agent_id,${cornerObjectiveSql('c')} objective,c.name title,${cornerKindSql('c.id')} kind,${cornerRequestSql('c.id')} request_id,
           approval.pull_request_number,approval.head_sha approval_head_sha,
           lm.author_id last_author_id,lm.created_at last_created_at,
           lm.presentation last_type,left(lm.text,280) last_excerpt
         FROM rooms c ${facts.joins}
         LEFT JOIN corner_merge_approvals approval ON approval.corner_id=c.id
         WHERE c.id=$1 AND f.corner_id IS NOT NULL`,
        [cornerId, agentId],
      )
    ).rows[0];
    const derived = row ? cornerRowState(row) : undefined;
    const holds = await activeCornerHolds(ctx.database, cornerId);
    const held = holds.length > 0;
    return {
      cornerId,
      ...(row?.implementer_agent_id ? { implementerAgentId: row.implementer_agent_id } : {}),
      ...(row ? { archived: Boolean(row.archived_at), parentRoomId: row.parent_room_id } : {}),
      ...(row?.opened_from_corner_id ? { openedFromCornerId: row.opened_from_corner_id } : {}),
      objective: row?.objective ?? '',
      ...(held ? { held: true } : {}),
      holds,
      ...(brief ? { brief } : {}),
      ...(row ? { title: row.title, kind: row.kind } : {}),
      // The phone's generated name stands until the agent writes its first brief.
      ...(row?.kind === 'human' && !brief ? { titleGenerated: true } : {}),
      ...(row ? { featureBranch: cornerFeatureBranch(cornerId) } : {}),
      ...(row?.request_id ? { requestId: row.request_id } : {}),
      closeRequested: Boolean(row?.archived_at),
      ...(row?.lifecycle ? { lifecycle: { ...row.lifecycle, branch: cornerFeatureBranch(cornerId) } } : {}),
      ...(row?.pull_request_number && row.approval_head_sha
        ? {
            mergeApproval: {
              pullRequestNumber: row.pull_request_number,
              headSha: row.approval_head_sha,
            },
          }
        : {}),
      ...(derived
        ? { state: derived.state, activity: derived.state === 'working' || derived.state === 'review' ? ('running' as const) : ('idle' as const) }
        : {}),
      ...(row?.last_author_id && row.last_created_at && row.last_type
        ? {
            lastMessage: {
              authorId: row.last_author_id,
              createdAt: row.last_created_at.toISOString(),
              type: row.last_type,
              excerpt: row.last_excerpt ?? '',
            },
          }
        : {}),
      ...(derived?.state === 'waiting' ? { awaiting: 'reply' as const } : {}),
    };
  }

  export async function daemonListCornerBriefRevisions(ctx: DaemonContext, 
    input: Input<'listCornerBriefRevisions'>,
    agentId: string,
  ) {
    await daemonReach(ctx, input.cornerId, agentId);
    if (
      input.beforeRevision !== undefined &&
      (!Number.isInteger(input.beforeRevision) || input.beforeRevision < 1)
    )
      throw new Error('invalid brief revision cursor');
    if (
      input.afterRevision !== undefined &&
      (!Number.isInteger(input.afterRevision) || input.afterRevision < 0)
    )
      throw new Error('invalid brief revision cursor');
    const limit = input.limit ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid brief revision limit');
    const rows = (
      await ctx.database.query<CornerBriefRow>(
        `${CORNER_BRIEF_REVISION_SELECT}
       WHERE brief.corner_id=$1 AND ($2::integer IS NULL OR brief.revision<$2)
         AND ($4::integer IS NULL OR brief.revision>$4)
       ORDER BY brief.revision DESC LIMIT $3`,
        [input.cornerId, input.beforeRevision ?? null, limit + 1, input.afterRevision ?? null],
      )
    ).rows;
    return {
      revisions: rows.slice(0, limit).map((row) => projectCornerBrief(input.cornerId, row)),
      ...(rows.length > limit ? { nextBeforeRevision: rows[limit - 1]!.revision } : {}),
    };
  }

  /**
   * The implementer starts its own merge through the one merge path
   * (`landCorner`). Only the corner's implementer may call it; it merges only
   * when `pr_checks_status` reports `mergeAllowed`, and otherwise names the
   * blocker.
   */
  export async function daemonMergeCorner(ctx: DaemonContext, input: Input<'mergeCorner'>, agentId: string): Promise<Output<'mergeCorner'>> {
    const corner = (
      await ctx.database.query<{ worker_agent_id: string | null; head_sha: string | null; archived: boolean }>(
        `SELECT ${cornerImplementerSql('fact', 'corner')} worker_agent_id,
                ${cornerLifecycleSql('fact.corner_id')}->'pr'->>'headSha' head_sha,
                corner.archived_at IS NOT NULL archived
         FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
         WHERE fact.corner_id=$1`,
        [input.cornerId],
      )
    ).rows[0];
    await daemonReach(ctx, input.cornerId, agentId);
    if (!corner) throw new Error('corner not found');
    if (!corner.head_sha) return { status: 'blocked', blocker: corner.archived ? 'the corner is closed' : 'the corner has no pull request' };
    if (!ctx.prChecksStatus)
      return { status: 'blocked', blocker: corner.archived ? 'the corner is closed' : 'GitHub is not configured on this server' };
    const gate = await ctx.prChecksStatus({ cornerId: input.cornerId });
    if (!gate.mergeAllowed && !(gate.blockedReason === 'PR is a draft' && gate.checks === 'passed' && gate.approved && !gate.held)) {
      return { status: 'blocked', blocker: gate.blockedReason ?? 'the merge gate is closed', holds: gate.holds };
    }
    if (!ctx.landCorner) return { status: 'blocked', blocker: 'GitHub is not configured on this server' };
    let blocker = 'the merge did not start; read the current checks before retrying';
    const landed = await ctx.landCorner(input.cornerId, reason => { blocker = reason; });
    if (landed.status === 'not-attempted')
      return { status: 'blocked', blocker, holds: await activeCornerHolds(ctx.database, input.cornerId) };
    if (landed.status === 'refused') return { status: 'blocked', blocker: landed.reason };
    return { status: landed.status === 'queued' ? 'queued' : 'merge-started', headSha: corner.head_sha };
  }


  /**
   * Any corner member closes the corner's own pull request without merging.
   * Membership is checked by `access` before dispatch; the close itself and
   * the lifecycle update live in `GitHubOperations.closeCornerPullRequest`.
   */
  export async function daemonCloseCornerPullRequest(ctx: DaemonContext, 
    input: Input<'closeCornerPullRequest'>,
    agentId: string,
  ): Promise<Output<'closeCornerPullRequest'>> {
    // The generic gate checks the turn's roomId; the target corner needs its own check.
    await daemonReach(ctx, input.cornerId, agentId);
    if (!ctx.closePullRequest)
      return { status: 'blocked', blocker: 'GitHub is not configured on this server' };
    const closed = await ctx.closePullRequest(input.cornerId);
    if (closed.status === 'blocked') return closed;
    await systemLine(ctx.database, {
      roomId: input.cornerId,
      subject: { kind: 'agent', id: agentId, name: (await daemonIdentity(ctx, agentId)).name },
      verb: systemMessage("daemon-service.closed"),
      object: { text: closed.title, url: closed.url },
    });
    return { status: 'closed', pullRequestNumber: closed.number, url: closed.url };
  }


  /**
   * The reviewer's PASS (or the commander's yes on a completed zero-check head
   * without a reviewer), from any reachable corner turn: nothing
   * here depends on how the reviewer's session booted. The server authorizes
   * the caller and the exact head, records the yes, and reports it to the
   * corner lifecycle in the same transaction, which wakes the implementer to
   * merge.
   */
  export async function daemonCheckReviewerAuthors(ctx: DaemonContext, db: SqlDatabase, cornerId: string, agentId: string) {
    const pr = (await db.query(`SELECT 1 FROM corner_github_cache WHERE corner_id=$1
      AND lifecycle->'pr'->>'number' IS NOT NULL`, [cornerId])).rowCount;
    if (!pr) return;
    if (!ctx.github) throw new CommandRefusalError('GitHub is required to verify reviewer independence on this PR', 409);
    await ctx.github.assertCornerReviewerNotAuthor(cornerId, agentId, db);
  }


  export async function daemonApproveCornerMerge(ctx: DaemonContext, input: Input<'approveCornerMerge'>, agentId: string) {
    const approved = await ctx.database.transaction(async (db) => {
      await lockCornerLifecycle(db, input.cornerId);
      const target = (
        await db.query<{
          pull_request_number: number | null;
          head_sha: string | null;
        }>(
          `SELECT (fact.lifecycle->'pr'->>'number')::int pull_request_number,
                fact.lifecycle->'pr'->>'headSha' head_sha
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_github_cache fact ON fact.corner_id=corner.id
         WHERE corner.id=$1`,
          [input.cornerId],
        )
      ).rows[0];
      if (!target || (!(await isCornerReviewer(db, input.cornerId, agentId)) &&
        !(await isZeroCheckCommander(db, input.cornerId, agentId))))
        throw new CornerVerdictRejectedError(
          'NOT_CONFIGURED_REVIEWER',
          "only this corner's configured reviewer (or the Room reviewer when unset), or its zero-check commander, can record PASS; set reviewer with revise_corner",
        );
      if (!target.pull_request_number || !target.head_sha)
        throw new CornerVerdictRejectedError('NO_PULL_REQUEST', 'corner has no pull request');
      if (target.head_sha !== input.headSha)
        throw new CornerVerdictRejectedError(
          'STALE_HEAD',
          `pull request head is ${target.head_sha}; review the current head before approving`,
        );
      await assertIndependentCornerReviewer(db, input.cornerId, agentId,
        (id, reviewer) => daemonCheckReviewerAuthors(ctx, db, id, reviewer));
      if (await missingReviewAttachments(db, input.cornerId, {headSha: target.head_sha, number: target.pull_request_number}, agentId))
        throw new CommandRefusalError('missing review attachments: attach the screenshots or files claimed by the verdict',409);
      await recordCornerMergeApproval(db, {
        cornerId: input.cornerId,
        approvedBy: agentId,
        pullRequestNumber: target.pull_request_number,
        headSha: target.head_sha,
      });
      await advanceCorner(db, input.cornerId, { kind: 'approval', headSha: target.head_sha, by: 'reviewer' });
      return {
        pullRequestNumber: target.pull_request_number,
        headSha: target.head_sha,
        status: 'approved' as const,
      };
    });
    // A reviewer's PASS lands at once through the one merge path, like a
    // person's yes. The live gate still decides: pending checks, a hold or a
    // brief without repository work leave the recorded yes waiting.
    if (ctx.landCorner) {
      try {
        await ctx.landCorner(input.cornerId);
      } catch (error) {
        console.error(`[server] reviewer PASS on corner ${input.cornerId} did not land:`, error);
      }
    }
    return approved;
  }

  export async function daemonRepository(ctx: DaemonContext, roomId: string, agentId: string) {
    await daemonAccess(ctx, roomId, agentId);
    const row = (
      await ctx.database.query<{
        repository_key: string | null;
        repository_remote: string | null;
        repository_target_branch: string;
        repository_resolution: 'repository' | 'none' | 'unverified';
        direct_participants: string[] | null;
      }>(
        `SELECT repository_key,repository_remote,repository_target_branch,repository_resolution,direct_participants FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    if (row?.repository_resolution === 'unverified') return { resolution: 'unverified' as const };
    if (row?.repository_resolution === 'repository' || row?.repository_key)
      return {
        key: row.repository_key ?? undefined,
        remote: row.repository_remote ?? undefined,
        targetBranch: row.repository_target_branch,
        resolution: 'repository' as const,
      };
    return {
      resolution: 'none' as const,
      ...(row?.direct_participants?.length === 2
        ? { directParticipants: row.direct_participants }
        : {}),
    };
  }

  export async function daemonTargetBranch(ctx: DaemonContext, roomId: string, agentId: string) {
    await daemonAccess(ctx, roomId, agentId);
    const row = (
      await ctx.database.query<{ repository_target_branch: string; updated_at: Date }>(
        `SELECT repository_target_branch,updated_at FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('room not found');
    return { targetBranch: row.repository_target_branch, updatedAt: seconds(row.updated_at) };
  }
