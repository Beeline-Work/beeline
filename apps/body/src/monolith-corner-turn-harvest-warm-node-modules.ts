import { tryWithKernelLock } from './kernel-lock.js';
import { runServerCommandIntake } from './server-command-intake.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { turnErrorDetail } from './turn-failure-reason.js';
import { syncCornerBranch } from './corner-branch-sync.js';
import { harvestWarmNodeModules, mobileNodeModulesStoreDir, warmNodeModulesStoreDir } from './warm-node-modules.js';
import { MonolithCornerTurnLoop, execFileAsync } from './monolith-corner-turn.js';



  /**
   * Offer this worktree's `node_modules` to the host-wide warm store.
   *
   * A turn's end is the moment the tree is most likely to be a finished
   * install, and the store keeps only the first complete tree per lockfile —
   * so after the first corner on a lockfile this is one `stat` that answers
   * `already-warm`. The copy that the first one does is deliberately NOT
   * awaited by the turn: nobody in the Room is waiting on a cache, and the
   * only thing that waits is shutdown, so a half-copied tree is never left
   * where a later corner could read it as complete.
   */
  export function monolithCornerTurnLoopHarvestWarmNodeModules(ctx: MonolithCornerTurnLoop): void {
    if (ctx.harvest || !ctx.options.repository || ctx.options.repository.readOnly) return;
    const { cornerId, worktreePath, runtime } = ctx.options;
    // `apps/mobile` has its own lockfile and store; harvesting it is what lets
    // the next fresh corner skip the whole mobile install.
    const mobilePath = resolve(worktreePath, 'apps/mobile');
    const harvest = (input: { worktreePath: string; storeRoot: string }) => tryWithKernelLock(`dependency-store:${resolve(input.storeRoot)}`, () => harvestWarmNodeModules(input));
    const jobs = [
      harvest({
        worktreePath,
        storeRoot: warmNodeModulesStoreDir(runtime.supervisorRoot),
      }),
      ...(existsSync(resolve(mobilePath, 'package-lock.json'))
        ? [
            harvest({
              worktreePath: mobilePath,
              storeRoot: mobileNodeModulesStoreDir(runtime.supervisorRoot),
            }),
          ]
        : []),
    ];
    const run = Promise.all(jobs)
      .then((outcomes) => {
        for (const outcome of outcomes) {
          if (!outcome) continue; // Busy store: cache reuse never queues a turn or shutdown.
          if (outcome.reason === 'already-warm' || outcome.reason === 'no-lockfile') continue;
          console.log(
            `[thin-core] corner ${cornerId} warm node_modules harvest: ${outcome.reason}${
              outcome.detail ? ` (${outcome.detail})` : ''
            }`,
          );
        }
      })
      .catch((error) => {
        console.error(`[thin-core] corner ${cornerId} warm node_modules harvest failed:`, error);
      })
      .finally(() => {
        if (ctx.harvest === run) ctx.harvest = undefined;
      });
    ctx.harvest = run;
  }


  /**
   * Bring this worktree onto the corner's branch as GitHub currently has it,
   * before any work is done on top of it.
   *
   * The branch is the shared artifact: another member agent may have pushed to
   * it since this helper last looked, and a first touch of a corner this
   * helper did not open starts from whatever `room-runtime.ts` restored. A
   * conflicting local commits are realigned to that remote branch so the
   * fixed objective can be attempted again without clobbering a sibling push.
   */
  export async function monolithCornerTurnLoopSyncBranch(ctx: MonolithCornerTurnLoop): Promise<void> {
    const repository = ctx.options.repository;
    ctx.branchSyncNotice = undefined;
    if (!repository || repository.readOnly) return;
    // One command-authorized credential lookup. A failed provider observation
    // parks through intake until configuration/link/provider recovery.
    const token=(await ctx.options.api.execute('getRoomGitHubToken',{roomId:ctx.options.parentRoomId})).token;
    if (!token) throw new Error('corner repository credential lookup returned no token');
    const stop = new AbortController();
    ctx.branchSyncController=stop;
    if(ctx.forcedStop||(ctx.currentTurn&&ctx.stoppedTurns.has(ctx.currentTurn.requestId)))stop.abort();
    try {
      if (ctx.reviewerCheckout) {
        if ((await execFileAsync('git', ['-C', ctx.options.worktreePath, 'status', '--porcelain'])).stdout.trim())
          throw new Error('review checkout has uncommitted work; preserve it before syncing');
        const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
        const ref = `refs/remotes/origin/${repository.featureBranch}`;
        await execFileAsync('git', ['-C', ctx.options.worktreePath, 'fetch', 'origin',
          `+refs/heads/${repository.featureBranch}:${ref}`], { env });
        await execFileAsync('git', ['-C', ctx.options.worktreePath, 'checkout', '--detach', ref], { env });
        return;
      }
      await syncCornerBranch({
        worktreePath: ctx.options.worktreePath,
        featureBranch: repository.featureBranch,
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
        signal: ctx.options.signal ? AbortSignal.any([ctx.options.signal, stop.signal]) : stop.signal,
      }).catch(error => {
        if (!(error instanceof Error) || !/^corner branch sync (refused: preserve uncommitted work|conflict: local commits preserved)/.test(error.message)) throw error;
        // Preserve the work and let its owning agent resolve it in this turn.
        ctx.branchSyncNotice = `${error.message}. Resolve this private checkout's local work against origin/${repository.featureBranch} before publishing.`;
      });
    } finally {
      if(ctx.branchSyncController===stop)ctx.branchSyncController=undefined;
    }
  }


  export async function monolithCornerTurnLoopRun(ctx: MonolithCornerTurnLoop): Promise<void> {
    const { api, cornerId, signal, supervisor } = ctx.options;
    const intake = (progress: () => void) =>
      runServerCommandIntake({
        api,
        roomId: cornerId,
        agentId: ctx.agent.publicKey,
        context: ctx.commandContext,
        signal,
        presence: {
          ...(ctx.options.config.daemonReleaseVersion
            ? { releaseVersion: ctx.options.config.daemonReleaseVersion }
            : {}),
          ...(ctx.options.config.daemonSourceSha
            ? { sourceSha: ctx.options.config.daemonSourceSha }
            : {}),
          available: !ctx.options.config.modelUnavailable,
        },
        onWake: (wake) => {
          ctx.wakeIntake = wake;
        },
        onRecovery: (recover) => { ctx.recoverIntake = recover; },
        onPoll: () => {
          progress();
          ctx.options.onPoll();
        },
        onSubscriptionState: ctx.options.onSubscriptionState,
        onError: (error) => {
          ctx.options.onIntakeError?.(error);
          console.error('[thin-core] corner command failed', turnErrorDetail(error));
        },
        // See monolith-room-turn.ts (C112): mark busy the instant a claim
        // attempt starts, before its own network round trip and before
        // context.enter()'s own file I/O, so a reconcile busy-check landing
        // anywhere in that window can never see this corner as idle when a
        // turn was already claimed (or about to be).
        onClaiming: () => {
          ctx.busy = true;
        },
        onClaimFailed: () => {
          ctx.busy = false;
        },
        onEnter: (command) => ctx.squireRelay.activate(command, ctx.commandContext.generationId),
        onLeave: (command) => ctx.squireRelay.deactivate(command.turnRequestId),
        stop: (requestId) => ctx.stopTurn(requestId),
        restart: () => ctx.options.onRestartRequested?.(),
        canStartTurn: ctx.options.canStartTurn,
        closed: async () => {
          if (ctx.closePushed) {
            ctx.closePushed = false;
            await ctx.harvest;
            await ctx.options.onCloseRequested();
            return true;
          }
          if (!ctx.reconcileCloseRequested) return false;
          ctx.reconcileCloseRequested = false;
          // A close control owns a current authority read, independently of a
          // command's held setup value.
          const state = await api.execute('getCornerRestoreState', { cornerId });
          if (!state.closeRequested) return false;
          // The reap deletes the worktree a harvest is still reading.
          await ctx.harvest;
          await ctx.options.onCloseRequested();
          return true;
        },
        run: (command) => ctx.prompt(
          command.turnRequestId,
          command.source.body,
          command.source.attachments,
          command.source.authorId,
          command.reason === 'corner_check' ? [command.source.body] : undefined,
          ['message', 'private'].includes(command.source.type) ? command.sourceMessageId : undefined,
        ),
      });
    try {
      await (supervisor
        ? supervisor.supervise(`corner ${cornerId}`, signal, intake)
        : intake(() => undefined));
    } finally {
      ctx.squireRelay.close();
      ctx.options.grantRunner?.unregister(cornerId);
      await ctx.options.scheduler.stop(cornerId);
      ctx.options.scheduler.forget(cornerId);
      // A harvest writes into host-wide state, so it finishes or is discarded
      // with this corner — never left running against a reaped worktree.
      await ctx.harvest;
    }
  }
