import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { deleteArchivedCornerBranch } from './corner-branch-cleanup.js';
import { GitHubAppClient, GitHubHttpError, transientGitHubError } from '@beeline/auth/github';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { GITHUB_SUBJECT, systemLine, type SystemPhrase } from './system-line.js';
import { archiveCornerState, lockCornerArchivalAuthority } from './corner-close.js';
import { advanceCorner, lockCornerLifecycle } from './corner-lifecycle.js';
import { reconcileCornerMergeBlockers, routeSystemCommand } from './agent-command.js';
import { GitHubOperations, hash, text, CornerWebhookTarget, checkFact, checksRestarted, checksSettled, actionsJobId, jobErrorLines } from './github-operations.js';



  export async function gitHubOperationsRefreshCheckRollup(ctx: GitHubOperations,
    target: CornerWebhookTarget & { has_pr?: boolean; pr_number?: string | null }, repository: string,
    check: NonNullable<ReturnType<typeof checkFact>>, database: SqlDatabase,
    options?: { quiet?: boolean; snapshot?: {
      rollup: Awaited<ReturnType<GitHubAppClient['readCommitCheckRollup']>>;
      pr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>>;
      fetchStartedAt: number;
      token: string;
    } },
  ) {
    const checkHeadSha = check.headSha!;
    // An obsolete event cannot admit provider work for a head already replaced
    // in committed state. Later checks still fence a push during this read.
    const admitted = await ctx.lifecycle(target.corner_id, database);
    if (admitted.pr?.headSha && admitted.pr.headSha !== checkHeadSha) return;
    let fetchStartedAt = 0;
    let confirmedPr: Awaited<ReturnType<GitHubAppClient['readPullRequest']>> | undefined;
    try {
        // Use the database clock across server instances, with subsecond precision
        // to order overlapping fetches while keeping updatedAt in epoch seconds.
        fetchStartedAt = options?.snapshot?.fetchStartedAt ?? (await database.query<{ started_at: number }>(
          `SELECT extract(epoch FROM clock_timestamp())::double precision started_at`,
        )).rows[0]!.started_at;
        const token = options?.snapshot ?? await ctx.app.installationToken(Number(target.installation_id), {
          repositoryIds: [Number(target.repository_id)],
        });
        const rollup = options?.snapshot?.rollup ?? await ctx.app.readCommitCheckRollup(token.token, repository, checkHeadSha);
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
        const livePr = options?.snapshot?.pr ?? (target.pr_number && (rollup.state === 'passed' || rollup.state === 'failed' || failedChecks.length > 0)
          ? await ctx.app.readPullRequest(token.token, repository, Number(target.pr_number))
          : undefined);
        confirmedPr = livePr;
        if (livePr?.state === 'closed' && !livePr.merged) {
          await ctx.recordClosedCornerPullRequest(target.corner_id, Number(target.pr_number), database);
          return;
        }
        if (livePr?.merged) {
          // Checks can finish after the merge, before its closed webhook arrives.
          if (livePr.headRef) await ctx.mergeCorner(target, {
            repository, branch: livePr.headRef, title: livePr.title ?? `Pull request #${livePr.number}`,
            url: livePr.url, number: livePr.number, targetBranch: livePr.baseRef,
            headSha: livePr.headSha, mergedAt: livePr.mergedAt,
            mergeCommitSha: livePr.mergeCommitSha, mergedBy: livePr.mergedBy,
            commits: 0, files: 0,
          }, database, livePr.number);
          return;
        }
        if (livePr && livePr.headSha !== checkHeadSha) return;
        const beforeFetch = await ctx.lifecycle(target.corner_id, database);
        if (beforeFetch.pr?.headSha && beforeFetch.pr.headSha !== checkHeadSha) return;
        const oldReport = beforeFetch.checksSummary as (typeof beforeFetch.checksSummary & {
          reportedHeadSha?: string; reportedFailing?: readonly string[]; failureFollowupSent?: boolean;
          partialRepairSent?: boolean; attempt?: number;
        }) | undefined;
        const restarting = checksRestarted(oldReport?.checks, rollup.checks);
        const alreadyReported = oldReport?.reportedHeadSha === checkHeadSha && !restarting
          ? oldReport.reportedFailing ?? [] : [];
        const candidateFailures = failedChecks.filter(item => !alreadyReported.includes(item.name));
        // Logs for a newly failed job are readable while the rest of the run
        // is open. Skip the fetch only when a repair turn is already open.
        const repairOpen = alreadyReported.length > 0 && !checksSettled(rollup.checks)
          ? (await database.query(
              `SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_check'
                 AND state IN ('pending','claimed') LIMIT 1`,
              [target.corner_id],
            )).rowCount > 0
          : false;
        const logCandidates = candidateFailures.length &&
          (!alreadyReported.length || (checksSettled(rollup.checks) && !oldReport?.failureFollowupSent) || !repairOpen)
          ? candidateFailures : [];
        const jobLogs = await Promise.all(logCandidates.map(async item => {
          const jobId = actionsJobId(item.url);
          if (!jobId) return { name: item.name, ...(item.url ? { url: item.url } : {}) };
          try {
            const errorLines = jobErrorLines(await ctx.app.readJobLog(token.token, repository, jobId));
            return { name: item.name, url: item.url, jobId, ...(errorLines ? { errorLines } : {}) };
          } catch {
            return { name: item.name, url: item.url, jobId };
          }
        }));
        const providerCheck = check;
        let noteInserted = false;
        // Each replay starts with the provider fact, not a label from an aborted attempt.
        const refresh = (check = providerCheck) => database.transaction(async (database) => {
          noteInserted = false;
          await lockCornerLifecycle(database, target.corner_id);
          // Webhooks signal a refresh. Revalidate its head and age only after
          // the provider has replied, under the run lock then the fact row lock.
          const currentRow = (
            await database.query<{ lifecycle: CornerLifecycleView & {
              checksSummary?: { fetchStartedAt?: number };
            } }>(
              `SELECT lifecycle FROM corner_github_cache WHERE corner_id=$1 FOR UPDATE`,
              [target.corner_id],
            )
          ).rows[0];
          if (!currentRow) return;
          const current = currentRow.lifecycle;
          if (livePr && current.pr?.number !== livePr.number) return;
          // GitHub may deliver a completed run for the previous branch head after a push.
          if (current.pr?.headSha && checkHeadSha !== current.pr.headSha) return;
          // A PR removed during the fetch invalidates it; a pre-PR corner can record checks.
          if (target.has_pr && !current.pr?.headSha) return;
          const latestFetch = current.checksSummary?.fetchStartedAt ?? current.checksSummary?.updatedAt ?? 0;
          if (fetchStartedAt < latestFetch) return;
          // An empty rollup is only "no checks" once GitHub says so; a null
          // rollup (state pending) is the race before workflows register.
          await database.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'checkRefreshRetry'
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
            reportedHeadSha?: string; reportedFailing?: readonly string[]; failureFollowupSent?: boolean;
            partialRepairSent?: boolean; attempt?: number;
          }) | undefined;
          const sameReportedHead = priorReport?.reportedHeadSha === checkHeadSha;
          const newAttempt = sameReportedHead && checksRestarted(priorReport.checks, summary.checks);
          const attempt = sameReportedHead ? (priorReport.attempt ?? 0) + (newAttempt ? 1 : 0) : 0;
          const reported = sameReportedHead && !newAttempt ? priorReport.reportedFailing ?? [] : [];
          const newFailures = summary.failing.filter(name => !reported.includes(name));
          const workerBusy = (await database.query(
            `SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_check'
               AND state IN ('pending','claimed') LIMIT 1`,
            [target.corner_id],
          )).rowCount > 0;
          const firstFailure = summary.status === 'failing' && newFailures.length > 0 && !reported.length;
          const followup = summary.status === 'failing' && reported.length > 0 &&
            checksSettled(summary.checks) && !checksSettled(priorReport?.checks ?? []) &&
            !(sameReportedHead && !newAttempt && priorReport.failureFollowupSent);
          // A later failed job, after the first repair turn has ended, wakes
          // once without waiting for the checks that are still running.
          const partialRepair = !followup && summary.status === 'failing' && !checksSettled(summary.checks) &&
            reported.length > 0 && newFailures.length > 0 && !workerBusy &&
            !(sameReportedHead && !newAttempt && priorReport.partialRepairSent);
          const reportFailure = firstFailure || followup || partialRepair;
          const storedSummary = {
            ...summary,
            // Repeated reads of an unchanged status do not start new idle work.
            statusChangedAt: current.pr?.headSha === checkHeadSha && priorReport?.status === summary.status
              && !newAttempt && JSON.stringify((priorReport.checks ?? []).map(check => [check.name,check.status]).sort()) ===
                JSON.stringify(summary.checks.map(check => [check.name,check.status]).sort())
              ? (priorReport as typeof priorReport & { statusChangedAt?: number })?.statusChangedAt ?? priorReport.fetchStartedAt ?? priorReport.updatedAt
              : summary.fetchStartedAt,
            attempt,
            reportedHeadSha: checkHeadSha,
            reportedFailing: reportFailure ? [...reported, ...newFailures] : reported,
            failureFollowupSent: Boolean((sameReportedHead && !newAttempt && priorReport.failureFollowupSent) || followup),
            partialRepairSent: Boolean((sameReportedHead && !newAttempt && priorReport.partialRepairSent) || partialRepair),
          };
          await ctx.updateLifecycle(
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
          const becamePassing = summary.status === 'passing' && (current.checks !== 'passing' || !sameReportedHead || newAttempt);
          // Pull-request open and the deploy re-read pass a synthetic pending
          // check named "Pull request checks". A green rollup should name the
          // suites that passed. The flag is assigned on its own so that
          // placeholder name stays out of the System line.
          let nameThePass = false;
          if (becamePassing && check.status === 'pending')
            nameThePass = true;
          const label = nameThePass
            ? systemMessage("github-operations.passed")
            : check.status === 'pending'
              ? systemMessage("github-operations.started")
              : String(check.conclusion ?? '').toUpperCase() === 'CANCELLED'
                ? systemMessage("github-operations.cancelled")
                : check.status;
          if (nameThePass) {
            const passedNames = summary.checks.filter(item => item.status === 'passed').map(item => item.name);
            check = {
              ...check,
              name: passedNames.join(', ') || current.pr?.title
                || (current.pr?.number ? `pull request #${current.pr.number}` : 'the pull request'),
            };
          }
          // The first failed job wakes immediately, even while other checks
          // run. A later failed job wakes once more if that turn has ended,
          // without waiting for the rest of the run. Completion wakes once
          // more when the run settles. Replays share the attempt's id.
          const becameFailing = reportFailure;
          // A green/red rollup is a property of the whole head, not of the one
          // check that happened to arrive last. Name the actual failing jobs
          // on a failure, so the implementer knows what to fix and a passing
          // check can never be described as the failure.
          const failing = reportFailure && newFailures.length ? newFailures : summary.failing?.length ? summary.failing : [check.name];
          if (becamePassing || becameFailing || (check.status === 'failed' && !options?.quiet))
          noteInserted = await ctx.systemNote(
            target.corner_id,
            target.author_id,
            {
              subject: GITHUB_SUBJECT,
              verb: becameFailing ? systemMessage("github-operations.found-failing-checks-on") : systemMessage("github-operations.a-check", label),
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
                      (current.pr?.number ? systemMessage("github-operations.pull-request-2", current.pr.number) : systemMessage("github-operations.the-pull-request")),
                    ...(current.pr?.url ? { url: current.pr.url } : {}),
                    ...(check.headSha ? { headSha: check.headSha } : {}),
                  }
                : {
                    text: check.name,
                    ...(check.url ? { url: check.url } : {}),
                    ...(check.headSha ? { headSha: check.headSha } : {}),
                  },
              ...(becameFailing
                ? { consequence: systemMessage("github-operations.failing", failing.join(systemMessage("github-operations.list-separator"))) }
                : check.status === 'failed' && check.conclusion && check.conclusion !== 'failure'
                  ? { consequence: check.conclusion }
                  : {}),
              ...(becameFailing ? { payload: {
                failedJobs: jobLogs.filter(item => newFailures.includes(item.name)),
                // The failed jobs are already a fix turn. A GitHub rerun of a
                // job in this workflow waits until the run ends; the wake says
                // to push now instead of waiting for the other checks.
                ...(!checksSettled(summary.checks) ? { runInProgress: true } : {}),
                ...(followup || partialRepair || newAttempt ? { followup: true } : {}),
              } } : {}),
            },
            becamePassing
              ? `github:checks:green:${check.headSha}:${attempt}`
              : becameFailing
                ? `github:checks:failed:${check.headSha}:${attempt}:${followup ? 'followup' : partialRepair ? 'partial' : 'first'}`
              : `github:checks:${label}:${check.name}:${check.headSha ?? hash(JSON.stringify(check))}`,
            database,
            true,
          );
          if (summary.status === 'failing' && !becameFailing)
            await reconcileCornerMergeBlockers(database, target.corner_id);
        });
        // The admitted webhook/command owns one transaction. Contention
        // returns to that owner; it does not replay reads or writes here.
        await refresh();
        if (noteInserted) ctx.onRoomChanged?.(target.corner_id);
    } catch (error) {
      if (transientGitHubError(error)) {
        await database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(
            jsonb_set(lifecycle-'checkRefreshRetry','{checks}','"pending"'::jsonb),
              '{checksSummary}',jsonb_build_object('total',0,'failing','[]'::jsonb,
                'checks','[]'::jsonb,'updatedAt',floor(extract(epoch FROM clock_timestamp()))) ||
                COALESCE(lifecycle->'checksSummary','{}'::jsonb) || '{"status":"pending"}'::jsonb)
          WHERE corner_id=$1 AND lifecycle->'pr'->>'headSha'=$2
            AND COALESCE((lifecycle->'checksSummary'->>'fetchStartedAt')::double precision,0)<=$3`,
          [target.corner_id, checkHeadSha, fetchStartedAt]);
      }
      throw error;
    }
    // A checks read repairs only its check snapshot; mergeability refreshes
    // retain their event path and must not reset a pending merge claim's age.
    if (!options?.snapshot) await ctx.refreshStaleMergeability(target.corner_id, confirmedPr);
  }


  export async function gitHubOperationsLifecycle(ctx: GitHubOperations,
    cornerId: string,
    database: SqlDatabase = ctx.database,
  ): Promise<CornerLifecycleView> {
    return (
      (
        await database.query<{ lifecycle: CornerLifecycleView }>(
          `SELECT lifecycle-'branch' lifecycle FROM corner_github_cache WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0]?.lifecycle ?? { lifecycle: 'unknown', checks: 'unknown' }
    );
  }


  export async function gitHubOperationsUpdateLifecycle(ctx: GitHubOperations,
    cornerId: string,
    patch: Partial<CornerLifecycleView>,
    database: SqlDatabase = ctx.database,
  ) {
    const previous = await ctx.lifecycle(cornerId, database);
    const { branch: _branch, ...lifecycle } = { ...previous, ...patch };
    await database.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [cornerId, JSON.stringify(lifecycle)],
    );
  }


  export async function gitHubOperationsSystemNote(ctx: GitHubOperations,
    roomId: string,
    authorId: string,
    phrase: SystemPhrase,
    dedupe: string,
    database: SqlDatabase = ctx.database,
    deferNotification = false,
  ) {
    const note = await systemLine(database, {
      id: hash(`beeline:${roomId}:${dedupe}`),
      roomId,
      authorId,
      ...phrase,
      cardType: 'github-corner-note',
    });
    if (note.inserted && !deferNotification) ctx.onRoomChanged?.(roomId);
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
    return note.inserted;
  }


  export async function gitHubOperationsMergeCorner(ctx: GitHubOperations,
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
    database: SqlDatabase = ctx.database,
    expectedPrNumber?: number,
  ) {
    // Match webhook order: commit the repository fact before archival takes
    // any locks. Its message ID precedes the AFTER trigger's Workspace journal;
    // waiting for that ID while owning the journal forms a deadlock cycle.
    // A note failure leaves the corner open, so it cannot skip branch cleanup
    // for an already committed archival. Already archived corners can repair it.
    await ctx.processRepositoryEvent('pull_request', {
      action: 'closed', repository: { full_name: pullRequest.repository },
      ...(pullRequest.mergedBy ? { sender: { login: pullRequest.mergedBy } } : {}),
      pull_request: { merged: true, title: pullRequest.title, html_url: pullRequest.url,
        head: { ref: pullRequest.branch }, base: { ref: pullRequest.targetBranch } },
    }, Number(target.installation_id));
    const mergeKey = `github:pull-request:merged:${pullRequest.url}`;
    let updated = false;
    let archived = false;
    await database.transaction(async (database) => {
      updated = false;
      archived = false;
      await lockCornerLifecycle(database, target.corner_id);
      await lockCornerArchivalAuthority(database);
      const current = (
        await database.query<{ lifecycle: CornerLifecycleView; locked: boolean }>(
          `SELECT gh.lifecycle,fact.locked FROM corner_facts fact
           JOIN corner_github_cache gh ON gh.corner_id=fact.corner_id
           WHERE fact.corner_id=$1 FOR UPDATE OF gh,fact`,
          [target.corner_id],
        )
      ).rows[0];
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
        archived = await archiveCornerState(database, target.corner_id);
        if (!archived) return;
      }
      updated = true;
      await database.query(
        `UPDATE corner_github_cache SET
           lifecycle=((lifecycle-'mergeQueue') -
             CASE WHEN $3 THEN ARRAY['pr','outcome','checksSummary'] ELSE ARRAY[]::text[] END)||$2::jsonb WHERE corner_id=$1`,
        [
          target.corner_id,
          JSON.stringify({
            lifecycle: locked ? 'working' : 'done',
            checks: locked ? 'unknown' : 'passing',
            ...(!locked ? { outcome: 'landed' } : {}),
            ...(!locked && mergedPr
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
          locked,
        ],
      );
      const merged: SystemPhrase = {
        subject: pullRequest.mergedBy
          ? { kind: 'github', name: pullRequest.mergedBy }
          : GITHUB_SUBJECT,
        verb: systemMessage("github-operations.merged"),
        kind: 'merged',
        object: { text: pullRequest.title, url: pullRequest.url },
      };
      await systemLine(database, {
        id: hash(`beeline:${target.corner_id}:${mergeKey}`),
        roomId: target.corner_id,
        authorId: target.author_id,
        ...merged,
        cardType: 'github-corner-note',
      });
      await advanceCorner(database, target.corner_id, {
        kind: 'merged',
        contents: { mergeVerdict: 'merged', pullRequestUrl: pullRequest.url },
      });
    });
    if (!updated) return;
    ctx.onRoomChanged?.(target.corner_id);
    ctx.onRoomChanged?.(target.parent_id);
    if (archived) await ctx.deleteCornerBranch(target.corner_id);
  }


  /** One post-commit attempt; no persistent branch cleanup queue or retry. */
  export async function gitHubOperationsDeleteCornerBranch(ctx: GitHubOperations, cornerId: string) {
    return deleteArchivedCornerBranch(ctx.database, ctx.app, cornerId);
  }


  export async function gitHubOperationsSyncInstallation(ctx: GitHubOperations,
    viewerId: string,
    installationId: number,
    transaction?: SqlDatabase,
  ) {
    const database = transaction ?? ctx.database;
    // Every statement belongs to this one installation event. A contended
    // statement fails the event; only another admitted event can run it again.
    const account = await ctx.app.installationAccount(installationId);
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
    const repositories = await ctx.app.listRepositories(installationId);
    for (const repository of repositories) await ctx.storeRepository(repository, database);
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
  export async function gitHubOperationsListAdministeredInstallations(ctx: GitHubOperations, token: string): Promise<Set<number> | undefined> {
    try {
      return new Set(await ctx.app.listUserInstallationIds(token));
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
  export async function gitHubOperationsUserCanAdministerInstallation(ctx: GitHubOperations,
    token: string,
    installationId: number,
    accountType: 'User' | 'Organization',
  ): Promise<boolean | undefined> {
    try {
      return await ctx.app.userCanAccessInstallation(token, installationId);
    } catch (error) {
      if (accountType !== 'Organization') throw error;
      console.warn(
        `[server] GitHub installation listing unavailable for organization verification installation=${installationId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }


  export async function gitHubOperationsAssertInstallationAccess(ctx: GitHubOperations,
    viewerId: string,
    installationId: number,
    database: SqlDatabase = ctx.database,
  ) {
    const account = await ctx.app.installationAccount(installationId);
    const credential = await ctx.userCredential(viewerId, database);
    if (!credential?.token) throw new Error('GitHub installation access denied');

    let accessible: boolean | undefined;
    try {
      accessible = await ctx.userCanAdministerInstallation(
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
      const rotated = await ctx.rotateUserCredential(credential, database);
      if (!rotated) throw new Error('GitHub installation access denied');
      accessible = await ctx.userCanAdministerInstallation(rotated, installationId, account.type);
    }

    const accessConfirmed = account.type === 'User' ? accessible === true : accessible !== false;
    if (!accessConfirmed) throw new Error('GitHub installation access denied');
  }
