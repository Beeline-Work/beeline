import { OwnedModelOutcomeUnknown, ownedModelPrompt, ownedModelEndReceipt } from './owned-model-turn.js';
import { addTurnTokenFigure } from './harness-turn-tokens.js';
import { TurnUsageAccumulator } from './turn-usage.js';
import { hostname } from 'node:os';

import { AcpClient, agentTurnSteps, type PromptResult } from './acp.js';
import { freshHarnessLoginLine, isExpiredHarnessLoginError, repairRoomAgentCredentialLinks } from './agent-home.js';
import { attachmentImageBlocks, promptWithImages } from './attachment-delivery.js';
import { awaitInstitutionalContext, startInstitutionalContextFetch } from './institutional-context.js';
import { isContextOverflowTurn, shouldFailOverProviderError, shouldRetryEmptyTurn, turnFailureReasonWithProvider } from './empty-turn.js';
import { assembleTurnPrompt, roomMentionDirectory, renderReplyContext } from './prompt-assembly.js';
import { TurnStoppedError } from './turn-stop.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { roomReplySteps } from './room-turn-steps.js';
import { toolCallFailureLine } from './tool-call-failure.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';
import { isAgentProcessExit } from './agent-process.js';
import { MonolithRoomTurnLoop, ActiveTurn, inboxItemPromptBody, transcriptMessagePrompt, resumePrompt, inboxItemAuthorName, roomMessagePrompt, approvedDeviceGrant, deviceGrantResumePrompt, openCornerToolCall, openedACorner, pendingCardKind } from './monolith-room-turn.js';



  export async function monolithRoomTurnLoopPrompt(ctx: MonolithRoomTurnLoop, active: ActiveTurn): Promise<void> {
    const { item } = active;
    const api = ctx.options.api;
    // Admission is busy before the first awaited receipt write. The updater
    // cannot observe an accepted/queued turn as idle in this window.
    ctx.busy = true;
    // A turn starts with no measured cost. Without this reset a turn that throws
    // before its own prompt settles — the context fetch, `buildPrompt`, a
    // rejected delivery — would report the PREVIOUS turn's token count and
    // prompt size on its failure receipt, and the budget gate would read a
    // number belonging to somebody else's prompt.
    ctx.turnMetrics = {};
    ctx.turnUsage = new TurnUsageAccumulator();
    ctx.harnessTokens = undefined;
    const trace = ctx.beginTurnTrace(item.id);
    let timeLimited = false;
    const freeAgent = Boolean(ctx.options.config.agentEnv?.BEELINE_FREE_AGENT_ID ||
      ctx.options.config.agentEnv?.BEELINE_FREE_AGENT_MODEL_TOKEN);
    const traceGenerationId = ctx.commandContext.generationId;
    // Kicked off now, alongside activation rather than after it, so its own
    // network round trip has somewhere to hide (see institutional-context.ts).
    const institutionalContextFetch = startInstitutionalContextFetch(api, ctx.options.roomId);
    // Best-effort read of this turn's search_memory call/miss counters before
    // the trace writes — bounded so a slow or unreachable server never delays
    // the turn's own completion over a diagnostic.
    let statsPromise: Promise<{ searchCalls: number; searchMisses: number } | undefined> | undefined;
    const startTraceStats = (): void => {
      if (statsPromise) return;
      statsPromise = api.execute('getInstitutionalMemoryTurnStats', {
        roomId: ctx.options.roomId,
        agentId: ctx.agent.publicKey,
        requestId: item.id,
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
          agentId: ctx.agent.publicKey, roomId: ctx.options.roomId, requestId: item.id,
          generationId: traceGenerationId, status: 'cancelled', trace: trace.replay(),
        }).catch(() => console.warn('[turn-trace] trace dropped'));
      }
      await trace.finish(outcome, reason);
    };
    // The draft lane, held where the catch below can reach it: a turn that
    // throws never reaches its settle, and only this reference can dissolve
    // what the model had already written.
    let liveStream: AgentTurnStream | undefined;
    try {
      if (freeAgent) await ctx.freeContinuation.begin(inboxItemPromptBody(item));
      // The first row of the turn names who asked; learn the name once per session.
      if (!ctx.memberNames.has(item.authorId)) await ctx.roster().catch(() => undefined);
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: ctx.agent.publicKey,
          roomId: ctx.options.roomId,
          requestId: item.id,
          generationId: ctx.commandContext.generationId,
        },
        async () => {
          await api.execute('postAgentActivity', {
            agentId: ctx.agent.publicKey,
            roomId: ctx.options.roomId,
            requestId: item.id,
            activity: [
              {
                kind: 'thinking',
                title: 'Working',
                status: 'in_progress',
                requestedBy: ctx.requesterOf(item.authorId),
              },
            ],
          });
          trace.noteScheduler('queue', ctx.options.scheduler.snapshot());
          trace.start('queue-wait');
          ctx.turnCheckout = undefined;
          await ctx.options.scheduler.run(
            ctx.options.roomId,
            ctx.lifecycle(trace),
            async () => {
              // Belt and braces: `activate`/`isCurrent` already closed the
              // queue wait, and `end` on a closed phase is a no-op.
              trace.end('queue-wait');
              trace.noteScheduler('admission', ctx.options.scheduler.snapshot());
              if (ctx.options.refreshCheckout && !ctx.turnCheckout) {
                throw new Error('Room checkout refresh failed before this turn');
              }
              const checkout = ctx.turnCheckout;
              const [conversation, roster, delivered, corners, institutionalContext, onboarding] =
                await trace.measure('context-fetch', () =>
                  Promise.all([
                    api.execute('getRoomConversation', { roomId: ctx.options.roomId, limit: 200 }),
                    ctx.roster(),
                    ctx.deliver(item),
                    api.execute('listRoomCorners', { roomId: ctx.options.roomId }),
                    awaitInstitutionalContext(institutionalContextFetch, (message) =>
                      console.warn(`[thin-core] Room ${ctx.options.roomId}: ${message}`),
                    ),
                    ctx.repositoryState().then(state => state.repositoryOnboarding === true, () => false),
                  ]),
                );
              trace.noteInstitutionalMemory(institutionalContext.outcome);
              if (institutionalContext.embeddingOutcome !== undefined) {
                trace.noteInstitutionalMemoryEmbedding(
                  institutionalContext.embeddingOutcome,
                  institutionalContext.embeddingMs ?? 0,
                );
              }
              const names = new Map(
                roster.members.map((member) => [member.identityId, member.name]),
              );
              const transcriptRows = conversation.items
                .filter(
                  (message) =>
                    (message.type === 'message' || message.systemEvent?.kind === 'computer-session-activity') &&
                    message.id !== item.id &&
                    !active.steers.some((steerItem) => steerItem.id === message.id),
                )
                .slice(-80)
                .map((message) => ({
                  id: message.id,
                  authorId: message.authorId,
                  line: transcriptMessagePrompt(
                    names.get(message.authorId) ?? message.authorId.slice(0, 12),
                    message.body,
                    message.attachments,
                    message.id,
                    renderReplyContext(message),
                  ),
                }));
              const command = ctx.commandContext.current;
              const grantDecision = command?.action === 'resume';
              const decisionKind = command?.source.systemEvent?.kind;
              const decisionResume = grantDecision &&
                command.turnRequestId === ctx.pausedOnGrantRequestId &&
                ((decisionKind === 'grant-decided' && ctx.pausedOnGrantKind === 'grant') ||
                  (decisionKind === 'connector-offer-decided' && ctx.pausedOnGrantKind === 'connector'));
              const resumedRequestId = decisionResume ? ctx.pausedOnGrantRequestId : undefined;
              if (decisionResume) {
                ctx.pausedOnGrantRequestId = undefined;
                ctx.pausedOnGrantKind = undefined;
              }
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // conversation, so it has to render the whole window again.
              const openCorners = (corners.corners ?? []).filter((corner) => !corner.archived);
              const closedSince = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
              const closedCorners = (corners.corners ?? [])
                .filter(
                  (corner) =>
                    corner.archived &&
                    corner.closedAt !== undefined &&
                    corner.closedAt >= closedSince,
                )
                .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
              let deviceResume: string | undefined;
              await ctx.client?.preparePromptDelivery(ctx.sessionId);
              const buildPrompt = (): string => {
                const transcript = ctx.warmTranscript.select(
                  ctx.sessionId,
                  transcriptRows,
                  ctx.agent.publicKey,
                );
                const assembled = assembleTurnPrompt({
                  delivery: ctx.client?.promptDelivery(ctx.sessionId),
                  surface: ctx.sessionSurface,
                  modelContextTokens: ctx.modelContextTokens,
                  ...(freeAgent ? { timeLimitCheckpoint: ctx.freeContinuation.context } : {}),
                  sessionPrefix: ctx.turnInstructionPrefix,
                  ...(checkout?.branch && checkout.commit
                    ? { checkout: { branch: checkout.branch, commit: checkout.commit } }
                    : {}),
                  transcript: {
                    lines: transcript.rows.map((row) => row.line),
                    sinceLastTurn: transcript.warm,
                  },
                  ...(deviceResume
                    ? { resume: deviceResume }
                    : grantDecision
                      ? { resume: resumePrompt(item) }
                      : {}),
                  members: roomMentionDirectory(roster, ctx.agent.publicKey),
                  memory: institutionalContext.text,
                  corners: openCorners,
                  closedCorners,
                  onboarding,
                  ...(['human_tag', 'direct_message', 'agent_tag'].includes(ctx.commandContext.current?.reason ?? '') ? {
                    routing: { roomId: ctx.options.roomId, messageId: ctx.commandContext.current!.sourceMessageId,
                      memberId: ctx.agent.publicKey, fromName: inboxItemAuthorName(item, names) },
                  } : {}),
                  task: {
                    fromName: inboxItemAuthorName(item, names),
                    commandReason: ctx.commandContext.current?.reason,
                    reply: item,
                    outsideEvent: ctx.commandContext.current?.source.systemEvent,
                    body: roomMessagePrompt(
                      '',
                      inboxItemPromptBody(item),
                      item.attachments,
                      delivered,
                      ctx.acceptsImages(),
                      ['message', 'private'].includes(item.type) ? item.id : undefined,
                    ),
                  },
                });
                trace.notePromptSections(
                  assembled.report,
                  ctx.sectionBaseline.observe(ctx.sessionId, assembled.report),
                );
                trace.notePromptWindow(assembled.text, ctx.modelContextTokens);
                ctx.commandContext.notePromptSections([
                  ...ctx.sessionPromptSectionIds,
                  ...assembled.report.map((section) => section.id),
                ]);
                return assembled.text;
              };
              // Rooms and corners stream through ONE presentation (C100): the
              // provisional draft lane, the request-id handoff, and the single
              // durable reply that dissolves it all live in `turn-stream.ts`.
              const stream = new AgentTurnStream({
                api,
                commandId:ctx.commandContext.current?.id,
                turnGeneration:ctx.commandContext.generationId,
                agentId: ctx.agent.publicKey,
                roomId: ctx.options.roomId,
                requestId: item.id,
                label: `monolith Room ${ctx.options.roomId}`,
              });
              liveStream = stream;
              // One prompt run, steers and all. It is a closure because an empty
              // completion re-pins the session to another provider and runs it
              // again (C92) — against the NEW client and session id.
              let loginRetryUsed = false;
              const runPrompt = async (): Promise<PromptResult> => {
                let nextPrompt = promptWithImages(
                  buildPrompt(),
                  attachmentImageBlocks(delivered, ctx.acceptsImages()),
                );
                let result: Awaited<ReturnType<AcpClient['sessionPrompt']>> | undefined;
                for (;;) {
                  let promptError: unknown;
                  try {
                    stream.beginRun();
                    trace.promptSent();
                    result = await ctx.turnUsage.measure(
                      { agentEnv: ctx.agentEnv, sessionId: ctx.sessionId! },
                      () => ownedModelPrompt(ctx.commandContext, () =>
                        ctx.client!.sessionPrompt(
                          ctx.sessionId!,
                          nextPrompt,
                          (delta, full, currentRun) => {
                            trace.firstModelOutput();
                            stream.onChunk(delta, full, currentRun);
                          },
                          undefined,
                          (calls) => {
                            trace.toolCalls(calls);
                          },
                        )),
                    );
                    ctx.harnessTokens = addTurnTokenFigure(ctx.harnessTokens, result?.tokenUsage);
                  } catch (error) {
                    promptError = error;
                  }
                  if (promptError instanceof OwnedModelOutcomeUnknown || isAgentProcessExit(promptError)) throw promptError;
                  ctx.turnMetrics = await ctx.captureTurnMetrics();
                  await ctx.writeBackClaudeLogin();
                  if (result && ['no-reply', 'repeated-tool-call'].includes(result.stopReason)) break;
                  const settledSteerTail = active.steerTail;
                  await settledSteerTail;
                  if (settledSteerTail !== active.steerTail) continue;
                  if (promptError && isExpiredHarnessLoginError(promptError)) {
                    if (!loginRetryUsed) {
                      loginRetryUsed = true;
                      console.warn(
                        `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id}: ` +
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
                      continue;
                    }
                    return {
                      stopReason: 'login-required',
                      updates: [],
                      agentText: freshHarnessLoginLine(ctx.options.config.agentKind, hostname()),
                      toolCalls: [],
                    };
                  }
                  if (!active.resumeRequested) {
                    if (promptError) throw promptError;
                    break;
                  }
                  active.resumeRequested = false;
                  nextPrompt = [
                    'The previous run was cancelled because its harness could not accept every live steer.',
                    'Resume the same turn. Keep the original request and everything that happened before it was cancelled.',
                    'Human messages that arrived after the original request, in transcript order:',
                    ...active.steers.map((steerItem) =>
                      roomMessagePrompt(
                        steerItem.authorId.slice(0, 12),
                        steerItem.body,
                        steerItem.attachments,
                        ctx.deliveredAttachments.get(steerItem.id),
                        ctx.acceptsImages(),
                        steerItem.type === 'message' ? steerItem.id : undefined,
                        renderReplyContext(steerItem),
                      ),
                    ),
                    'Continue now and answer the updated request without erasing the earlier context.',
                  ].join('\n\n');
                }
                return result!;
              };
              let result = await runPrompt();
              trace.promptSettled();
              if (['order', 'corner_objective'].includes(ctx.commandContext.current?.reason ?? '') &&
                ['repeated-tool-call', 'login-required'].includes(result.stopReason)) {
                stream.close();
                await ctx.discardSession();
                const tool = result.toolCalls.at(-1)?.title;
                throw new Error(`unreported_order: ${result.stopReason}${tool ? ` (${tool})` : ''}; requested work is unconfirmed`);
              }
              if (result.stopReason === 'free-agent-time-limit') {
                stream.close();
                timeLimited = true;
                let reply: string;
                try { reply = await ctx.freeContinuation.stopped(result); }
                finally { await ctx.discardSession(); }
                if (['order', 'corner_objective'].includes(ctx.commandContext.current?.reason ?? '')) {
                  await stream.retract();
                  throw new Error('unreported_order: free-agent-time-limit; requested work is unfinished');
                }
                await stream.settle(reply, { triggerMessageId: item.id });
                return;
              }
              if (['no-reply', 'repeated-tool-call'].includes(result.stopReason)) {
                stream.close();
                await stream.retract();
                await ctx.discardSession();
                return;
              }
              // An instantly approved device grant cannot reach the running
              // sandbox: replace the session and continue this same turn there.
              const grantedDevice = approvedDeviceGrant(result.toolCalls);
              if (grantedDevice) {
                trace.retry({ reason: 'device grant' });
                if (!(await ctx.sessionIsCurrent())) {
                  await ctx.discardSession();
                  await trace.measure('activation', () => ctx.activate(trace));
                }
                deviceResume = deviceGrantResumePrompt(grantedDevice, result.agentText);
                result = await runPrompt();
                trace.promptSettled();
              }
              let openCornerCall = openCornerToolCall(result.toolCalls);
              let cornerOpened = openedACorner(openCornerCall);
              let explained = await ctx.explainEmpty(result);
              // A stopped turn ends `aborted` with no text; that is the
              // requester's answer, not a routing failure, and must not re-pin
              // the session. A provider's 429/5xx moves the pin onward.
              if (
                !cornerOpened &&
                !active.cancelled &&
                explained &&
                (shouldRetryEmptyTurn(explained) || shouldFailOverProviderError(explained))
              ) {
                const silent = ctx.servingProviders();
                const next = await ctx.repinNextProvider(trace, explained.reason);
                if (next) {
                  console.warn(
                    `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id}: ` +
                      `${turnFailureReasonWithProvider(explained.reason, silent)}; retrying on ${next}`,
                  );
                  result = await runPrompt();
                  trace.promptSettled();
                  openCornerCall = openCornerToolCall(result.toolCalls);
                  cornerOpened = openedACorner(openCornerCall);
                  explained = await ctx.explainEmpty(result);
                }
              }
              // A session whose history outgrew the model's window refuses
              // every retry inside it. One retry in a fresh session; a second
              // overflow fails the turn as `context-overflow`, never a hiccup.
              if (!cornerOpened && explained && isContextOverflowTurn(explained)) {
                console.warn(
                  `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id}: ` +
                    `${explained.reason}; retrying once in a fresh session`,
                );
                trace.retry({ reason: 'context overflow' });
                await ctx.discardSession();
                await trace.measure('activation', () => ctx.activate(trace));
                result = await runPrompt();
                trace.promptSettled();
                openCornerCall = openCornerToolCall(result.toolCalls);
                cornerOpened = openedACorner(openCornerCall);
                explained = await ctx.explainEmpty(result);
              }
              if (['order', 'corner_objective'].includes(ctx.commandContext.current?.reason ?? '') && result.stopReason === 'repeated-tool-call') {
                stream.close();
                await ctx.discardSession();
                throw new Error('unreported_order: repeated-tool-call; requested work is unconfirmed');
              }
              if (['no-reply', 'repeated-tool-call'].includes(result.stopReason)) {
                stream.close();
                await stream.retract();
                await ctx.discardSession();
                return;
              }
              // The requester stopped this turn while it ran. A stopped turn
              // publishes nothing at all — no durable reply, no receipt, and no
              // late write of any kind: the server settled the turn `cancelled`
              // and wrote the attributed line before this helper even heard,
              // and that line is the Room's whole record of the stop.
              if (active.cancelled) {
                stream.close();
                throw new TurnStoppedError('turn stopped by the requester');
              }
              active.phase = 'finishing';
              const pendingCard = result.toolCalls.map((call) => pendingCardKind(call)).find(Boolean);
              if (pendingCard) {
                ctx.pausedOnGrantRequestId = item.id;
                ctx.pausedOnGrantKind = pendingCard;
                console.log(
                  `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id} paused on a grant card`,
                );
              } else if (resumedRequestId) {
                console.log(
                  `[thin-core] monolith Room ${ctx.options.roomId} turn ${resumedRequestId} resumed by card decision ${item.id}`,
                );
              }
              if (openCornerCall) {
                console.log(
                  `[thin-core] monolith Room ${ctx.options.roomId} tool call: ${openCornerCall.title ?? ''} (${openCornerCall.status ?? 'no status'})`,
                );
                if (cornerOpened) ctx.options.onCornerOpened?.();
              }
              // A refusal the operator cannot read is a refusal that happens twice.
              for (const call of result?.toolCalls ?? []) {
                const failure = toolCallFailureLine(call);
                if (failure) {
                  console.warn(`[thin-core] monolith Room ${ctx.options.roomId} ${failure}`);
                }
              }
              // Close the draft lane before the answer is published: the finished
              // reply must never queue behind a draft nobody will read.
              stream.close();
              // The reply is the turn's last text run. Every earlier run rides
              // on it as a note between the tool steps, so text written
              // before a tool call is kept without leading the answer.
              // Synthetic recovery replies stand alone, and an empty final
              // result must not promote an abandoned draft into an answer.
              let reply = durableReplyText(result.agentText);
              const steps = reply
                ? roomReplySteps(agentTurnSteps(result.updates ?? []), ctx.requesterOf(item.authorId))
                : [];
              if (!reply && explained?.recoveredText) {
                // Text the harness recorded but never streamed. Kept on a
                // corner-open turn too: it is the same reply the live lane
                // would have shown, arriving only at settle. Sanitized first,
                // because a recovered string that is only harness preamble or
                // the scaffold echo leaves nothing to say.
                reply = durableReplyText(explained.recoveredText);
              }
              if (!reply && explained && !cornerOpened) {
                // A named reason (pi's provider refusal, an empty model answer,
                // the stream's shape) carrying the provider that served the
                // turn — never the bare "no reply" as the only fact. A corner
                // that already opened is the Room's completion even without
                // prose; do not fail that turn for emptiness.
                throw new Error(
                  turnFailureReasonWithProvider(explained.reason, ctx.servingProviders()),
                );
              }
              if (reply && explained) {
                console.warn(
                  `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id}: ${explained.reason}`,
                );
              }
              // The server's corner-open card and this reply are one
              // completion: live prefixes of the same text, then that text
              // written durably. An empty last run still settles through the
              // card alone. Silence waits for `completed`, never merely for
              // "not failed".
              await trace.measure('publish', () =>
                stream.settle(
                  reply,
                  reply
                    ? {
                        triggerMessageId: item.id,
                        ...(steps.length ? { steps } : {}),
                      }
                    : {},
                ),
              );
            },
          );
        },
        (error) =>
          console.error(
            `[thin-core] monolith Room ${ctx.options.roomId} receipt heartbeat failed:`,
            error,
          ),
        () => {
          console.warn(
            `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id} dropped: ` +
              'the server revoked its output authority',
          );
          ctx.stopTurn(item.id);
        },
      );
      await Promise.all(ctx.approvalDecisionWrites);
      const decisionFailure = ctx.approvalDecisionFailures.get(item.id);
      if (decisionFailure) throw new Error(`Squire approval decision was not published: ${distillTurnFailureReason(decisionFailure).text}`);
      startTraceStats();
      await api.execute('postAgentTurnReceipt', {
        agentId: ctx.agent.publicKey,
        roomId: ctx.options.roomId,
        requestId: item.id,
        status: timeLimited ? 'failed' : 'complete',
        ...(!timeLimited ? {diagnosticsOnly:true} : {}),
        ...(timeLimited ? { reason: 'free-agent-time-limit' } : {}),
        generationId: ctx.commandContext.generationId,
        toolCalls: trace.toolCallsTotal,
        trace: trace.replay(),
        ...ctx.turnMetrics,
      });
      if (freeAgent && !timeLimited) await ctx.freeContinuation.clear();
      ctx.warmTranscript.complete(ctx.sessionId, [item.id, ...active.steers.map((steer) => steer.id)]);
      // After the receipt: an operator artifact must never delay the answer,
      // and it never becomes one — the trace has no way to post a Room row.
      void finishTrace(timeLimited ? 'failed' : 'complete', timeLimited ? 'free-agent-time-limit' : undefined).catch(() => undefined);
    } catch (error) {
      // A stopped turn already has its ending — the server wrote `cancelled`
      // and named who stopped it the moment it accepted the request. There is
      // no receipt to post and nothing to blame the helper for, so the turn
      // ends here quietly and only the operator's trace records it. It is also
      // the one throw that retracts nothing: a stopped turn writes NOTHING
      // after its authority ended, and the server stops serving that turn's
      // draft the moment it settles the turn `cancelled` (`liveDraftSnapshot`
      // reads working turns only).
      if (error instanceof TurnStoppedError || active.cancelled) {
        console.log(
          `[thin-core] monolith Room ${ctx.options.roomId} turn ${item.id} stopped by the requester`,
        );
        void finishTrace('cancelled').catch(() => undefined);
        return;
      }
      if (isAgentProcessExit(error)) {
        liveStream?.close();
        await liveStream?.retract().catch(retractError => console.error('[body] interrupted draft retract failed:', retractError));
        await ctx.discardSession(true);
        await api.execute('postAgentTurnReceipt', {
          agentId: ctx.agent.publicKey, roomId: ctx.options.roomId, requestId: item.id,
          status: 'failed', generationId: ctx.commandContext.generationId,
          reason: 'agent process exited', reasonKind: 'process-exited',
          trace: trace.replay(),
        }).catch(receiptError => console.error('[body] process interruption receipt failed:', receiptError));
        void finishTrace('failed', 'agent process exited').catch(() => undefined);
        throw error;
      }
      if (error instanceof OwnedModelOutcomeUnknown) {
        liveStream?.close(); await ctx.discardSession();
        await api.execute('postAgentTurnReceipt', ownedModelEndReceipt(error, { agentId: ctx.agent.publicKey,
          roomId: ctx.options.roomId, requestId: item.id, generationId: ctx.commandContext.generationId }));
        throw error;
      }
      // A failed turn ends owning no live output. Only `settle` dissolves the
      // draft on the way out and a throw never reaches one, so without this the
      // last snapshot the model streamed stays live under a turn the Room has
      // already reported failed — still pulsing, still claiming to be an answer
      // on its way. The retract settles that row in place: the words the person
      // was reading stay, and stop pretending to be in progress. Its own
      // failure must never replace the error that actually ended the turn.
      await liveStream?.retract().catch((retractError: unknown) => {
        console.error(
          `[thin-core] monolith Room ${ctx.options.roomId} draft retract failed:`,
          retractError,
        );
      });
      const reason = timeLimited ? { text: 'free-agent-time-limit' } : distillTurnFailureReason(error);
      startTraceStats();
      await api.execute('postAgentTurnReceipt', {
        agentId: ctx.agent.publicKey,
        roomId: ctx.options.roomId,
        requestId: item.id,
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
      ctx.approvalDecisionFailures.delete(item.id);
      ctx.busy = false;
    }
  }
