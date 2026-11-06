import { OwnedModelOutcomeUnknown, ownedModelPrompt, ownedModelEndReceipt } from './owned-model-turn.js';
import { addTurnTokenFigure } from './harness-turn-tokens.js';
import { TurnUsageAccumulator } from './turn-usage.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { type DaemonAttachment } from '@beeline/api-contract/daemon';
import { isPureRetryNarration, type PromptResult, type ToolCallEntry } from './acp.js';
import { freshHarnessLoginLine, isExpiredHarnessLoginError, repairRoomAgentCredentialLinks } from './agent-home.js';
import { attachmentImageBlocks, attachmentMarkerLines, attachmentPromptLines, deliverAttachments, promptWithImages, type DeliveredAttachment } from './attachment-delivery.js';
import { isCornerStatusRestatement } from './reply-sanitizer.js';
import { TurnStoppedError } from './turn-stop.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { isCompletedToolCall, isPrChecksRead, toolCallFailureLine } from './tool-call-failure.js';
import { captureConnectionUsage } from './connector-runner.js';
import { distillTurnFailureReason, redactTurnError } from './turn-failure-reason.js';
import { allocatedDirectoryBytes, scratchBudgetMessage, scratchGrowthExceedsBudget } from './scratch-lifecycle.js';
import { awaitInstitutionalContext, startInstitutionalContextFetch } from './institutional-context.js';
import { approvedDeviceGrant, deviceGrantResumePrompt } from './monolith-room-turn.js';
import { isAccountOrProviderRefusal, isContextOverflowTurn, shouldFailOverProviderError, shouldRetryEmptyTurn, turnFailureReasonWithProvider } from './empty-turn.js';
import { assembleTurnPrompt, CORNER_DELIVERY_NUDGE, cornerHasRepositoryWork, CORNER_REVIEWER_SESSION_INSTRUCTION, CORNER_CHECKS_NUDGE, roomMentionDirectory, renderReplyContext } from './prompt-assembly.js';
import { isAgentProcessExit } from './agent-process.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';

