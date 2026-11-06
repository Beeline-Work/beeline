import { helperUsageBinding, postChangedAgentUsage } from './helper-usage-binding.js';
import { agentBehavior } from './agent-command.js';
import { mergeHarnessTurnMetrics } from './harness-turn-tokens.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workspaceAssetPaths, workspaceCacheEnv } from './workspace-assets.js';
import { expectedMountedImportedMcpServerNames, mountedImportedMcpServerNames, repairRoomAgentCredentialLinks, watchRoomClaudeLogin, writeBackRoomClaudeLogin } from './agent-home.js';
import { readOpenRouterKeyUsage } from './openrouter-key-usage.js';
import { HarnessQuotaReader, quotaAxiProvider } from './harness-quota.js';
import { deliverAttachments, withoutImageData, type DeliveredAttachment } from './attachment-delivery.js';
import { sessionGrantedResources } from './room-session.js';
import { codegraphFingerprintServers } from './codegraph.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { credentialMaskPaths, siblingAgentMaskPaths } from './bwrap-sandbox.js';
import type { GrantWritePolicy } from './grant-runner.js';
import { runtimeDirectory } from './runtime.js';
import { TurnTrace, TurnTraceFile } from './turn-trace.js';
import { stopAgentProcess } from './agent-process.js';
import { MonolithRoomTurnLoop, WorkspaceRoster, HumanMessage, RoomRepositoryState } from './monolith-room-turn.js';



  export function monolithRoomTurnLoopConfigurationChanged(ctx: MonolithRoomTurnLoop): void {
    ctx.recoverIntake?.();
  }



  /** Wake the intake after reconciliation or a storage lease release. */
  export function monolithRoomTurnLoopRequestReconciliation(ctx: MonolithRoomTurnLoop): void {
    // Intake owns this stable notifier and clears it when it exits.
    ctx.wakeIntake?.();
  }


  export function monolithRoomTurnLoopIsBusy(ctx: MonolithRoomTurnLoop): boolean {
    return ctx.busy;
  }


  /** The turn a `request_grant` paused, if any (cleared when its decision resumes it). */
  export function monolithRoomTurnLoopPausedGrantRequestId(ctx: MonolithRoomTurnLoop): string | undefined {
    return ctx.pausedOnGrantRequestId;
  }


  /**
   * What the grant runner may write here: the session's own scratch and home
   * overlay and nothing else, enforced by the same read-only mount table the
   * harness runs under. With no usable bwrap there is no way to keep that
   * promise, so the policy carries no path and the runner refuses the run
   * rather than widening the boundary.
   */
  export function monolithRoomTurnLoopGrantWritePolicy(ctx: MonolithRoomTurnLoop): GrantWritePolicy {
    const assetRoot = ctx.sharedAssetsActive ? ctx.options.config.agentSharedAssetRoot : undefined;
    const runtimeDir = runtimeDirectory(ctx.options.runtime.supervisorRoot, ctx.options.runtime.agent.publicKey);
    const privateAssetRoot = join(runtimeDir, 'private-assets');
    return {
      surface: 'room',
      ...(ctx.options.config.bwrapPath ? { bwrapPath: ctx.options.config.bwrapPath } : {}),
      ...(ctx.sessionScratchDir ? { scratch: ctx.sessionScratchDir } : {}),
      ...(ctx.sessionStateDirs.length ? { harnessStateDirs: ctx.sessionStateDirs } : {}),
      maskPaths: [
        ...credentialMaskPaths(
          ctx.options.config.sandboxMaskPaths,
          ctx.options.config.operatorHome ?? homedir(),
        ),
        ...(assetRoot ? [] : siblingAgentMaskPaths(runtimeDir)),
      ],
      ...(assetRoot && ctx.options.config.agentHomeRoot
        ? { sharedLayout: {
            assetRoot,
            agentRuntimeDir: runtimeDir,
            privateHomeRoot: ctx.options.config.agentHomeRoot,
            ...(ctx.options.config.agentPrivateRoot ? { privateRoot: ctx.options.config.agentPrivateRoot } : {}),
            ...(agentBehavior(ctx.options.config.agentKind).codexCacheBindings && ctx.agentEnv.CODEX_HOME ? { codexHome: ctx.agentEnv.CODEX_HOME } : {}),
            ...(ctx.agentEnv.HOME ? { packageHome: ctx.agentEnv.HOME } : {}),
            privateAssetRoot,
            isolatedCategories: ctx.isolatedCategories,
          } }
        : {}),
      ...((assetRoot || ctx.isolatedCategories.includes('package-cache')) && ctx.agentEnv
        ? { toolEnv: {
            ...(ctx.agentEnv.HOME ? { HOME: ctx.agentEnv.HOME } : {}),
            ...(ctx.agentEnv.PATH ? { PATH: ctx.agentEnv.PATH } : {}),
            ...(ctx.agentEnv.GRADLE_USER_HOME ? { GRADLE_USER_HOME: ctx.agentEnv.GRADLE_USER_HOME } : {}),
            ...(ctx.agentEnv.CARGO_HOME ? { CARGO_HOME: ctx.agentEnv.CARGO_HOME } : {}),
            ...workspaceCacheEnv(workspaceAssetPaths(assetRoot ?? privateAssetRoot), undefined,
              ctx.isolatedCategories.includes('package-cache') ? privateAssetRoot : undefined),
          } }
        : {}),
    };
  }


  /**
   * One turn's stopwatch. It is created for every turn — measuring is cheap —
   * and only WRITES when the daemon configured a runtime directory to write
   * into, so a standalone or test Body stays silent.
   */
  export function monolithRoomTurnLoopBeginTurnTrace(ctx: MonolithRoomTurnLoop, requestId: string): TurnTrace {
    const directory = ctx.options.config.turnTraceDir;
    if (directory) ctx.turnTraceSink ??= new TurnTraceFile(directory);
    return new TurnTrace({
      surface: 'room',
      agentId: ctx.agent.publicKey,
      roomId: ctx.options.roomId,
      requestId,
      ...(ctx.turnTraceSink ? { sink: ctx.turnTraceSink } : {}),
    });
  }


  export function monolithRoomTurnLoopCurrentTurnForRunner(ctx: MonolithRoomTurnLoop):
    { requestId: string; requester?: { pubkey: string; name?: string } } | undefined {
    const active = ctx.activeTurn;
    if (!active) return undefined;
    return { requestId: active.item.id, requester: ctx.requesterOf(active.item.authorId) };
  }


  export function monolithRoomTurnLoopRequesterOf(ctx: MonolithRoomTurnLoop, authorId: string): { pubkey: string; name?: string } {
    const name = ctx.memberNames.get(authorId);
    return { pubkey: authorId, ...(name ? { name } : {}) };
  }


  export async function monolithRoomTurnLoopRefreshPersonaForSoulUpdate(ctx: MonolithRoomTurnLoop): Promise<void> {
    await ctx.options.scheduler.stop(ctx.options.roomId);
  }


  export async function monolithRoomTurnLoopPrepareForForcedUpdateRestart(_ctx: MonolithRoomTurnLoop): Promise<void> {
    // Ordinary managed updates keep their existing idle/drain behavior.
  }


  export function monolithRoomTurnLoopInterruptedTurn(ctx: MonolithRoomTurnLoop): InterruptedTurn | undefined {
    const active = ctx.activeTurn;
    if (!active || active.cancelled) return undefined;
    return { roomId: ctx.options.roomId, requestId: active.item.id, generationId: ctx.commandContext.generationId };
  }


  export function monolithRoomTurnLoopInterruptForServerMinimum(ctx: MonolithRoomTurnLoop): InterruptedTurn | undefined {
    const active = ctx.activeTurn;
    if (!active || active.cancelled) return undefined;
    // A long-running prompt is active, not 30 minutes idle. Keep its native
    // conversation eligible when the successor reclaims this journaled turn.
    ctx.warmTranscript.complete(ctx.sessionId, []);
    active.cancelled = true;
    if (ctx.client && ctx.sessionId) ctx.client.sessionCancel(ctx.sessionId);
    return {
      roomId: ctx.options.roomId,
      requestId: active.item.id,
      generationId: ctx.commandContext.generationId,
    };
  }


  export async function monolithRoomTurnLoopForceRecoverRoom(ctx: MonolithRoomTurnLoop): Promise<void> {
    if (ctx.client && ctx.sessionId) ctx.client.sessionCancel(ctx.sessionId);
    await ctx.options.scheduler.stop(ctx.options.roomId, true);
  }


  export function monolithRoomTurnLoopCommandActivation(ctx: MonolithRoomTurnLoop){
    if(!ctx.options.api.channel?.isOpen)return Promise.resolve(undefined);
    const command=ctx.commandContext?.current;
    if(!command){
      return Promise.reject(new Error('Activation requires a claimed command'));
    }
    return ctx.activationContext.read({agentId:ctx.agent.publicKey,workspaceId:ctx.options.workspaceId,
      roomId:ctx.options.roomId,commandId:command.id,generationId:ctx.commandContext.generationId});
  }


  export async function monolithRoomTurnLoopConfiguration(ctx: MonolithRoomTurnLoop){
    const activation=await ctx.commandActivation();
    return activation?activation.configuration:ctx.options.api.execute('getAgentConfiguration',{agentId:ctx.agent.publicKey,roomId:ctx.options.roomId});
  }


  export async function monolithRoomTurnLoopRoster(ctx: MonolithRoomTurnLoop): Promise<WorkspaceRoster> {
    const activation=await ctx.commandActivation();
    const roster = activation?activation.roster:await ctx.options.api.execute('getWorkspaceRoster', {
      agentId: ctx.agent.publicKey,
      workspaceId: ctx.options.workspaceId,
    });
    ctx.memberNames = new Map(roster.members.map((member) => [member.identityId, member.name]));
    return roster;
  }


  /**
   * Whether a picture actually reaches the model this session. Both halves
   * have to hold (C87): the harness must advertise `promptCapabilities.image`,
   * AND — when the pin knows the model's modalities — the model must take
   * images. `undefined` modalities mean the question was never settled, and
   * the harness answer stands alone as before.
   */
  export function monolithRoomTurnLoopAcceptsImages(ctx: MonolithRoomTurnLoop): boolean {
    if (!(ctx.client?.canPromptWithImages() ?? false)) return false;
    return ctx.modelTakesImages ?? true;
  }


  /** Reuse successful local copies; a later delivery retries failed files. */
  export async function monolithRoomTurnLoopDeliver(ctx: MonolithRoomTurnLoop, item: HumanMessage): Promise<DeliveredAttachment[]> {
    if (!item.attachments.length || !ctx.attachmentDir) return [];
    const cached = ctx.deliveredAttachments.get(item.id);
    if (cached?.length === item.attachments.length) return cached;
    const delivered = await deliverAttachments(
      item.attachments,
      join(ctx.attachmentDir, item.id.replace(/[^\w-]/g, '_')),
      ctx.options.fetchImpl,
      cached,
    );
    ctx.deliveredAttachments.set(item.id, withoutImageData(delivered.filter((entry) => entry.path)));
    return delivered;
  }


  export async function monolithRoomTurnLoopRepositoryState(ctx: MonolithRoomTurnLoop): Promise<RoomRepositoryState> {
    const activation=await ctx.commandActivation();
    return activation?activation.repository:ctx.options.api.execute('getRoomRepositoryState', { roomId: ctx.options.roomId });
  }


  /**
   * Drop this Room's live harness process. The next activation starts cold.
   * A rotation is a fact about one live session, so the pin goes with it.
   */
  /**
   * Claude Code may have refreshed its login during the prompt, detaching
   * this Room's credential link. Share the rotated login now so other Rooms
   * do not spend the old refresh token before this Room's next activation.
   */
  export async function monolithRoomTurnLoopWriteBackClaudeLogin(ctx: MonolithRoomTurnLoop): Promise<void> {
    if (!agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack || !ctx.options.config.agentHomeRoot) return;
    await writeBackRoomClaudeLogin({
      root: ctx.options.config.agentHomeRoot,
      operatorHome: ctx.options.config.operatorHome,
    }).catch((error: unknown) => {
      console.error(`[thin-core] monolith Room ${ctx.options.roomId} could not write back a refreshed Claude login:`, error);
    });
  }


  /**
   * After a turn, refresh the owner's view of this agent's OpenRouter key
   * spend. `refused` marks a turn OpenRouter refused with 402.
   */
  export function monolithRoomTurnLoopPublishOpenRouterSpend(ctx: MonolithRoomTurnLoop, refused = false): void {
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
  export function monolithRoomTurnLoopPublishHarnessQuota(ctx: MonolithRoomTurnLoop): void {
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


  export async function monolithRoomTurnLoopCaptureTurnMetrics(ctx: MonolithRoomTurnLoop) {
    ctx.publishOpenRouterSpend();
    ctx.publishHarnessQuota();
    return mergeHarnessTurnMetrics(ctx.turnUsage.usage, ctx.harnessTokens, ctx.client?.lastPromptBytes);
  }


  /**
   * Watch this client's Claude login so a refresh made while the
   * Room is idle reaches other Rooms at once (see `watchRoomClaudeLogin`).
   */
  export function monolithRoomTurnLoopWatchClaudeLogin(ctx: MonolithRoomTurnLoop): void {
    ctx.stopClaudeLoginWatch();
    if (!agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack || !ctx.options.config.agentHomeRoot) return;
    ctx.claudeLoginWatch = watchRoomClaudeLogin({
      root: ctx.options.config.agentHomeRoot,
      operatorHome: ctx.options.config.operatorHome,
    });
  }


  export function monolithRoomTurnLoopStopClaudeLoginWatch(ctx: MonolithRoomTurnLoop): void {
    ctx.claudeLoginWatch?.close();
    ctx.claudeLoginWatch = undefined;
  }


  export async function monolithRoomTurnLoopDiscardSession(ctx: MonolithRoomTurnLoop, preserveConversation = false): Promise<void> {
    if (!preserveConversation) ctx.warmTranscript.forgetSession();
    const client = ctx.client;
    ctx.stopClaudeLoginWatch();
    ctx.client = undefined;
    ctx.sessionId = undefined;
    ctx.sessionContextPath = undefined;
    ctx.sessionCwd = undefined;
    ctx.sessionCommit = undefined;
    ctx.sessionGitHubToken = undefined;
    ctx.sessionFingerprint = undefined;
    ctx.sessionCodegraphReady = false;
    ctx.pinnedProviderOverride = undefined;
    if (client) await stopAgentProcess(client);
  }


  /**
   * Whether the retained session still matches the agent's server-side
   * configuration. Retention (C104) is a saving only while what it keeps is
   * still current, and a session's persona, model pin, and mounted MCP set are
   * fixed when it opens: they cannot be corrected in place, so a changed one
   * has to cost a respawn. The check is one round trip — the roster half of
   * which the turn was going to fetch anyway — against a cold spawn measured
   * in seconds. A harness process that has exited (a memory-limit kill, a
   * crash) is never current: handing it back fails the turn with
   * `AcpClient not started` instead of spawning a fresh one.
   */
  export async function monolithRoomTurnLoopSessionIsCurrent(ctx: MonolithRoomTurnLoop): Promise<boolean> {
    if (!ctx.client?.isAlive || ctx.sessionContextPath !== ctx.commandContext.path) return false;
    await ctx.refreshTurnCheckout();
    return (
      ctx.sessionCwd === ctx.options.cwd &&
      ctx.sessionCommit === ctx.turnCheckout?.commit &&
      ctx.sessionGitHubToken === ctx.turnCheckout?.githubToken &&
      (await ctx.currentSessionFingerprint()) === ctx.sessionFingerprint
    );
  }


  export async function monolithRoomTurnLoopRefreshTurnCheckout(ctx: MonolithRoomTurnLoop): Promise<void> {
    const checkout = await ctx.options.refreshCheckout?.();
    if (!checkout) return;
    ctx.turnCheckout = checkout;
    if (checkout.cwd === ctx.options.cwd) return;
    ctx.options.cwd = checkout.cwd;
    ctx.options.grantRunner?.register(ctx.options.roomId, {
      workspaceId: ctx.options.workspaceId,
      cwd: checkout.cwd,
      writePolicy: () => ctx.grantWritePolicy(),
      turn: () => {
        const turn = ctx.currentTurnForRunner();
        return turn ? { ...turn, generationId: ctx.commandContext.generationId } : undefined;
      },
    });
  }


  export async function monolithRoomTurnLoopCurrentSessionFingerprint(ctx: MonolithRoomTurnLoop): Promise<string> {
    const [configuration, roster, grants] = await Promise.all([
      ctx.configuration(),
      ctx.roster(),
      ctx.grantedResources(),
    ]);
    const { hostRoutes: grantedHostRoutes, devices: grantedDevices, isolatedCategories } = grants;
    const self = roster.members.find((member) => member.identityId === ctx.agent.publicKey);
    const registryRoutes = configuration.registryMcpRoutes ?? [];
    return sessionConfigFingerprint({
      devices: grantedDevices,
      isolatedCategories,
      model: configuration.model ?? ctx.options.config.modelSelection?.model,
      effort: configuration.effort ?? ctx.options.config.modelSelection?.effort,
      fastMode: configuration.fastMode,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? ctx.agent.name,
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
    });
  }


  export async function monolithRoomTurnLoopGrantedResources(ctx: MonolithRoomTurnLoop) {
    return sessionGrantedResources(ctx.options.config, async () => {
      const activation = await ctx.commandActivation();
      return activation ? activation.grants : ctx.options.api.execute('listAgentGrants', {
        agentId: ctx.agent.publicKey,
        roomId: ctx.options.roomId,
      });
    });
  }


  export function monolithRoomTurnLoopMountedMcpServers(ctx: MonolithRoomTurnLoop, preparedEnv?: Record<string, string>): string[] {
    return mountedImportedMcpServerNames({
      operatorHome: ctx.options.config.operatorHome,
      agentKind: ctx.options.config.agentKind,
      preparedEnv,
    });
  }


  export async function monolithRoomTurnLoopActivate(ctx: MonolithRoomTurnLoop, trace?: TurnTrace): Promise<string> {
    if (ctx.options.config.agentProgramError) throw new Error(ctx.options.config.agentProgramError);
    const startupAt = performance.now();
    let previousStep = startupAt;
    const startupStep = (step: string) => {
      const now = performance.now();
      console.info(`[body] session-start ${new Date().toISOString()} room=${ctx.options.roomId} step=${step} elapsedMs=${Math.round(now-startupAt)} stepMs=${Math.round(now-previousStep)}`);
      previousStep = now;
    };
    await ctx.refreshTurnCheckout();
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
      return await ctx.activateCold(trace, startupStep);
    } catch (error) {
      // Cleanup must not hide the activation failure that owns the receipt.
      await ctx.discardSession(true).catch(cleanupError =>
        console.error('[body] failed to stop harness after activation failure:', cleanupError),
      );
      throw error;
    }
  }
