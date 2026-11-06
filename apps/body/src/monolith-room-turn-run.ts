import { runServerCommandIntake } from './server-command-intake.js';
import { redactTurnError } from './turn-failure-reason.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';



  export async function monolithRoomTurnLoopRun(ctx: MonolithRoomTurnLoop): Promise<void> {
    const { api, roomId, signal, supervisor } = ctx.options;
    const intake = (progress: () => void) =>
      runServerCommandIntake({
        api,
        roomId,
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
          ctx.options.health.poll();
        },
        onSubscriptionState: ctx.options.onSubscriptionState,
        onError: (error) => {
          ctx.options.onIntakeError?.(error);
          console.error('[thin-core] Room command failed', redactTurnError(error));
        },
        // Marks this loop busy the instant it attempts to claim a real
        // turn, before the claim's own network round trip and before
        // context.enter()'s own file I/O - closing the window where
        // RoomRuntimeCoordinator.reconcile's repository-revision restart
        // could see a claiming-but-not-yet-`busy` Room as idle and stop it,
        // cancelling a turn that had already begun (or was about to) (C112).
        onClaiming: () => {
          ctx.busy = true;
        },
        onClaimFailed: () => {
          ctx.busy = false;
        },
        onEnter: (command) => ctx.squireRelay.activate(command, ctx.commandContext.generationId),
        onLeave: (command) =>
          ctx.squireRelay.deactivate(command.turnRequestId, ctx.pausedOnGrantRequestId),
        stop: (requestId) => ctx.stopTurn(requestId),
        restart: () => ctx.options.onRestartRequested?.(),
        canStartTurn: ctx.options.canStartTurn,
        run: async (command) => {
          const item = {
            ...command.source,
            id: command.turnRequestId,
            body:
              command.action === 'resume'
                ? `Resume the paused turn. The server supplied this answer: ${command.source.body}`
                : command.source.body,
          };
          ctx.startPrompt(item);
          await ctx.activeTurn?.promise;
        },
      });
    try {
      await (supervisor
        ? supervisor.supervise(`Room ${roomId}`, signal, intake)
        : intake(() => undefined));
    } finally {
      ctx.squireRelay.close();
      ctx.options.grantRunner?.unregister(roomId);
      await ctx.options.scheduler.stop(roomId);
      ctx.options.scheduler.forget(roomId);
    }
  }