import { MonolithCornerTurnLoop, isCornerReviewTurn, DaemonActivity, toolCallKey, toolCallSettled, cornerToolActivity, isCornerChecksTurn, cornerUndeliveredRepositoryState } from './monolith-corner-turn.js';



  export async function monolithCornerTurnLoopPrompt(ctx: MonolithCornerTurnLoop,
    requestId: string,
    trigger: string,
    attachments: readonly DaemonAttachment[] = [],
    requestedById?: string,
    /** Server system lines this turn answers; a reply that only restates them is dropped. */
    restates?: readonly string[],
    sourceMessageId?: string,
  ): Promise<void> {
    const { api, cornerId } = ctx.options;
    const activityTurn = ctx.commandContext.current?.source.systemEvent?.kind === 'computer-session-activity';
    // Work the requester has already withdrawn is never started. A stop can
    // land between the message being read and the session becoming free.
    if (ctx.stoppedTurns.has(requestId)) return;
    const spoken = (text: string): string =>
      restates && isCornerStatusRestatement(text, restates) ? '' : text;
    const requester = requestedById
      ? {
          pubkey: requestedById,
          ...(ctx.memberNames.get(requestedById)
            ? { name: ctx.memberNames.get(requestedById)! }
            : {}),
        }
      : undefined;
    ctx.currentTurn = { requestId, ...(requester ? { requester } : {}) };
    const trace = ctx.beginTurnTrace(requestId);
    let timeLimited = false;
    const freeAgent = Boolean(ctx.options.config.agentEnv?.BEELINE_FREE_AGENT_ID ||
      ctx.options.config.agentEnv?.BEELINE_FREE_AGENT_MODEL_TOKEN);
    const traceGenerationId = ctx.commandContext.generationId;
    // Kicked off now, alongside activation rather than after it, so its own
    // network round trip has somewhere to hide (see institutional-context.ts).
    const institutionalContextFetch = startInstitutionalContextFetch(api, cornerId);
    // Best-effort read of this turn's search_memory call/miss counters before
    // the trace writes — bounded so a slow or unreachable server never delays
    // the turn's own completion over a diagnostic.
    let statsPromise: Promise<{ searchCalls: number; searchMisses: number } | undefined> | undefined;
    const startTraceStats = (): void => {
      if (statsPromise) return;
      statsPromise = api.execute('getInstitutionalMemoryTurnStats', {
        roomId: cornerId,
        agentId: ctx.agent.publicKey,
        requestId,
      }).catch(() => undefined);
    };
    const finishTrace = async (
      outcome: 'complete' | 'failed' | 'cancelled',
      reason?: string,
    ): Promise<void> => {
      try {
        const stats=await statsPromise;
        if (stats) trace.noteSearchMemoryStats(stats.searchCalls, stats.searchMisses);
      } catch {
        // Losing this measurement must never affect the turn.
      }
      if (outcome === 'cancelled') {
        await api.execute('postAgentTurnReceipt', {
          agentId: ctx.agent.publicKey, roomId: cornerId, requestId,
          generationId: traceGenerationId, status: 'cancelled', trace: trace.replay(),
        }).catch(() => console.warn('[turn-trace] trace dropped'));
      }
      await trace.finish(outcome, reason);
    };
    try {
      if (freeAgent) await ctx.freeContinuation.begin(ctx.commandContext.current?.source.body ?? trigger);
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: ctx.agent.publicKey,
          roomId: cornerId,
          requestId,
          generationId: ctx.commandContext.generationId,
        },
        async () => {
          trace.noteScheduler('queue', ctx.options.scheduler.snapshot());
          trace.start('queue-wait');
          return ctx.withCheckout(() => ctx.options.scheduler.run(
            cornerId,
            ctx.lifecycle(trace),
            async () => {
              // Belt and braces: `activate`/`isCurrent` already closed the
              // queue wait, and `end` on a closed phase is a no-op.
              trace.end('queue-wait');
              trace.noteScheduler('admission', ctx.options.scheduler.snapshot());
              if (ctx.forcedStop) throw new Error('corner turn stopped for daemon handoff');
              ctx.busy = true;
              // A turn starts with no measured cost. Without this reset a turn
              // that throws before its own prompt settles — the context fetch,
              // `buildPrompt`, a rejected delivery — would report the PREVIOUS
              // turn's token count and prompt size on its failure receipt, and
              // the budget gate would read somebody else's prompt.
              ctx.turnMetrics = {};
              ctx.turnUsage = new TurnUsageAccumulator();
              ctx.harnessTokens = undefined;
              await ctx.syncBranch();
              const reviewTurn = !activityTurn && isCornerReviewTurn(Boolean(ctx.reviewerInstructionInput), trigger);
              const [
                conversation,
                roster,
                restored,
                activeReviewerInstruction,
                institutionalContext,
                memberCorners,
                onboarding,
              ] = await trace.measure('context-fetch', () =>
                Promise.all([
                  api.execute('getRoomConversation', {
                    roomId: cornerId,
                    limit: 200,
                    narrationRequestId: requestId,
                  }),
                  ctx.roster(),
                  ctx.restoredState(),
                  ctx.activeReviewerInstruction(),
                  awaitInstitutionalContext(institutionalContextFetch, (message) =>
                    console.warn(`[thin-core] corner ${cornerId}: ${message}`),
                  ),
                  api.execute('listRoomCorners', { roomId: ctx.options.parentRoomId }),
                  ctx.repositoryState()
                    .then(state => state.repositoryOnboarding === true, () => false),
                ]),
              );
              trace.noteInstitutionalMemory(institutionalContext.outcome);
              if (institutionalContext.embeddingOutcome !== undefined) {
                trace.noteInstitutionalMemoryEmbedding(
                  institutionalContext.embeddingOutcome,
                  institutionalContext.embeddingMs ?? 0,
                );
              }
              let repositoryWork = cornerHasRepositoryWork(restored.brief);
              let repositoryHeld = restored.held === true;
              let assignedBrief = restored.brief;
              const taskDelivered: DeliveredAttachment[] =
                ctx.attachmentDir && attachments.length
                  ? await deliverAttachments(
                      attachments,
                      join(ctx.attachmentDir, requestId.replace(/[^\w-]/g, '_')),
                      ctx.options.fetchImpl,
                    )
                  : [];
              let delivered = taskDelivered;
              let briefFileLines: string[] = [];
              let missingRequiredBriefFile = false;
              const deliverBrief = async (): Promise<void> => {
                const briefAttachments: DaemonAttachment[] = (assignedBrief?.attachments ?? []).map(
                  (file) => ({
                    url: new URL(`/v1/media/${file.objectId}`, api.baseUrl).toString(),
                    name: file.title,
                    mimeType: file.mime,
                    size: file.size,
                  }),
                );
                const briefDelivered: DeliveredAttachment[] =
                  ctx.attachmentDir && briefAttachments.length
                    ? await deliverAttachments(
                        briefAttachments,
                        join(
                          ctx.attachmentDir,
                          requestId.replace(/[^\w-]/g, '_'),
                          'brief',
                          String(assignedBrief!.revision),
                        ),
                        ctx.options.fetchImpl,
                      )
                    : [];
                briefFileLines = await Promise.all(
                  (assignedBrief?.attachments ?? []).map(async (file, index) => {
                    const entry = briefDelivered.find(
                      (item) => item.attachment === briefAttachments[index],
                    );
                    const verified =
                      entry?.path &&
                      createHash('sha256')
                        .update(await readFile(entry.path))
                        .digest('hex') === file.sha256;
                    return `- ${file.title} (${file.purpose}; ${file.required ? 'required' : 'optional'}; sha256 ${file.sha256}): ${verified ? entry.path : 'UNAVAILABLE OR CONTENT MISMATCH'}`;
                  }),
                );
                missingRequiredBriefFile = (assignedBrief?.attachments ?? []).some(
                  (file, index) =>
                    file.required &&
                    briefFileLines[index]?.includes('UNAVAILABLE OR CONTENT MISMATCH'),
                );
                delivered = [...taskDelivered, ...briefDelivered];
              };
              await deliverBrief();
              const names = new Map(
                roster.members.map((member) => [member.identityId, member.name]),
              );
              const requestedBy =
                requester && !requester.name && names.get(requester.pubkey)
                  ? { ...requester, name: names.get(requester.pubkey)! }
                  : requester;
              if (requestedBy) ctx.currentTurn = { requestId, requester: requestedBy };
              // The newest message renders once, as the task; activity rows with
              // no text carry nothing a model can read.
              const transcriptRows = conversation.items
                .filter(
                  (message) =>
                    message.id !== requestId &&
                    message.id !== sourceMessageId &&
                    (message.body.trim() || message.attachments?.length),
                )
                .slice(-120)
                .map((message) => ({
                  id: message.id,
                  authorId: message.authorId,
                  line: [
                    ...(message.type === 'message' ? [`[message id: ${message.id}]`] : []),
                    `${names.get(message.authorId) ?? 'Beeline'} [${message.type}]: ${message.body.trim() ? message.body : '(shared attachments)'}`,
                    ...(message.replyToMessageId ? [renderReplyContext(message)] : []),
                    ...attachmentMarkerLines(message.attachments ?? []),
                  ].join('\n'),
                }));
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // transcript. The objective is outside the window and always
              // renders, warm session or not.
              const buildPrompt = async (followup?: string): Promise<string> => {
                await ctx.client?.preparePromptDelivery(ctx.sessionId);
                // Context reads and file delivery can outlive a brief revision.
                // Check at assembly time; unchanged revisions return no spec or files.
                for (;;) {
                  const { revisions } = await api.execute('listCornerBriefRevisions', {
                    cornerId,
                    afterRevision: assignedBrief?.revision ?? 0,
                    limit: 1,
                  });
                  const latestBrief = revisions[0];
                  if (!latestBrief || latestBrief.revision <= (assignedBrief?.revision ?? 0)) break;
                  assignedBrief = latestBrief;
                  await deliverBrief();
                }
                repositoryWork = cornerHasRepositoryWork(assignedBrief);
                if (ctx.repositoryWork !== repositoryWork) {
                  await ctx.discardSession();
                  await trace.measure('activation', () => ctx.activate(trace));
                }
                if (followup === CORNER_DELIVERY_NUDGE && !(repositoryWork && !repositoryHeld))
                  followup = 'Deliver files with post_artifact; answer plain chat questions directly.';
                if (followup && !assignedBrief) return followup;
                const briefContext = {
                  ...(assignedBrief
                    ? {
                        brief: {
                          brief: assignedBrief,
                          fileLines: briefFileLines,
                          missingRequiredFile: missingRequiredBriefFile,
                        },
                      }
                    : {}),
                };
                const transcript = ctx.warmTranscript.select(
                  ctx.sessionId,
                  transcriptRows,
                  ctx.agent.publicKey,
                );
                const assembled = assembleTurnPrompt(followup ? {
                  surface: ctx.sessionSurface,
                  onboarding,
                  modelContextTokens: ctx.modelContextTokens,
                  ...(freeAgent ? { timeLimitCheckpoint: ctx.freeContinuation.context } : {}),
                  ...briefContext,
                  task: { body: followup },
                } : {
                  delivery: ctx.client?.promptDelivery(ctx.sessionId),
                  surface: ctx.sessionSurface,
                  modelContextTokens: ctx.modelContextTokens,
                  ...(freeAgent ? { timeLimitCheckpoint: ctx.freeContinuation.context } : {}),
                  onboarding,
                  sessionPrefix: ctx.turnSessionPrefix,
                  objective: restored.objective ?? ctx.options.objective,
                  ...(restored.titleGenerated && restored.title
                    ? { generatedTitle: restored.title }
                    : {}),
                  ...briefContext,
                  transcript: {
                    lines: transcript.rows.map((row) => row.line),
                    sinceLastTurn: transcript.warm,
                  },
                  members: roomMentionDirectory(roster, ctx.agent.publicKey),
                  memory: institutionalContext.text,
                  corners: memberCorners.corners?.filter(
                    (corner) => corner.cornerId !== cornerId && !corner.archived,
                  ),
                  ...(activeReviewerInstruction
                    ? { reviewerTarget: activeReviewerInstruction }
                    : {}),
                  task: {
                    ...(sourceMessageId && conversation.items.some(
                      (message) => message.id === sourceMessageId && message.type === 'message',
                    ) ? { reactionTargetId: sourceMessageId } : {}),
                    body: trigger,
                    reply: ctx.commandContext.current?.source,
                    commandReason: ctx.commandContext.current?.reason,
                    outsideEvent: ctx.commandContext.current?.source.systemEvent,
                    attachmentLines: attachmentPromptLines(
                      attachments,
                      delivered,
                      ctx.acceptsImages(),
                    ),
                  },
                });
                trace.notePromptSections(
                  assembled.report,
                  ctx.sectionBaseline.observe(ctx.sessionId, assembled.report),
                );
                ctx.commandContext.notePromptSections([
                  ...ctx.sessionPromptSectionIds,
                  ...assembled.report.map((section) => section.id),
                ]);
                const promptText = ctx.branchSyncNotice ? `${assembled.text}\n\nRepository state: ${ctx.branchSyncNotice}` : assembled.text;
                if (!repositoryWork) {
                  const scratch = ctx.options.worktreePath;
                  const usage = scratch ? await allocatedDirectoryBytes(scratch) : 0;
                  const text = `${promptText}\n\n${scratchBudgetMessage(usage)}`;
                  trace.notePromptWindow(text, ctx.modelContextTokens);
                  return text;
                }
                trace.notePromptWindow(promptText, ctx.modelContextTokens);
                return promptText;
              };
              // Rooms and corners share the provisional draft lane, request-id
              // handoff, and single durable final reply in `turn-stream.ts`.
              // The corner-only work ledger below is independent of that lane.
              const stream = new AgentTurnStream({
                api,
                commandId:ctx.commandContext.current?.id,
                turnGeneration:ctx.commandContext.generationId,
                agentId: ctx.agent.publicKey,
                roomId: cornerId,
                requestId,
                label: `corner ${cornerId}`,
              });
              let currentNarrationRun = '';
              let completedNarrationRuns: string[] = [];
              let narrationRunBoundary = 0;
              const takeInterimNarration = (): string => {
                const narration = spoken(
                  [...completedNarrationRuns, currentNarrationRun]
                    .map((run) => spoken(durableReplyText(run)))
                    .filter((run) => run && !isPureRetryNarration(run))
                    .join('\n\n'),
                );
                narrationRunBoundary += completedNarrationRuns.length;
                completedNarrationRuns = [];
                currentNarrationRun = '';
                return narration;
              };
              const publishedToolCalls = new Set<string>();
              const observedToolCalls = new Set<string>();
              const pendingToolNarrations = new Map<string, string>();
              /**
               * The stream snapshot each pending narration was taken at. It
               * becomes this turn's persisted offset only once that narration
               * reaches the ledger, so a tool call that never settles — or a
               * narration the final-reply dedupe drops — never moves it and
               * the text stays in the draft and the reply.
               */
              const pendingToolOffsets = new Map<string, string>();
              const pendingToolActivities = new Map<string, DaemonActivity[]>();
              let lastNarratedToolCall: string | undefined;
              let activityAttempt = 0;
              const publishToolCalls = (
                calls: readonly ToolCallEntry[],
                settledOnly: boolean,
                /**
                 * A live (mid-turn) publish must never finalize the ONE row
                 * `flushToolCalls` may still rewrite: the most recently
                 * narrated call's row is skipped here whenever it could still
                 * turn out to hold the same text as the turn's eventual
                 * durable reply (see the dedupe at the top of `flushToolCalls`).
                 * Every earlier, already-superseded call streams immediately.
                 */
                exceptKey?: string,
              ) => {
                calls.forEach((call, index) => {
                  const key = `${activityAttempt}:${toolCallKey(call, index)}`;
                  if (settledOnly && !observedToolCalls.has(key)) {
                    observedToolCalls.add(key);
                    // The ledger consumes the stream up to its current end, so
                    // the snapshot the offset would move to is simply what the
                    // lane has seen at the moment of the take.
                    const at = stream.streamedText;
                    const narration = takeInterimNarration();
                    pendingToolNarrations.set(key, narration);
                    pendingToolOffsets.set(key, at);
                    if (narration) lastNarratedToolCall = key;
                  }
                  if (
                    settledOnly ||
                    publishedToolCalls.has(key) ||
                    !toolCallSettled(call) ||
                    key === exceptKey
                  )
                    return;
                  publishedToolCalls.add(key);
                  const producingModel = ctx.sessionModel;
                  const narration = pendingToolNarrations.get(key) ?? '';
                  ctx.activityTail = ctx.activityTail
                    .catch(() => undefined)
                    .then(async () => {
                      let activity = pendingToolActivities.get(key);
                      if (!activity) {
                        const toolActivity = await cornerToolActivity(
                          call,
                          ctx.options.worktreePath,
                          requestedBy,
                        );
                        activity = [
                          ...(narration
                            ? [
                                {
                                  kind: 'output' as const,
                                  title: 'Update',
                                  text: narration,
                                  ...(requestedBy ? { requestedBy } : {}),
                                },
                              ]
                            : []),
                          toolActivity,
                        ];
                        pendingToolActivities.set(key, activity);
                      }
                      await api.execute('postAgentActivity', {
                        agentId: ctx.agent.publicKey,
                        roomId: cornerId,
                        requestId,
                        cornerActivityKey: key,
                        agentModel: producingModel,
                        activity,
                      });
                      // Only now is that prose somewhere a reader can scroll
                      // to, so only now does the draft stop showing it and the
                      // reply stop carrying it.
                      const at = pendingToolOffsets.get(key);
                      if (narration && at !== undefined) stream.markPersisted(at);
                      pendingToolNarrations.delete(key);
                      pendingToolOffsets.delete(key);
                      pendingToolActivities.delete(key);
                    })
                    .then(() => undefined)
                    .catch((error) => {
                      publishedToolCalls.delete(key);
                      console.error(`[thin-core] corner ${cornerId} tool activity failed:`, error);
                    });
                });
              };
              const flushToolCalls = async (
                calls: readonly ToolCallEntry[],
                finalReply: string,
                final = false,
              ): Promise<void> => {
                await ctx.activityTail;
                if (
                  lastNarratedToolCall &&
                  pendingToolNarrations.get(lastNarratedToolCall) === finalReply
                )
                  pendingToolNarrations.delete(lastNarratedToolCall);
                publishToolCalls(calls, false);
                await ctx.activityTail;
                if (ctx.options.connectorUsage) {
                  captureConnectionUsage(
                    ctx.options.connectorUsage,
                    { requestId, agentId: ctx.agent.publicKey, cornerId },
                    calls,
                  );
                  if (final) await ctx.options.connectorUsage.flush(api, requestId);
                }
                await ctx.activityTail;
                publishToolCalls(calls, false);
                await ctx.activityTail;
              };
              // One prompt run. It is a closure because an empty completion
              // re-pins the session to another provider and runs it again
              // (C92) — against the NEW client and session id.
              const runPromptAttempt = async (prompt: string): Promise<PromptResult> => {
                const backgroundGeneration = ctx.commandContext.generationId;
                activityAttempt += 1;
                publishedToolCalls.clear();
                observedToolCalls.clear();
                pendingToolNarrations.clear();
                pendingToolOffsets.clear();
                pendingToolActivities.clear();
                lastNarratedToolCall = undefined;
                stream.beginRun();
                completedNarrationRuns = [];
                narrationRunBoundary = 0;
                currentNarrationRun = '';
                trace.promptSent();
                const scratchRoot = ctx.repositoryWork ? undefined : ctx.options.worktreePath;
                const scratchAtStart = scratchRoot ? await allocatedDirectoryBytes(scratchRoot) : 0;
                const promptClient = ctx.client!;
                try {
                  const result = await ctx.turnUsage.measure(
                  { agentEnv: ctx.agentEnv, sessionId: ctx.sessionId! },
                  () => ownedModelPrompt(ctx.commandContext, () =>
                    promptClient.sessionPrompt(
                      ctx.sessionId!,
                      promptWithImages(prompt, attachmentImageBlocks(delivered, ctx.acceptsImages())),
                      (delta, full, currentRun, runs) => {
                        trace.firstModelOutput();
                        if (runs) {
                          completedNarrationRuns = runs.slice(narrationRunBoundary);
                          currentNarrationRun = '';
                        } else if (currentRun === undefined) currentNarrationRun += delta;
                        else {
                          if (
                            currentNarrationRun &&
                            currentNarrationRun !== currentRun &&
                            !currentRun.startsWith(currentNarrationRun)
                          )
                            completedNarrationRuns.push(currentNarrationRun);
                          currentNarrationRun = currentRun;
                        }
                        stream.onChunk(delta, full, currentRun);
                      },
                      undefined,
                      (calls) => {
                        trace.toolCalls(calls);
                        // Observe (snapshot the narration that preceded each newly
                        // seen call) THEN publish: a human watching a corner sees a
                        // tool's row the moment it settles, not batched at the
                        // turn's end behind a still-running sibling call. The
                        // current tail (`lastNarratedToolCall`) is held back:
                        // `flushToolCalls` may still need to drop its narration if
                        // it turns out to duplicate the turn's final reply.
                        publishToolCalls(calls, true);
                        publishToolCalls(calls, false, lastNarratedToolCall);
                      },
                      (call) => {
                        ctx.retiredClients.get(promptClient)?.check();
                        if (!requestId || !backgroundGeneration || !call.id) return;
                        void api.execute('postBackgroundToolCompletion', {
                          roomId: ctx.options.cornerId, requestId,
                          generationId: backgroundGeneration,
                          toolCallId: call.id, title: call.title ?? call.id,
                          status: call.status === 'failed' ? 'failed' : 'completed',
                        }).catch((error) => console.error('[corner] background tool wake failed', redactTurnError(error)));
                      },
                    )),
                  );
                  ctx.harnessTokens = addTurnTokenFigure(ctx.harnessTokens, result.tokenUsage);
                  return result;
                } finally {
                  if (scratchRoot) {
                    const usage = await allocatedDirectoryBytes(scratchRoot);
                    if (scratchGrowthExceedsBudget(usage, scratchAtStart))
                      throw new Error(`Scratch budget exceeded. ${scratchBudgetMessage(usage)}`);
                  }
                }
              };
              let loginRetryUsed = false;
              const runPrompt = async (prompt?: string, continuation?: string): Promise<PromptResult> => {
                const activePrompt = async (): Promise<string> => {
                  const assembled = await buildPrompt(prompt);
                  return continuation ? `${assembled}\n\n${continuation}` : assembled;
                };
                try {
                  return await runPromptAttempt(await activePrompt());
                } catch (error) {
                  if (isAgentProcessExit(error) || !isExpiredHarnessLoginError(error)) throw error;
                  if (loginRetryUsed) {
                    return {
                      stopReason: 'login-required',
                      updates: [],
                      agentText: freshHarnessLoginLine(ctx.options.config.agentKind, hostname()),
                      toolCalls: [],
                    };
                  }
                  loginRetryUsed = true;
                  console.warn(
                    `[thin-core] corner ${cornerId} turn ${requestId}: ` +
                      'harness login expired; repairing the shared credential and retrying once',
                  );
                  trace.retry({ reason: 'expired harness login' });
                  if (ctx.options.config.agentHomeRoot) {
                    await repairRoomAgentCredentialLinks({
                      root: ctx.options.config.agentHomeRoot,
                      operatorHome: ctx.options.config.operatorHome,
                    });
                  }
                  await ctx.discardSession();
                  await trace.measure('activation', () => ctx.activate(trace));
                  try {
                    return await runPromptAttempt(await activePrompt());
                  } catch (retryError) {
                    if (isAgentProcessExit(retryError) || !isExpiredHarnessLoginError(retryError)) throw retryError;
                    return {
                      stopReason: 'login-required',
                      updates: [],
                      agentText: freshHarnessLoginLine(ctx.options.config.agentKind, hostname()),
                      toolCalls: [],
                    };
                  }
                } finally {
                  // Captured while the session is still alive: `discardSession`
                  // clears both the client and the id, and the terminal receipt
                  // that reports these facts may be posted after it.
                  ctx.turnMetrics = await ctx.captureTurnMetrics();
                  await ctx.writeBackClaudeLogin();
                }
              };
              const completeTerminal = async (result: PromptResult): Promise<boolean> => {
                if (result.stopReason === 'free-agent-time-limit') {
                  stream.close();
                  timeLimited = true;
                  let reply: string;
                  try { reply = await ctx.freeContinuation.stopped(result); }
                  finally { await ctx.discardSession(); }
                  await stream.settle(reply, requestedById ? { triggerMessageId: requestId } : {});
                  return true;
                }
                if (!['no-reply', 'repeated-tool-call'].includes(result.stopReason)) return false;
                stream.close();
                await flushToolCalls(result.toolCalls, '', true);
                await stream.retract();
                await ctx.discardSession();
                return true;
              };
              let result = await runPrompt();
              trace.promptSettled();
              if (await completeTerminal(result)) return;
              // An instantly approved device grant cannot reach the running
              // sandbox: replace the session and continue this same turn there.
              const grantedDevice = approvedDeviceGrant(result.toolCalls);
              if (grantedDevice) {
                await flushToolCalls(result.toolCalls, '');
                trace.retry({ reason: 'device grant' });
                if (!(await ctx.sessionIsCurrent())) {
                  await ctx.discardSession();
                  await trace.measure('activation', () => ctx.activate(trace));
                }
                result = await runPrompt(
                  undefined,
                  deviceGrantResumePrompt(grantedDevice, result.agentText),
                );
                trace.promptSettled();
                if (await completeTerminal(result)) return;
              }
              let explained = await ctx.explainEmpty(result);
              // A checks turn is told to say nothing when nothing changed; its
              // silence is not a routing failure and must not buy a retry. A
              // stopped turn's `aborted` silence is not one either. A
              // provider's 429/5xx moves the pin onward.
              if (
                explained &&
                !ctx.stoppedTurns.has(requestId) &&
                ((!restates && shouldRetryEmptyTurn(explained)) ||
                  shouldFailOverProviderError(explained))
              ) {
                await flushToolCalls(result.toolCalls, '');
                const silent = ctx.servingProviders();
                const next = await ctx.repinNextProvider(trace, explained.reason);
                if (next) {
                  console.warn(
                    `[thin-core] corner ${cornerId} turn ${requestId}: ` +
                      `${turnFailureReasonWithProvider(explained.reason, silent)}; retrying on ${next}`,
                  );
                  result = await runPrompt();
                  trace.promptSettled();
                  if (await completeTerminal(result)) return;
                  explained = await ctx.explainEmpty(result);
                }
              }
              // A session whose history outgrew the model's window refuses
              // every retry inside it. One retry in a fresh session; a second
              // overflow fails the turn as `context-overflow`, never a hiccup.
              if (explained && isContextOverflowTurn(explained)) {
                await flushToolCalls(result.toolCalls, '');
                console.warn(
                  `[thin-core] corner ${cornerId} turn ${requestId}: ` +
                    `${explained.reason}; retrying once in a fresh session`,
                );
                trace.retry({ reason: 'context overflow' });
                await ctx.discardSession();
                await trace.measure('activation', () => ctx.activate(trace));
                result = await runPrompt();
                trace.promptSettled();
                if (await completeTerminal(result)) return;
                explained = await ctx.explainEmpty(result);
              }
              // One bounded second chance to deliver repository work. Check
              // turns get the narrower checks reminder instead: repeating the
              // broad delivery instruction there could invite unrelated branch
              // cleanup. The model remains the authority over whether dirty
              // work belongs to the objective and whether to retain or dispose
              // of it; the daemon never rewrites the worktree after a turn.
              const checksTurn = isCornerChecksTurn(trigger, restates);
              const mayPublish = repositoryWork && !repositoryHeld;
              const deliveryState =
                !activityTurn && !checksTurn && mayPublish && ctx.options.repository
                  ? await cornerUndeliveredRepositoryState(
                      ctx.options.worktreePath,
                      ctx.options.repository.featureBranch,
                      ctx.options.repository.targetBranch,
                    )
                  : undefined;
              // A reviewer session never gets the dirty-work delivery nudge,
              // even when it also wrote the code: its main prompt already
              // carries the delivery rules.
              const needsDeliveryNudge =
                !ctx.reviewerInstructionInput &&
                deliveryState !== undefined &&
                deliveryState !== ctx.lastDeliveryNudgeState;
              let refreshedReviewerInstruction: string | undefined;
              let reviewerSecondPass = false;
              let reviewerTargetChanged = false;
              if (!explained && reviewTurn) {
                await ctx.syncBranch();
                refreshedReviewerInstruction = await ctx.activeReviewerInstruction(false);
                reviewerTargetChanged = refreshedReviewerInstruction !== activeReviewerInstruction;
                reviewerSecondPass =
                  reviewerTargetChanged ||
                  !result.toolCalls.some(
                    (call) =>
                      /(?:^|[._:/-])approve_merge$/i.test(call.title ?? '') &&
                      isCompletedToolCall(call),
                  );
              }
              let replyBeforeNudge = '';
              if (
                !explained &&
                (needsDeliveryNudge ||
                  (checksTurn &&
                    (reviewTurn
                      ? reviewerSecondPass
                      : repositoryWork && !repositoryHeld &&
                        !result.toolCalls.some(
                          (call) =>
                            isPrChecksRead(call) &&
                            isCompletedToolCall(call),
                        ))))
              ) {
                if (needsDeliveryNudge) ctx.lastDeliveryNudgeState = deliveryState;
                // The flush comes first: it is what puts this run's narration
                // in the ledger, so the offset it leaves behind is the one
                // this half of the reply has to be measured against. The next
                // prompt's `beginRun` then clears it for a fresh stream.
                await flushToolCalls(result.toolCalls, '');
                replyBeforeNudge = durableReplyText(stream.remainderOf(result.agentText));
                // Even a focused follow-up needs the current assignment;
                // runPrompt refreshes it before adding this instruction.
                result = await runPrompt(
                  reviewTurn
                    ? (refreshedReviewerInstruction ?? CORNER_REVIEWER_SESSION_INSTRUCTION)
                    : checksTurn
                      ? CORNER_CHECKS_NUDGE
                      : CORNER_DELIVERY_NUDGE,
                );
                trace.promptSettled();
                if (await completeTerminal(result)) return;
                explained = await ctx.explainEmpty(result);
              }
              // The requester stopped this turn while it ran. What the model
              // had already written STAYS, as in a Room (`monolith-room-turn`
              // says why), and the tool narration settles with it — the work
              // reached the branch and the ledger must not lie about it. The
              // partial reply carries no mentions.
              if (ctx.stoppedTurns.has(requestId)) {
                stream.close();
                throw new TurnStoppedError('turn stopped by the requester');
              }
              let answer = durableReplyText(result.agentText);
              // Recovered text comes from the harness's own session record,
              // not from this stream, so no offset measured here describes it.
              let fromStream = Boolean(answer);
              if (!answer && explained?.recoveredText) {
                answer = durableReplyText(explained.recoveredText);
                fromStream = false;
              }
              const withNudgeReply = (text: string): string => {
                if (reviewerSecondPass)
                  return text || (reviewerTargetChanged ? '' : replyBeforeNudge);
                return [replyBeforeNudge, text].filter(Boolean).join('\n\n');
              };
              // The dedupe inside the flush compares a pending narration with
              // the answer as it stands BEFORE any cut: that comparison is how
              // a narration duplicating the whole answer gets dropped instead
              // of saved, which is also what keeps the offset off it.
              await flushToolCalls(result.toolCalls, withNudgeReply(answer), true);
              // Past the flush the persisted offset is final for this turn, so
              // the answer can give up whatever head the ledger now carries.
              if (fromStream) answer = durableReplyText(stream.remainderOf(result.agentText));
              const reply = withNudgeReply(answer);
              // A refusal the operator cannot read is a refusal that happens twice.
              for (const call of result.toolCalls) {
                const failure = toolCallFailureLine(call);
                if (failure) console.warn(`[thin-core] corner ${cornerId} ${failure}`);
              }
              // Close the draft lane before the answer is published: the finished
              // reply must never queue behind a draft nobody will read.
              stream.close();
              if (!reply && explained) {
                // A checks turn is told to say nothing when nothing changed; only a
                // provider refusal makes that silence a failure.
                if (!reply && !(restates && !isAccountOrProviderRefusal(explained.record))) {
                  throw new Error(
                    turnFailureReasonWithProvider(explained.reason, ctx.servingProviders()),
                  );
                }
                console.warn(
                  `[thin-core] corner ${cornerId} turn ${requestId}: ${explained.reason}`,
                );
              }
              // The reply is the remainder past this turn's persisted offset:
              // everything the ledger did not already save, cut only where the
              // saved snapshot provably reaches into the closing run, so a
              // corner that narrated before a tool call still lands that
              // closing message entire. A reply that only restates the
              // server's own check notes says nothing new, and that turn
              // settles through its receipt instead.
              const durableReply = spoken(reply);
              // A timed-out attempt can have saved its narration before the
              // command is retried under the same request id. Its fresh stream
              // has no offset for that earlier ledger row.
              const repeatedNarration = Boolean(
                durableReply &&
                conversation.savedNarration?.some(
                  (saved) => spoken(durableReplyText(saved)) === durableReply,
                ),
              );
              await trace.measure('publish', () =>
                stream.settle(
                  repeatedNarration ? '' : durableReply,
                  durableReply && !repeatedNarration
                    ? {
                        ...(requestedById ? { triggerMessageId: requestId } : {}),
                      }
                    : {},
                ),
              );
            },
          ));
        },
        (error) => console.error(`[thin-core] corner ${cornerId} receipt heartbeat failed:`, error),
        () => {
          console.warn(
            `[thin-core] corner ${cornerId} turn ${requestId} dropped: ` +
              'the server revoked its output authority',
          );
          ctx.stopTurn(requestId);
        },
      );
      startTraceStats();
      await api.execute('postAgentTurnReceipt', {
        agentId: ctx.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: timeLimited ? 'failed' : 'complete',
        ...(!timeLimited ? {diagnosticsOnly:true} : {}),
        ...(timeLimited ? { reason: 'free-agent-time-limit' } : {}),
        generationId: ctx.commandContext.generationId,
        toolCalls: trace.toolCallsTotal,
        trace: trace.replay(),
        ...ctx.turnMetrics,
      });
      if (freeAgent && !timeLimited) await ctx.freeContinuation.clear();
      ctx.warmTranscript.complete(ctx.sessionId, [requestId]);
      // After the receipt: an operator artifact never delays the answer, and
      // never becomes one — the trace has no way to post a Room row.
      void finishTrace(timeLimited ? 'failed' : 'complete', timeLimited ? 'free-agent-time-limit' : undefined).catch(() => undefined);
    } catch (error) {
      // A stopped turn already has its ending: the server wrote `cancelled` and
      // named who stopped it when it accepted the request. Nothing to post, and
      // nothing the helper is to blame for.
      if (error instanceof TurnStoppedError || ctx.stoppedTurns.has(requestId)) {
        console.log(`[thin-core] corner ${cornerId} turn ${requestId} stopped by the requester`);
        void finishTrace('cancelled').catch(() => undefined);
        return;
      }
      if (isAgentProcessExit(error)) {
        await ctx.discardSession(true);
        await api.execute('postAgentTurnReceipt', {
          agentId: ctx.agent.publicKey, roomId: cornerId, requestId,
          status: 'failed', generationId: ctx.commandContext.generationId,
          reason: 'agent process exited', reasonKind: 'process-exited',
          trace: trace.replay(),
        }).catch(receiptError => console.error('[body] process interruption receipt failed:', receiptError));
        void finishTrace('failed', 'agent process exited').catch(() => undefined);
        throw error;
      }
      if (error instanceof OwnedModelOutcomeUnknown) {
        await ctx.discardSession(false, true);
        await api.execute('postAgentTurnReceipt', ownedModelEndReceipt(error, { agentId: ctx.agent.publicKey,
          roomId: cornerId, requestId, generationId: ctx.commandContext.generationId }));
        throw error;
      }
      const reason = distillTurnFailureReason(error);
      startTraceStats();
      await api.execute('postAgentTurnReceipt', {
        agentId: ctx.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: 'failed',
        generationId: ctx.commandContext.generationId,
        reason: reason.text,
        ...(reason.kind ? { reasonKind: reason.kind } : {}),
        toolCalls: trace.toolCallsTotal,
        trace: trace.replay(),
        ...ctx.turnMetrics,
      });
      void finishTrace('failed', reason.text).catch(() => undefined);
      throw error;
    } finally {
      ctx.busy = false;
      ctx.currentTurn = undefined;
      ctx.harvestWarmNodeModules();
    }
  }
