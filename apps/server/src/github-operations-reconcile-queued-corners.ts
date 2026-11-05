import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerObjectiveSql } from './corner-objective.js';
import { cornerOwnerSql } from './corner-worker.js';
import { cornerFeatureBranchSql } from './corner-branch.js';
import { GitHubAppClient, githubMergeability } from '@beeline/auth/github';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import { advanceCorner, lockCornerLifecycle, cornerMergeGate } from './corner-lifecycle.js';
import { GitHubOperations, hash, record, GitHubRecord, text, integer, CornerWebhookTarget, repositoryName, branchForEvent, githubUrl, checkFact } from './github-operations.js';



  /** Reconcile committed queue facts against GitHub; never enqueue from a wake. */
  /**
   * Settles merge-queue entries against the live gate. For one corner (a hold,
   * a withdrawn yes, a merge attempt) it reads GitHub's queue live even when no
   * entry is cached, so an enqueue whose response was lost is still dequeued
   * once the gate closes.
   */
  export async function gitHubOperationsReconcileQueuedCorners(ctx: GitHubOperations, cornerId?: string): Promise<void> {
    const rows = (await ctx.database.query<CornerWebhookTarget & {
      repository: string; number: number; head_sha: string; combined_sha: string | null; cached: boolean;
    }>(`SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
      COALESCE(${cornerOwnerSql('corner.id')},corner.created_by,parent.created_by) author_id,${cornerObjectiveSql('corner')} summary,
      repository.repository_id,repository.installation_id,repository.full_name repository,
      (fact.lifecycle->'pr'->>'number')::int number,
      COALESCE(fact.lifecycle->'mergeQueue'->>'headSha',fact.lifecycle->'pr'->>'headSha') head_sha,
      fact.lifecycle->'mergeQueue'->>'combinedSha' combined_sha,
      fact.lifecycle ? 'mergeQueue' cached
      FROM corner_github_cache fact JOIN rooms corner ON corner.id=fact.corner_id
      JOIN rooms parent ON parent.id=corner.parent_id
      JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
        AND repository.active AND lower(repository.full_name)=lower(regexp_replace(regexp_replace(
          COALESCE(parent.repository_remote,parent.repository_key,''),
          '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
      WHERE corner.archived_at IS NULL
        AND (fact.lifecycle ? 'mergeQueue' OR ($1::uuid IS NOT NULL AND fact.lifecycle->'pr'->>'number' ~ '^[1-9][0-9]*$'))
        AND ($1::uuid IS NULL OR corner.id=$1)`, [cornerId ?? null])).rows;
    for (const row of rows) {
      try {
        const token = await ctx.app.installationToken(Number(row.installation_id), {
          repositoryIds: [Number(row.repository_id)], permissions: { contents: 'write', pull_requests: 'write' },
        });
        const pr = await ctx.app.readPullRequest(token.token, row.repository, row.number);
        if (pr.merged) {
          if (pr.headSha === row.head_sha) await ctx.recordConfirmedCornerMerge(row, row.repository, row.number, pr);
          continue;
        }
        const queue = await ctx.app.readPullRequestQueue(token.token, row.repository, row.number);
        // Nothing queued and nothing recorded: no merge is waiting in the queue.
        if (!queue.entry && !row.cached) continue;
        const gate = await cornerMergeGate(ctx.database, row.corner_id, { number: row.number, headSha: row.head_sha });
        if (queue.entry && gate.open && queue.headSha === row.head_sha) {
          await ctx.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{mergeQueue}',
              jsonb_build_object('headSha',$2::text,'combinedSha',$3::text))
            WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2`,
            [row.corner_id, row.head_sha, queue.entry.headCommit?.oid ?? row.combined_sha ?? '']);
          continue;
        }
        if (queue.entry) await ctx.app.dequeuePullRequest(token.token, queue.id);
        const combined = queue.entry?.headCommit?.oid ?? row.combined_sha;
        const rollup = combined ? await ctx.app.readCommitCheckRollup(token.token, row.repository, combined) : undefined;
        const reason = !gate.open ? 'Removed from the merge queue because approval was withdrawn or a hold stands'
          : `Removed from the merge queue: ${rollup?.failing.join(', ') || 'GitHub removed the entry before merging'}`;
        await ctx.database.transaction(async db => {
          await lockCornerLifecycle(db, row.corner_id);
          const changed = await db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'mergeQueue'
            WHERE corner_id=$1 AND COALESCE(lifecycle->'mergeQueue'->>'headSha',lifecycle->'pr'->>'headSha')=$2
            RETURNING 1`, [row.corner_id, row.head_sha]);
          if (!changed.rowCount) return;
          await advanceCorner(db, row.corner_id, { kind: 'merge-refused', headSha: row.head_sha, confirmedUnmerged: true, reason });
        });
        ctx.onRoomChanged?.(row.corner_id);
      } catch (error) {
        console.error(`[github] queue reconciliation failed for ${row.corner_id}:`, error);
      }
    }
  }


  export async function gitHubOperationsRecordConfirmedCornerMerge(ctx: GitHubOperations,
    target: CornerWebhookTarget, repository: string, number: number,
    pr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>,
  ) {
    if (!pr.headRef) return;
    await ctx.mergeCorner(target, {
      repository, branch: pr.headRef, number, url: pr.url,
      title: pr.title ?? `Pull request #${number}`, targetBranch: pr.baseRef, headSha: pr.headSha,
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
      ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
      ...(pr.mergedBy ? { mergedBy: pr.mergedBy } : {}),
      commits: 0, files: 0,
    }, ctx.database, number);
  }


  export async function gitHubOperationsProcessBaseBranchPush(ctx: GitHubOperations, body: GitHubRecord, installationId: number): Promise<void> {
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
    const affected = await ctx.database.query<{
      corner_id: string;
      repository_id: string;
      base_sha: string | null;
      head_sha: string;
    }>(
      `SELECT fact.corner_id,github.repository_id,
              fact.lifecycle->'pr'->>'baseSha' base_sha,
              fact.lifecycle->'pr'->>'headSha' head_sha
       FROM corner_github_cache fact
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
    const token = await ctx.app.installationToken(installationId, {
      repositoryIds: [Number(affected.rows[0]!.repository_id)],
    });
    const baseSha = await ctx.app.readBranchHead(token.token, repository, branch);
    for (const row of affected.rows) {
      let changed = false;
      await ctx.database.transaction(async (tx) => {
        const lifecycle = (
          await tx.query<{ lifecycle: CornerLifecycleView }>(
            `SELECT lifecycle FROM corner_github_cache WHERE corner_id=$1 FOR UPDATE`,
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
        await ctx.updateLifecycle(
          row.corner_id,
          {
            pr: { ...lifecycle.pr, baseSha, mergeability: 'unknown' },
          },
          tx,
        );
        changed = true;
      });
      if (changed) await ctx.refreshStaleMergeability(row.corner_id);
    }
  }


  /**
   * Room-level repository activity. Issues and pull requests post on
   * opened/closed. Raw pushes and CI do NOT post: commit churn and
   * mainline check results are not Room conversation. Corner PRs use the
   * same repository events; CI stays on processCornerEvent.
   */
  export async function gitHubOperationsProcessRepositoryEvent(ctx: GitHubOperations, event: string, body: GitHubRecord, installationId: number) {
    const database = ctx.database;
    if (event !== 'issues' && event !== 'pull_request') return;
    const repository = repositoryName(body);
    if (!repository) return;

    const actor = text(record(body.sender)?.login) || systemMessage("github-operations.github");
    const action = text(body.action);
    if (action !== 'opened' && action !== 'closed') return;
    const subject = record(body[event === 'issues' ? 'issue' : 'pull_request']);
    const title = text(subject?.title)?.trim();
    const url = githubUrl(subject?.html_url);
    if (!title || !url) return;
    const merged = event === 'pull_request' && action === 'closed' && subject?.merged === true;
    const cardAction = merged ? systemMessage("github-operations.merged") : action;
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
           AND $4::text IS NOT NULL AND ${cornerFeatureBranchSql('corner')}=$4
           AND NOT EXISTS (
               SELECT 1 FROM rooms other JOIN rooms other_parent ON other_parent.id=other.parent_id
               WHERE other.id<>corner.id AND ${cornerFeatureBranchSql('other')}=$4
                 AND other_parent.github_installation_id=$1
                 AND lower(regexp_replace(regexp_replace(
                   COALESCE(other_parent.repository_remote,other_parent.repository_key,''),
                   '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2))
         ORDER BY corner.created_at,corner.id LIMIT 1
       ) destination ON true
       LEFT JOIN LATERAL(
         SELECT membership.identity_id FROM room_access membership
         WHERE membership.room_id=room.id AND membership.removed_at IS NULL
         ORDER BY membership.joined_at LIMIT 1
       )author ON true
       WHERE room.parent_id IS NULL AND room.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM messages callsite
           WHERE callsite.card_type='daemon-fact'
             AND callsite.card->>'cornerId'=destination.corner_id::text
             AND callsite.card->>'type' IN ('corner-open','corner-complete')
             AND callsite.card->>'sourceMessageId' IS NOT NULL
             AND callsite.room_id<>room.id)
         AND room.github_installation_id=$1
         AND COALESCE(room.created_by,author.identity_id) IS NOT NULL
         AND lower(regexp_replace(regexp_replace(
           COALESCE(room.repository_remote,room.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)`,
      [installationId, repository, event === 'pull_request' ? url : null,
        fallbackBranch],
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
      if (note.inserted) ctx.onRoomChanged?.(room.room_id);
    }
  }


  export async function gitHubOperationsProcessCornerEvent(ctx: GitHubOperations, event: string, body: GitHubRecord, installationId: number) {
    const database = ctx.database;
    const repository = repositoryName(body);
    const branch = branchForEvent(event, body);
    if (!repository || !branch) return;
    const headRepository = event === 'pull_request'
      ? text(record(record(record(body.pull_request)?.head)?.repo)?.full_name)
      : undefined;
    const cornerPrefix = headRepository && headRepository.toLowerCase() !== repository.toLowerCase()
      ? null
      : /^feature\/corner-([0-9a-f]{12})$/.exec(branch)?.[1] ?? null;
    const matches = await ctx.database.query<CornerWebhookTarget & {
      has_pr: boolean;
      pr_number: string | null;
    }>(
      `SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
         COALESCE(${cornerOwnerSql('corner.id')},first_agent.author_id,corner.created_by,parent.created_by) author_id,
         ${cornerObjectiveSql('corner')} summary,
         fact.lifecycle->'pr' IS NOT NULL has_pr,
         fact.lifecycle->'pr'->>'number' pr_number,
         github.repository_id,github.installation_id
       FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_github_cache fact ON fact.corner_id=corner.id
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
       )first_agent ON ${cornerOwnerSql('corner.id')} IS NULL
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND $3::text IS NOT NULL AND ${cornerFeatureBranchSql('corner')}=$3
         AND NOT EXISTS (
           SELECT 1 FROM rooms other JOIN rooms other_parent ON other_parent.id=other.parent_id
           WHERE other.id<>corner.id AND ${cornerFeatureBranchSql('other')}=$3
             AND other_parent.github_installation_id=$1
             AND lower(regexp_replace(regexp_replace(
               COALESCE(other_parent.repository_remote,other_parent.repository_key,''),
               '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2))
         AND parent.github_installation_id=$1
         AND lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)`,
      [installationId, repository, cornerPrefix ? branch : null],
    );
    const targets = matches.rows;
    const actorLogin = text(record(body.sender)?.login);
    const actor = (login?: string) =>
      login ? { kind: 'github' as const, name: login } : GITHUB_SUBJECT;
    for (const target of targets) {
      if (!target.author_id) continue;
      if (event === 'pull_request') {
        const pullRequest = record(body.pull_request);
        const title =
          text(pullRequest?.title) ?? systemMessage("github-operations.pull-request-3", integer(pullRequest?.number) ?? '');
        const url = text(pullRequest?.html_url);
        const merged = body.action === 'closed' && pullRequest?.merged === true;
        const number = integer(pullRequest?.number);
        // A replacement can arrive before the previous close webhook.
        // Confirm both live states before replacing the association; delayed
        // events for an older PR must never displace its newer replacement.
        const recordedPrNumber = target.pr_number ? Number(target.pr_number) : undefined;
        if (recordedPrNumber && number && recordedPrNumber !== number) {
          if (number < recordedPrNumber || !['opened', 'reopened'].includes(String(body.action))) continue;
          const token = await ctx.app.installationToken(Number(target.installation_id), {
            repositoryIds: [Number(target.repository_id)],
          });
          const previous = await ctx.app.readPullRequest(token.token, repository, recordedPrNumber);
          if (previous.state !== 'closed' || previous.merged) continue;
          const replacement = await ctx.app.readPullRequest(token.token, repository, number);
          if (replacement.state !== 'open' || replacement.headRef !== branch) continue;
          await ctx.recordClosedCornerPullRequest(target.corner_id, recordedPrNumber, database);
        }
        const targetBranch = text(record(pullRequest?.base)?.ref);
        const webhookBaseSha = text(record(pullRequest?.base)?.sha);
        let headSha = text(record(pullRequest?.head)?.sha);
        // Reopening may be delivered after a push with the closed PR's old
        // head. Restore the association from GitHub, not that cached payload.
        if (body.action === 'reopened' && number) {
          const token = await ctx.app.installationToken(Number(target.installation_id), {
            repositoryIds: [Number(target.repository_id)],
          });
          const live = await ctx.app.readPullRequest(token.token, repository, number);
          if (live.state === 'closed' || live.merged) continue;
          headSha = live.headSha;
        }
        const mergeabilityValue = text(pullRequest?.mergeable_state);
        let mergeability = pullRequest?.draft === true ? 'draft' as const : githubMergeability(mergeabilityValue);
        let differentPr = false;
        if (!merged && url && number && targetBranch && headSha && body.action !== 'closed') {
          await database.transaction(async (tx) => {
            const previous = (
              await tx.query<{ lifecycle: CornerLifecycleView }>(
                `SELECT lifecycle FROM corner_github_cache WHERE corner_id=$1 FOR UPDATE`,
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
            await ctx.updateLifecycle(
              target.corner_id,
              {
                lifecycle: 'in-review',
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
            await ctx.refreshStaleMergeability(target.corner_id);
          if (body.action === 'opened' || body.action === 'synchronize' || body.action === 'reopened')
            await ctx.refreshCheckRollup({ ...target, has_pr: true, pr_number: String(number) }, repository,
              { name: 'Pull request checks', status: 'pending', headSha, url }, database);
        }
        if (merged && url) {
          await ctx.mergeCorner(
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
          await ctx.recordClosedCornerPullRequest(target.corner_id, number, database);
        } else if (body.action === 'opened' && url) {
          await ctx.systemNote(
            target.corner_id,
            target.author_id,
            {
              subject: actor(text(record(pullRequest?.user)?.login) ?? actorLogin),
              verb: systemMessage("github-operations.opened-a-pull-request"),
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
          const lifecycle = await ctx.lifecycle(target.corner_id, database);
          await ctx.updateLifecycle(
            target.corner_id,
            {
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
        await ctx.systemNote(
          target.corner_id,
          target.author_id,
          {
            subject: actor(text(record(body.pusher)?.name) ?? actorLogin),
            verb: systemMessage("github-operations.pushed"),
            object: {
              text: `${commits ? systemMessage("github-operations.commit-to", commits, commits === 1 ? '' : systemMessage("github-operations.s")) : ''}${branch}`,
              ...(compare ? { url: compare } : {}),
            },
            ...(head ? { consequence: systemMessage("github-operations.at", head.slice(0, 12)) } : {}),
          },
          `github:push:${text(body.after) ?? hash(JSON.stringify(body))}`,
          database,
        );
        continue;
      }
      const check = checkFact(event, body);
      if (check?.headSha) await ctx.refreshCheckRollup(target, repository, check, database);
    }
  }
