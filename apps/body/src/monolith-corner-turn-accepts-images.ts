import { type PromptResult } from './acp.js';
import { durableReplyText } from './turn-stream.js';
import { harnessIdentityLabel } from './cursor-acp-bridge.js';
import { explainEmptyAgentTurn, isSilentCompletion, nextPinnedProvider, type EmptyTurnExplanation } from './empty-turn.js';
import { cornerHasRepositoryWork } from './prompt-assembly.js';
import { stopAgentProcess } from './agent-process.js';
import { TurnTrace, TurnTraceFile } from './turn-trace.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';



  /** A picture reaches the model only if the harness AND the model take one (C87). */
  export function monolithCornerTurnLoopAcceptsImages(ctx: MonolithCornerTurnLoop): boolean {
    if (!(ctx.client?.canPromptWithImages() ?? false)) return false;
    return ctx.modelTakesImages ?? true;
  }


  /** The pinned providers a failure reason should name for this session. */
  export function monolithCornerTurnLoopServingProviders(ctx: MonolithCornerTurnLoop): string[] {
    return ctx.pinnedProviderOverride ? [ctx.pinnedProviderOverride] : ctx.pinnedProviders;
  }


  /** Why a turn carried no answer text, or undefined when it did. */
  export async function monolithCornerTurnLoopExplainEmpty(ctx: MonolithCornerTurnLoop, result: PromptResult): Promise<EmptyTurnExplanation | undefined> {
    if (['no-reply', 'repeated-tool-call'].includes(result.stopReason)) return undefined;
    if (durableReplyText(result.agentText)) return undefined;
    // Passive browser updates owe no answer and must not start provider
    // retries. Their receipt acknowledges delivery, even for a textless turn.
    if (ctx.commandContext.current?.source.systemEvent?.kind === 'computer-session-activity') return undefined;
    const explanation = await explainEmptyAgentTurn({
      agentLabel: harnessIdentityLabel({
        kind: ctx.options.config.agentKind,
        command: ctx.options.config.agentCommand ?? ctx.options.config.agentBinary,
      }),
      agentEnv: ctx.agentEnv,
      sessionId: ctx.sessionId!,
      result,
    });
    // OpenRouter refuses a key past its limit with 402; show the stop now.
    if (explanation.record?.kind === 'error' && explanation.record.status === 402)
      ctx.publishOpenRouterSpend(true);
    if (isSilentCompletion(result, explanation)) return undefined;
    return explanation;
  }


  /**
   * Re-pin the session to the next provider in the OpenRouter order and open a
   * fresh session on it, so the retry of an empty completion or a failing
   * provider is served — and named — by exactly one provider (C92).
   */
  export async function monolithCornerTurnLoopRepinNextProvider(ctx: MonolithCornerTurnLoop, trace?: TurnTrace, reason?: string): Promise<string | undefined> {
    const next = nextPinnedProvider(ctx.pinnedProviders, ctx.pinnedProviderOverride);
    if (!next) return undefined;
    // The retry is its own timeline, fresh ACP handshake included.
    trace?.retry({ provider: next, ...(reason ? { reason } : {}) });
    const client = ctx.client;
    ctx.stopClaudeLoginWatch();
    ctx.client = undefined;
    ctx.sessionId = undefined;
    ctx.sessionContextPath = undefined;
    ctx.sessionFingerprint = undefined;
    ctx.sessionCodegraphReady = false;
    if (client?.hasBackgroundTools) void ctx.retainBackgroundClient(client);
    else if (client) await stopAgentProcess(client);
    ctx.pinnedProviderOverride = next;
    await (trace ? trace.measure('activation', () => ctx.activate(trace)) : ctx.activate());
    return next;
  }


  /** One turn's stopwatch; writes only when the daemon configured a trace directory. */
  export function monolithCornerTurnLoopBeginTurnTrace(ctx: MonolithCornerTurnLoop, requestId: string): TurnTrace {
    const directory = ctx.options.config.turnTraceDir;
    if (directory) ctx.turnTraceSink ??= new TurnTraceFile(directory);
    return new TurnTrace({
      surface: 'corner',
      agentId: ctx.agent.publicKey,
      roomId: ctx.options.cornerId,
      requestId,
      ...(ctx.turnTraceSink ? { sink: ctx.turnTraceSink } : {}),
    });
  }


  export async function monolithCornerTurnLoopWithCheckout<T>(ctx: MonolithCornerTurnLoop, work: () => Promise<T>): Promise<T> {
    // Each writer owns its refs and files. Detached tools retain their harness,
    // never a checkout lock or another agent's turn.
    const configuration = ctx.options.repository ? await ctx.configuration() : undefined;
    ctx.reviewerCheckout = configuration?.isReviewer === true;
    if (ctx.options.prepareCheckout && ctx.options.repository) {
      const restored = await ctx.restoredState();
      // An unbriefed human corner still bootstraps on its feature branch;
      // repository publication remains gated by its first assigned brief.
      const repositoryWork = !restored.brief || cornerHasRepositoryWork(restored.brief);
      // An order gives work; a reviewer keeps its own detached copy (#3176).
      const assigned = ctx.commandContext.current?.reason === 'order' || ctx.reviewerCheckout;
      const checkout = await ctx.options.prepareCheckout(repositoryWork, restored.implementerAgentId, assigned);
      if (checkout.path !== ctx.options.worktreePath) await ctx.discardSession(true);
      ctx.options.worktreePath = checkout.path;
      ctx.options.repository.gitCommonDir = checkout.gitCommonDir;
      ctx.options.repository.readOnly = !checkout.writable;
    }
    try { return await work(); }
    catch (error) {
      await ctx.discardSession(true);
      throw error;
    }
  }
