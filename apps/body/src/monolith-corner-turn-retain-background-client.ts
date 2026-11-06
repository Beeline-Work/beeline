import { helperUsageBinding, postChangedAgentUsage } from './helper-usage-binding.js';
import { agentBehavior } from './agent-command.js';
import { dependencyFingerprint } from './dependency-generation.js';
import { mergeHarnessTurnMetrics } from './harness-turn-tokens.js';
import type { InterruptedTurn } from './force-update-journal.js';

import { AcpClient } from './acp.js';
import { expectedMountedImportedMcpServerNames, repairRoomAgentCredentialLinks, watchRoomClaudeLogin, writeBackRoomClaudeLogin } from './agent-home.js';
import { readOpenRouterKeyUsage } from './openrouter-key-usage.js';
import { HarnessQuotaReader, quotaAxiProvider } from './harness-quota.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { hasCornerPrepareScript } from './corner-prepare-script.js';
import { sessionGrantedResources } from './room-session.js';
import { codegraphFingerprintServers } from './codegraph.js';
import { cornerHasRepositoryWork } from './prompt-assembly.js';
import { stopAgentProcess } from './agent-process.js';
import { TurnTrace } from './turn-trace.js';
import { MonolithCornerTurnLoop, WorkspaceRoster } from './monolith-corner-turn.js';



  /** Retire the conversation immediately, but keep its existing tools and wake callbacks alive. */
  export function monolithCornerTurnLoopRetainBackgroundClient(ctx: MonolithCornerTurnLoop, client: AcpClient): Promise<void> {
    const existing = ctx.retiredClients.get(client);
    if (existing) return existing.done;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    let stopping = false;
    const finish = async () => {
      if (stopping) return;
      stopping = true;
      client.off('session/update', check);
      client.off('exit', exited);
      ctx.options.signal?.removeEventListener('abort', exited);
      try { await stopAgentProcess(client); }
      finally { ctx.retiredClients.delete(client); ctx.options.scheduler.workChanged(ctx.options.cornerId); resolveDone(); }
    };
    const check = () => { if (!client.hasBackgroundTools) void finish().catch(console.error); };
    const exited = () => { void finish().catch(console.error); };
    ctx.retiredClients.set(client, { done, check, stop: exited });
    client.on('session/update', check);
    client.once('exit', exited);
    ctx.options.signal?.addEventListener('abort', exited, { once: true });
    if (ctx.options.signal?.aborted) exited();
    check();
    return done;
  }


  export function monolithCornerTurnLoopConfigurationChanged(ctx: MonolithCornerTurnLoop): void {
    ctx.recoverIntake?.();
  }



  /**
   * Called on socket resubscription. A `corner-complete` published while that
   * socket was down is recovered by a single durable read.
   *
   * The wake is the intake loop's own stable notify and is handed back exactly
   * once, so it is kept: clearing it here left `requestClose` waking nothing
   * after the first reconciliation. Intake clears it itself when it exits.
   */
  export function monolithCornerTurnLoopRequestReconciliation(ctx: MonolithCornerTurnLoop): void {
    ctx.reconcileCloseRequested = true;
    ctx.wakeIntake?.();
  }


  export function monolithCornerTurnLoopIsBusy(ctx: MonolithCornerTurnLoop): boolean {
    return ctx.busy;
  }


  /** corner-complete on the wire: wake intake so `closed()` reaps now. */
  export function monolithCornerTurnLoopRequestClose(ctx: MonolithCornerTurnLoop): void {
    ctx.closePushed = true;
    for (const retired of ctx.retiredClients.values()) retired.stop();
    ctx.wakeIntake?.();
  }


  export function monolithCornerTurnLoopRefreshPersonaForSoulUpdate(ctx: MonolithCornerTurnLoop): Promise<void> {
    return ctx.options.scheduler.stop(ctx.options.cornerId);
  }


  export async function monolithCornerTurnLoopPrepareForForcedUpdateRestart(ctx: MonolithCornerTurnLoop): Promise<void> {
    ctx.forcedStop = true;
    ctx.branchSyncController?.abort();
  }


  export function monolithCornerTurnLoopInterruptedTurn(ctx: MonolithCornerTurnLoop): InterruptedTurn | undefined {
    const current = ctx.currentTurn;
    if (!current || ctx.stoppedTurns.has(current.requestId)) return undefined;
    return { roomId: ctx.options.cornerId, requestId: current.requestId, generationId: ctx.commandContext.generationId };
  }


  export function monolithCornerTurnLoopInterruptForServerMinimum(ctx: MonolithCornerTurnLoop): InterruptedTurn | undefined {
    ctx.forcedStop = true;
    ctx.branchSyncController?.abort();
    const current = ctx.currentTurn;
    if (!current) return undefined;
    // The idle lease starts after active work, including a handover interruption.
    ctx.warmTranscript.complete(ctx.sessionId, []);
    ctx.stoppedTurns.add(current.requestId);
    if (ctx.client && ctx.sessionId) ctx.client.sessionCancel(ctx.sessionId);
    return {
      roomId: ctx.options.cornerId,
      requestId: current.requestId,
      generationId: ctx.commandContext.generationId,
    };
  }


  export async function monolithCornerTurnLoopForceRecoverRoom(ctx: MonolithCornerTurnLoop): Promise<void> {
    if (ctx.client && ctx.sessionId) ctx.client.sessionCancel(ctx.sessionId);
    await ctx.options.scheduler.stop(ctx.options.cornerId, true);
  }


  /**
   * Obey a stop the requester already made a fact.
   *
   * The id is remembered whether or not it names the turn in flight: a stop for
   * work not yet started must still keep that work from starting, and one for a
   * turn that has already ended is simply never read again. Only the session
   * actually running the stopped turn is cancelled.
   */
  export function monolithCornerTurnLoopStopTurn(ctx: MonolithCornerTurnLoop, requestId: string): void {
    ctx.squireRelay.cancel(requestId);
    ctx.stoppedTurns.add(requestId);
    while (ctx.stoppedTurns.size > 500)
      ctx.stoppedTurns.delete(ctx.stoppedTurns.values().next().value!);
    if (ctx.currentTurn?.requestId !== requestId) return;
    ctx.branchSyncController?.abort();
    void ctx.options.scheduler.stop(ctx.options.cornerId, true).catch(error =>
      console.error('[body] cancelled corner process cleanup failed:', error));
  }


  export function monolithCornerTurnLoopCommandActivation(ctx: MonolithCornerTurnLoop){
    if(!ctx.options.api.channel?.isOpen)return Promise.resolve(undefined);
    const command=ctx.commandContext?.current;
    if(!command){
      return Promise.reject(new Error('Activation requires a claimed command'));
    }
    return ctx.activationContext.read({agentId:ctx.agent.publicKey,workspaceId:ctx.options.workspaceId,
      roomId:ctx.options.cornerId,commandId:command.id,generationId:ctx.commandContext.generationId});
  }


  export async function monolithCornerTurnLoopConfiguration(ctx: MonolithCornerTurnLoop){
    const activation=await ctx.commandActivation();
    return activation?activation.configuration:ctx.options.api.execute('getAgentConfiguration',{agentId:ctx.agent.publicKey,roomId:ctx.options.cornerId});
  }


  export async function monolithCornerTurnLoopRestoredState(ctx: MonolithCornerTurnLoop){
    const activation=await ctx.commandActivation();
    if(activation){if(!activation.corner)throw new Error('Activation corner context absent');return activation.corner;}
    return ctx.options.api.execute('getCornerRestoreState',{cornerId:ctx.options.cornerId});
  }


  export async function monolithCornerTurnLoopRepositoryState(ctx: MonolithCornerTurnLoop){
    const activation=await ctx.commandActivation();
    return activation?activation.repository:ctx.options.api.execute('getRoomRepositoryState',{roomId:ctx.options.cornerId});
  }


  export async function monolithCornerTurnLoopRoster(ctx: MonolithCornerTurnLoop): Promise<WorkspaceRoster> {
    const activation=await ctx.commandActivation();
    const roster = activation?activation.roster:await ctx.options.api.execute('getWorkspaceRoster', {
      agentId: ctx.agent.publicKey,
      workspaceId: ctx.options.workspaceId,
    });
    ctx.memberNames = new Map(roster.members.map((member) => [member.identityId, member.name]));
    return roster;
  }


  /**
   * Drop this corner's live harness process. The next activation starts cold.
   * A rotation is a fact about one live session, so the pin goes with it.
   */
  /**
   * Claude Code may have refreshed its login during the prompt, detaching
   * this Room's credential link. Share the rotated login now so other Rooms
   * do not spend the old refresh token before this Room's next activation.
   */
  export async function monolithCornerTurnLoopWriteBackClaudeLogin(ctx: MonolithCornerTurnLoop): Promise<void> {
    if (!agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack || !ctx.options.config.agentHomeRoot) return;
    await writeBackRoomClaudeLogin({
      root: ctx.options.config.agentHomeRoot,
      operatorHome: ctx.options.config.operatorHome,
    }).catch((error: unknown) => {
      console.error(`[thin-core] corner ${ctx.options.cornerId} could not write back a refreshed Claude login:`, error);
    });
  }


  /**
   * After a turn, refresh the owner's view of this agent's OpenRouter key
   * spend. `refused` marks a turn OpenRouter refused with 402.
   */
  export function monolithCornerTurnLoopPublishOpenRouterSpend(ctx: MonolithCornerTurnLoop, refused = false): void {
    const key = ctx.openRouterKey;
    if (!key) return;
    // One read at a time, so a later normal read cannot land over a 402 stop.
    ctx.openRouterSpendPublish = ctx.openRouterSpendPublish
      .then(() => readOpenRouterKeyUsage(key, {
        ...(ctx.options.fetchImpl ? { fetchImpl: ctx.options.fetchImpl } : {}),
        ...(refused ? { refused } : {}),
      }))
      .then((usage) => usage
        ? postChangedAgentUsage(ctx.options.api,ctx.agent.publicKey,usage)
        : undefined)
      .catch((error) => console.error('[agent-usage] OpenRouter key read failed', error));
  }


  /** After a turn, refresh the owner's view of this agent's plan quota. */
  export function monolithCornerTurnLoopPublishHarnessQuota(ctx: MonolithCornerTurnLoop): void {
    ctx.harnessQuota ??= new HarnessQuotaReader({
      accountPublisher:helperUsageBinding(ctx.options.api),
      agentId: ctx.agent.publicKey,
      post: (usage) =>
        postChangedAgentUsage(ctx.options.api,ctx.agent.publicKey,usage),
    });
    void ctx.harnessQuota.publish(
      quotaAxiProvider(ctx.options.config.agentKind, Boolean(ctx.openRouterKey)),
      ctx.agentEnv,
    );
  }


  export async function monolithCornerTurnLoopCaptureTurnMetrics(ctx: MonolithCornerTurnLoop) {
    ctx.publishOpenRouterSpend();
    ctx.publishHarnessQuota();
    return mergeHarnessTurnMetrics(ctx.turnUsage.usage, ctx.harnessTokens, ctx.client?.lastPromptBytes);
  }


  /**
   * Watch this client's Claude login so a refresh made while the
   * corner is idle reaches other Rooms at once (see `watchRoomClaudeLogin`).
   */
  export function monolithCornerTurnLoopWatchClaudeLogin(ctx: MonolithCornerTurnLoop): void {
    ctx.stopClaudeLoginWatch();
    if (!agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack || !ctx.options.config.agentHomeRoot) return;
    ctx.claudeLoginWatch = watchRoomClaudeLogin({
      root: ctx.options.config.agentHomeRoot,
      operatorHome: ctx.options.config.operatorHome,
    });
  }


  export function monolithCornerTurnLoopStopClaudeLoginWatch(ctx: MonolithCornerTurnLoop): void {
    ctx.claudeLoginWatch?.close();
    ctx.claudeLoginWatch = undefined;
  }


  export async function monolithCornerTurnLoopDiscardSession(ctx: MonolithCornerTurnLoop, preserveConversation = false, stopBackground = false): Promise<void> {
    if (!preserveConversation) ctx.warmTranscript.forgetSession();
    const client = ctx.client;
    ctx.stopClaudeLoginWatch();
    ctx.client = undefined;
    ctx.sessionId = undefined;
    ctx.sessionContextPath = undefined;
    ctx.sessionFingerprint = undefined;
    ctx.sessionCodegraphReady = false;
    ctx.pinnedProviderOverride = undefined;
    ctx.sessionModel = null;
    const cancelled = ctx.closePushed || ctx.forcedStop || ctx.options.signal?.aborted ||
      (ctx.currentTurn && ctx.stoppedTurns.has(ctx.currentTurn.requestId));
    if (client?.hasBackgroundTools && !cancelled && !stopBackground) void ctx.retainBackgroundClient(client);
    else if (client) await stopAgentProcess(client);
  }


  /** See `MonolithRoomTurnLoop.sessionIsCurrent`: retention never keeps a
   *  session whose persona, model pin, or mounted MCP set the operator has
   *  since changed, or whose harness process has exited. */
  export async function monolithCornerTurnLoopSessionIsCurrent(ctx: MonolithCornerTurnLoop): Promise<boolean> {
    if (!ctx.client?.isAlive || ctx.sessionContextPath !== ctx.commandContext.path) return false;
    return (await ctx.currentSessionFingerprint()) === ctx.sessionFingerprint;
  }


  export async function monolithCornerTurnLoopCurrentSessionFingerprint(ctx: MonolithCornerTurnLoop): Promise<string> {
    const [configuration, roster, grants, restored, cornerPrepareScript] = await Promise.all([
      ctx.configuration(),
      ctx.roster(),
      ctx.grantedResources(),
      ctx.restoredState(),
      hasCornerPrepareScript(ctx.options.worktreePath),
    ]);
    const { hostRoutes: grantedHostRoutes, devices: grantedDevices, isolatedCategories } = grants;
    const self = roster.members.find((member) => member.identityId === ctx.agent.publicKey);
    const registryRoutes = configuration.registryMcpRoutes ?? [];
    return sessionConfigFingerprint({
      dependencyGeneration: await dependencyFingerprint(ctx.options.worktreePath, ctx.options.config.agentHomeRoot),
      devices: grantedDevices,
      isolatedCategories,
      model: configuration.model ?? ctx.options.config.modelSelection?.model,
      effort: configuration.effort ?? ctx.options.config.modelSelection?.effort,
      fastMode: configuration.fastMode,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? ctx.agent.name,
      yoloMode: configuration.yoloMode,
      repositoryWork: cornerHasRepositoryWork(restored.brief),
      cornerPrepareScript,
      mcpServers: codegraphFingerprintServers(
        ctx.options.config,
        [
          ...expectedMountedImportedMcpServerNames({
            operatorHome: ctx.options.config.operatorHome,
            agentKind: ctx.options.config.agentKind,
            grantedHostRoutes: [
              ...grantedHostRoutes,
              ...registryRoutes.map((route) => route.routeName),
            ],
          }),
          ...registryRoutes.map((route) => route.routeName),
        ],
        ctx.sessionCodegraphReady,
      ),
      reviewerHandle: configuration.reviewerHandle,
    });
  }


  export async function monolithCornerTurnLoopGrantedResources(ctx: MonolithCornerTurnLoop) {
    return sessionGrantedResources(ctx.options.config, async () => {
      const activation = await ctx.commandActivation();
      return activation ? activation.grants : ctx.options.api.execute('listAgentGrants', {
        agentId: ctx.agent.publicKey,
        roomId: ctx.options.cornerId,
      });
    });
  }


  export async function monolithCornerTurnLoopActivate(ctx: MonolithCornerTurnLoop, trace?: TurnTrace): Promise<string> {
    if (ctx.options.config.agentProgramError) throw new Error(ctx.options.config.agentProgramError);
    if (ctx.client?.isAlive && ctx.sessionId && ctx.sessionContextPath === ctx.commandContext.path) {
      if (ctx.options.config.agentHomeRoot) {
        await repairRoomAgentCredentialLinks({
          root: ctx.options.config.agentHomeRoot,
          operatorHome: ctx.options.config.operatorHome,
          writeBackNewerClaudeLogin: agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack === true,
        });
      }
      return ctx.sessionId;
    }
    // A client without a usable session still owns a harness process.
    if (ctx.client) await ctx.discardSession(true);
    try {
      return await ctx.activateCold(trace);
    } catch (error) {
      // Cleanup must not hide the activation failure that owns the receipt.
      await ctx.discardSession(true).catch(cleanupError =>
        console.error('[body] failed to stop harness after activation failure:', cleanupError),
      );
      throw error;
    }
  }
