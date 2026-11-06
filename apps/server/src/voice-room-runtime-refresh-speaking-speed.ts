import { type FluxEvent, VoiceQuotaError } from "./voice-providers.js";
import { captureServerError } from "./sentry.js";
import { type VoiceSignal, VOICE_DATA_TOPIC, type VoiceBudget } from "@beeline/api-contract/phone";
import { VOICE_WARNING_MS } from "./voice-budget.js";
import type { LiveEvent } from "./live.js";
import { VoiceRoomRuntime, confirmedVoiceSpeech, voicePlaybackEcho, DeliveredVoicePlaybackError } from './voice-room-runtime.js';




  export async function voiceRoomRuntimeRefreshSpeakingSpeed(ctx: VoiceRoomRuntime, human: string) {
    if (!ctx.inputs.has(human)) return;
    const version = ctx.inputVersions.get(human);
    const refresh = Symbol();
    ctx.speedRefreshes.set(human, refresh);
    ctx.speakingSpeeds.delete(human);
    try {
      const row = (await ctx.service.db.query<{ speaking_speed: number }>(
        `SELECT speaking_speed FROM identities WHERE id=$1`, [human])).rows[0];
      if (ctx.inputs.has(human) && ctx.inputVersions.get(human) === version && ctx.speedRefreshes.get(human) === refresh) ctx.speakingSpeeds.set(human, row?.speaking_speed ?? 1.15);
    } catch { /* Optional preference reads never block a call. */ }
  }


  export function voiceRoomRuntimeObserveCallerResume(ctx: VoiceRoomRuntime, human: string, event: FluxEvent) {
    const reply = ctx.voicedReply;
    if (!reply || ctx.speaking?.signal !== reply.signal || reply.human !== human || reply.resumedAt !== undefined ||
        event.event === 'EndOfTurn' || event.event === 'EagerEndOfTurn' || !confirmedVoiceSpeech(event)) return;
    const context = ctx.recentSpeech.filter(spoken => spoken.until > performance.now()).map(spoken => spoken.text).join(' ');
    if (voicePlaybackEcho(event.transcript, context)) return;
    reply.resumedAt = performance.now();
    console.info('[voice-playback-resume]', JSON.stringify({ callId: ctx.callId, traceId: reply.traceId,
      callerId: human, replyKind: reply.kind, event: event.event, turnIndex: event.turn_index, sinceFirstVoicedMs: reply.resumedAt - reply.firstAt }));
  }


  export function voiceRoomRuntimeFinishVoicedReply(ctx: VoiceRoomRuntime, signal: AbortSignal) {
    const reply = ctx.voicedReply;
    if (!reply || reply.signal !== signal) return;
    if (reply.resumedAt !== undefined) console.info('[voice-playback-stopped]', JSON.stringify({ callId: ctx.callId,
      traceId: reply.traceId, callerId: reply.human, replyKind: reply.kind, publicationTailMs: Math.max(0, reply.lastAt - reply.resumedAt),
      queueClearMs: reply.clearedAt === undefined ? null : reply.clearedAt - reply.resumedAt,
      cleanupMs: performance.now() - reply.resumedAt }));
    ctx.voicedReply = undefined;
  }


  export function voiceRoomRuntimeHumanQuiet(ctx: VoiceRoomRuntime, human: string) {
    ctx.humanSpeaking.delete(human);
    for (const resolve of ctx.quietWaiters) resolve();
    ctx.quietWaiters.clear();
  }


  export async function voiceRoomRuntimeWaitForQuiet(ctx: VoiceRoomRuntime) {
    while (!ctx.closed && (ctx.speaking || ctx.humanSpeaking.size)) {
      if (ctx.speaking) await ctx.speechIdle;
      else await new Promise<void>(resolve => ctx.quietWaiters.add(resolve));
    }
  }


  export async function voiceRoomRuntimeTask(ctx: VoiceRoomRuntime, work: () => Promise<unknown> | unknown, human?: string): Promise<void> {
    try { if (await ctx.eventLease()) await work(); }
    catch (error) { await ctx.failure(error, human); }
  }


  export async function voiceRoomRuntimeFailure(ctx: VoiceRoomRuntime, error: unknown, human?: string): Promise<void> {
    if (error instanceof Error && error.name === 'AbortError') return;
    captureServerError(error, { surface: 'voice', callId: ctx.callId });
    try {
      const cause = error instanceof DeliveredVoicePlaybackError ? error.cause : error;
      const message = cause instanceof VoiceQuotaError ? cause.message : 'Voice reply unavailable; please try again';
      await ctx.signal({ type: 'error', message: error instanceof DeliveredVoicePlaybackError
        ? `Request delivered; ${cause instanceof VoiceQuotaError ? message : 'voice reply unavailable'}` : message,
        ...(cause instanceof VoiceQuotaError ? { code: cause.code } : {}) }, human);
    } catch (reportError) { captureServerError(reportError, { surface: 'voice-error-signal' }); }
  }


  export async function voiceRoomRuntimeSafeSignal(ctx: VoiceRoomRuntime, signal: VoiceSignal, human?: string): Promise<void> {
    try { await ctx.signal(signal, human); }
    catch (error) { captureServerError(error, { surface: 'voice-signal' }); }
  }



  export async function voiceRoomRuntimeSignal(ctx: VoiceRoomRuntime, signal: VoiceSignal, human?: string) {
    // A visual countdown must not start heartbeat work or count as activity.
    if (!ctx.closed) await ctx.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(signal)),
      { reliable: true, topic: VOICE_DATA_TOPIC, ...(human ? { destination_identities: [human] } : {}) });
  }


  export function voiceRoomRuntimeStopInput(ctx: VoiceRoomRuntime, human: string) {
    ctx.cancelEager(human);
    ctx.resumedFinals.delete(human);
    ctx.inputVersions.set(human, (ctx.inputVersions.get(human) ?? 0) + 1);
    ctx.inputSpeech.delete(human);
    ctx.externalContacts.delete(human);
    ctx.awaitingAnswer.delete(human);
    ctx.speakingSpeeds.delete(human);
    ctx.speedRefreshes.delete(human);
    const input = ctx.inputs.get(human);
    if (!input) return;
    ctx.inputs.delete(human);
    input.releaseBuffered?.();
    ctx.humanQuiet(human);
    ctx.task(() => input.stt?.close(), human);
    ctx.task(() => input.reader.cancel(), human);
  }


  export async function voiceRoomRuntimeEnforceBudget(ctx: VoiceRoomRuntime, budget: VoiceBudget) {
    if (ctx.closed || ctx.budgetEnding) return;
    if (budget.remainingMs > VOICE_WARNING_MS) {
      if (ctx.budgetDisplay) { ctx.budgetDisplay = ''; await ctx.signal({ type: 'budget', budget }); }
      return;
    }
    if (budget.remainingMs > 0) {
      const unit = budget.remainingMs >= 60_000 ? 60_000 : 1000;
      const display = `${budget.resetAt}:${unit}:${Math.ceil(budget.remainingMs / unit)}`;
      if (ctx.budgetDisplay === display) return;
      await ctx.signal({ type: 'budget', budget });
      ctx.budgetDisplay = display;
      return;
    }
    ctx.budgetEnding = true;
    try {
      if ((await ctx.observe(() => ctx.service.budget.read(ctx.workspaceId))).remainingMs > 0) return;
      await ctx.service.endWorkspaceCalls(ctx.workspaceId);
    } finally { ctx.budgetEnding = false; }
  }



  export function voiceRoomRuntimeRenewLease(ctx: VoiceRoomRuntime): Promise<boolean> {
    if (ctx.closed || ctx.leaseParked) return Promise.resolve(false);
    if (ctx.leaseFlight) return ctx.leaseFlight;
    const requestedAt = performance.now();
    if (requestedAt < ctx.nextLeaseAt) return Promise.resolve(requestedAt < ctx.leaseValidUntil);
    ctx.nextLeaseAt = requestedAt + 5000;
    const admittedRecovery = ctx.leaseRecovery;
    let renewed = false; let failure: unknown;
    ctx.leaseFlight = (async () => {
      try {
        const kept = await ctx.observe(() => ctx.service.db.query(`UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '15 seconds'
          WHERE id=$1 AND runtime_owner=$2 AND ended_at IS NULL AND runtime_until>clock_timestamp()`, [ctx.callId, ctx.leaseOwner]));
        if (!kept.rowCount) { await ctx.close(); return false; }
        if (ctx.closed) return false;
        ctx.leaseValidUntil = requestedAt + 15_000;
            renewed = true; return true;
      } catch (error) {
        failure = error; ctx.leaseParked = true;
        if (performance.now() >= ctx.leaseValidUntil) await ctx.close();
        throw error;
      }
    })().finally(() => {
      ctx.leaseFlight = undefined;
      if (ctx.leaseParked && !ctx.closed && ctx.leaseRecovery > admittedRecovery) ctx.resumeLeaseEvidence();
      else ctx.settleLeaseRecovery(renewed, failure);
    });
    return ctx.leaseFlight;
  }


  export async function voiceRoomRuntimeRecover(ctx: VoiceRoomRuntime) {
    // One actual database recovery boundary; no health probe or failure timer.
    if (ctx.leaseParked || ctx.leaseFlight) {
      if (!await ctx.requestLeaseRecovery(true)) return;
    }
    await ctx.meter?.recover();
  }


  export function voiceRoomRuntimeRequestLeaseRecovery(ctx: VoiceRoomRuntime, background: boolean): Promise<boolean> {
    ctx.leaseRecovery++;
    ctx.leaseRecoveryBackground ||= background;
    if (!ctx.leaseParked && !ctx.leaseFlight) return Promise.resolve(performance.now() < ctx.leaseValidUntil);
    if (!ctx.leaseRecoveryWait) {
      let resolve!: (value: boolean) => void; let reject!: (error: unknown) => void;
      const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      ctx.leaseRecoveryWait = { promise, resolve, reject };
    }
    if (!ctx.leaseFlight) ctx.resumeLeaseEvidence();
    return ctx.leaseRecoveryWait.promise;
  }


  export function voiceRoomRuntimeSettleLeaseRecovery(ctx: VoiceRoomRuntime, renewed: boolean, error?: unknown) {
    const waiting = ctx.leaseRecoveryWait; ctx.leaseRecoveryWait = undefined;
    ctx.leaseRecoveryBackground = false;
    if (error) waiting?.reject(error); else waiting?.resolve(renewed);
  }


  export function voiceRoomRuntimeResumeLeaseEvidence(ctx: VoiceRoomRuntime) {
    if (ctx.closed || !ctx.leaseRecoveryWait || ctx.leaseFlight) return;
    ctx.leaseParked = false;
    ctx.nextLeaseAt = 0;
    void ctx.renewLease().catch(error => ctx.failure(error));
  }



  export async function voiceRoomRuntimeRevalidateAuthorityChange(ctx: VoiceRoomRuntime, event: Extract<LiveEvent, { type: 'invalidate' }>): Promise<void> {
    if (!await ctx.eventLease() || !ctx.workspaceId) return;
    if (event.workspaceId && event.workspaceId !== ctx.workspaceId) return;
    if (event.roomId && event.roomId !== ctx.roomId && event.roomId !== ctx.authorityRoomId) return;
    const human = event.readerId ?? event.targetAgentId ?? event.personId;
    if (human && !ctx.room.remoteParticipants.has(human) && !ctx.inputs.has(human) && !ctx.participantSessions.has(human)) return;
    if (!event.roomId && !event.workspaceId) {
      // Legacy incomplete evidence cannot select a Workspace. Park only this
      // known person's input, without querying or ending other calls. A real
      // correlated source/Resume must reauthorize before any later PCM.
      if (human) {
        ctx.authorityVersions.set(human, ++ctx.authorityRevision);
        ctx.authorityPaused.add(human); ctx.cancelResume(human); ctx.stopInput(human);
      }
      return;
    }
    await ctx.revalidateParticipants(human);
  }


  export async function voiceRoomRuntimeRevalidateParticipants(ctx: VoiceRoomRuntime, affectedHuman?: string) {
    for (const participant of ctx.room.remoteParticipants.values()) {
      if (affectedHuman && participant.identity !== affectedHuman) continue;
      if (ctx.closed) return;
      const version = ++ctx.authorityRevision; ctx.authorityVersions.set(participant.identity, version);
      try {
        await ctx.observe(() => ctx.service.access(ctx.roomId, participant.identity));
        if (!ctx.closed && ctx.authorityVersions.get(participant.identity) === version) ctx.authorityPaused.delete(participant.identity);
      }
      catch (error) {
        if (ctx.closed || ctx.authorityVersions.get(participant.identity) !== version) continue;
        if (error instanceof Error && error.message === 'voice call access denied') {
          ctx.authorityPaused.add(participant.identity); ctx.cancelResume(participant.identity); ctx.stopInput(participant.identity);
          await ctx.service.leave(ctx.callId, participant.identity, true,
            ctx.participantSessions.get(participant.identity), undefined, ctx.leaseOwner);
        } else await ctx.failure(error, participant.identity);
      }
    }
  }


  /** Startup and actual participant/card source changes own this snapshot.
   * Session IDs remain server-private and fence late device departures. */
  export function voiceRoomRuntimeReconcileParticipants(ctx: VoiceRoomRuntime): Promise<void> {
    if (ctx.closed) return Promise.resolve();
    ctx.participantsDirty = true;
    if (ctx.participantsRefresh) return ctx.participantsRefresh;
    let failed = false;
    ctx.participantsRefresh = (async () => {
      while (ctx.participantsDirty && !ctx.closed) {
        ctx.participantsDirty = false;
        try {
          const current = await ctx.observe(() => ctx.service.db.query<{ identity_id: string; session_id: string }>(
            `SELECT identity_id,session_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL LIMIT 513`, [ctx.callId]));
          if (ctx.closed) return;
          if (current.rows.length > 512) { await ctx.close(); throw new Error('Voice participant bound exceeded'); }
          const sessions = new Map(current.rows.map(row => [row.identity_id, row.session_id]));
          for (const human of ctx.participantSessions.keys()) if (!sessions.has(human)) ctx.participantLeft(human);
          for (const [human, intent] of ctx.resumeIntents) if (sessions.get(human) !== intent.session) ctx.cancelResume(human);
          ctx.participantSessions.clear();
          for (const [human, session] of sessions) {
            ctx.participantSessions.set(human, session);
          }
        } catch (error) {
          failed = true; ctx.participantsDirty = false; throw error;
        }
      }
    })().finally(() => {
      ctx.participantsRefresh = undefined;
      if (!failed && ctx.participantsDirty && !ctx.closed) ctx.task(() => ctx.reconcileParticipants());
    });
    return ctx.participantsRefresh;
  }
