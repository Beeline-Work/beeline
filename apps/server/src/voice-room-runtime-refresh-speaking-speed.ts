import { startConnectionWork } from './background-work.js';
import { captureServerError } from './sentry.js';
import { VoiceAudioMeter, VOICE_WARNING_MS } from './voice-budget.js';
import { AccessToken } from 'livekit-server-sdk';
import { RoomEvent, AudioStream, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';
import { VOICE_DATA_TOPIC, type VoiceSignal, type VoiceBudget } from '@beeline/api-contract/phone';
import type { LiveEvent } from './live.js';
import { VoiceQuotaError, type VoiceStt, type FluxEvent } from './voice-providers.js';
import { voiceNameOnly, voiceContactNameOnly } from './voice-request-assembler.js';
import { openingVoiceName } from './voice-target.js';
import { VoiceRoomRuntime, confirmedVoiceSpeech, voicePlaybackEcho, DeliveredVoicePlaybackError, speechWords, BACKCHANNEL, SINGLE_WORD_REPLIES, voiceInterrupt } from './voice-room-runtime.js';


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


  /** Terminal boundary for every RTC callback and detached call task. */
  export function voiceRoomRuntimeTask(ctx: VoiceRoomRuntime, work: () => Promise<unknown> | unknown, human?: string): Promise<void> {
    try { return Promise.resolve(work()).then(() => {}, error => ctx.failure(error, human)); }
    catch (error) { return ctx.failure(error, human); }
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

  /** One admitted attempt. A failed observation cannot create a retry clock;
   * the existing action/source/ownership boundary decides subsequent work. */
  export function voiceRoomRuntimeRetry<T>(ctx: VoiceRoomRuntime, work: () => Promise<T>): Promise<T> {
    ctx.shutdown.signal.throwIfAborted();
    return work();
  }

  export async function voiceRoomRuntimeStart(ctx: VoiceRoomRuntime) {
    const scope = await ctx.retry(() => ctx.service.runtimeScope(ctx.roomId));
    ctx.workspaceId = scope.workspaceId; ctx.authorityRoomId = scope.authorityRoomId;
    const budget = await ctx.retry(() => ctx.service.budget.read(ctx.workspaceId));
    ctx.meter = new VoiceAudioMeter(ctx.service.budget, ctx.callId, ctx.leaseOwner, ctx.workspaceId, budget,
      remaining => {
        ctx.task(() => remaining ? ctx.enforceBudget(remaining) : ctx.close());
      }, message => console.warn('[voice-budget]', message));
    const token = new AccessToken(ctx.service.config.apiKey, ctx.service.config.apiSecret,
      { identity: `beeline-voice-${ctx.callId}`, ttl: '1h', metadata: JSON.stringify({ kind: 'transport' }) });
    token.addGrant({ roomJoin: true, room: `beeline-voice-${ctx.callId}`, canPublish: true,
      canSubscribe: true, canPublishData: true });
    ctx.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO) ctx.task(() => ctx.listen(track, participant), participant.identity);
    });
    ctx.room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => ctx.task(() => {
      if (ctx.inputs.get(participant.identity)?.track === track) ctx.stopInput(participant.identity);
    }, participant.identity));
    ctx.room.on(RoomEvent.ParticipantDisconnected, participant => ctx.task(() => {
      if (ctx.closed) return;
      if (ctx.inputs.get(participant.identity)?.participant === participant) ctx.stopInput(participant.identity);
      // A newer device with the same Beeline identity can replace this RTC
      // participant. Do not let the old socket remove its successor.
      if (!ctx.room.remoteParticipants.has(participant.identity)) { ctx.cancelResume(participant.identity); ctx.armAbsent(participant.identity); }
    }, participant.identity));
    ctx.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (!participant || topic !== VOICE_DATA_TOPIC || bytes.length > 2048) return;
      ctx.task(async () => {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
        if (data.type !== 'target' && data.type !== 'unpin' && data.type !== 'resume' && data.type !== 'park') return;
        await ctx.retry(() => ctx.service.access(ctx.roomId, participant.identity));
        if (data.type === 'target' || data.type === 'unpin') ctx.cancelEager(participant.identity);
        if (data.type === 'unpin') {
          ctx.explicitTargets.delete(participant.identity);
          ctx.assembler.clearAddress(participant.identity);
          await ctx.refresh(); return;
        }
        if (data.type === 'target') {
          const allowed = await ctx.retry(() => ctx.service.agents(ctx.roomId, participant.identity));
          if (!allowed.some(a => a.id === data.agentId)) return;
          ctx.targets.set(participant.identity, data.agentId);
          if (data.tap) {
            ctx.assembler.address(participant.identity, data.agentId);
            ctx.awaitingAnswer.delete(participant.identity);
            ctx.explicitTargets.set(participant.identity, data.agentId);
          }
        }
        if (data.type === 'target') { await ctx.refresh(); return; }
        // HTTP may land on another server; the retained RTC channel reaches
        // the owner. Durable session/state checks fence queued old packets.
        if (typeof data.sessionId !== 'string' || !(await ctx.retry(() => ctx.service.db.query(`SELECT 1 FROM voice_participants
          WHERE call_id=$1 AND identity_id=$2 AND session_id=$3 AND left_at IS NULL
          AND (parked_at IS NOT NULL)=$4`, [ctx.callId, participant.identity, data.sessionId, data.type === 'park']))).rowCount) return;
        if (data.type === 'park') return;
        else await ctx.resume(participant.identity);
      }, participant.identity);
    });
    ctx.room.on(RoomEvent.ParticipantConnected, participant => {
      ctx.cancelAbsent(participant.identity);
      ctx.task(async () => { await ctx.reconcileParticipants(); await ctx.countHumans(true); });
    });
    ctx.room.on(RoomEvent.Disconnected, () => { if (!ctx.closed) ctx.task(() => ctx.close()); });
    await ctx.room.connect(ctx.service.config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    ctx.shutdown.signal.throwIfAborted();
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await ctx.room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('beeline-agent-speech', ctx.audio), options);
    ctx.shutdown.signal.throwIfAborted();
    ctx.armLeaseExpiry();
    ctx.armLeaseRenewal();
    await ctx.reconcileParticipants();
    await ctx.countHumans(true).catch(() => {});
    await ctx.refresh();
  }


  export async function voiceRoomRuntimeSignal(ctx: VoiceRoomRuntime, signal: VoiceSignal, human?: string) {
    // A visual countdown must not start heartbeat work or count as activity.
    if (!ctx.closed) await ctx.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(signal)),
      { reliable: true, topic: VOICE_DATA_TOPIC, ...(human ? { destination_identities: [human] } : {}) });
  }

  export async function voiceRoomRuntimeListen(ctx: VoiceRoomRuntime, track: RemoteTrack, participant: RemoteParticipant) {
    const human = participant.identity;
    if (ctx.inputs.get(human)?.track === track) return;
    ctx.stopInput(human);
    // A new device/track needs its current countdown even within the same unit.
    ctx.budgetDisplay = '';
    const version = (ctx.inputVersions.get(human) ?? 0) + 1;
    ctx.inputVersions.set(human, version);
    ctx.turnIndices.delete(human);
    // Start buffering RTC frames immediately: waiting for the STT handshake
    // otherwise clips the first spoken name after a phone publishes its mic.
    const reader = new AudioStream(track, 16_000, 1).getReader();
    const buffered: { data: Int16Array; at: number; release(): void }[] = [];
    const releaseBuffered = () => { for (const frame of buffered) frame.release(); buffered.length = 0; };
    ctx.inputs.set(human, { reader, track, participant, releaseBuffered, buffered });
    let stt: VoiceStt | undefined;
    const ownsInput = () => !ctx.closed && ctx.inputVersions.get(human) === version;
    const current = () => ownsInput() && !track.muted && !ctx.authorityPaused.has(human);
    const deliver = (admitted: Int16Array) => {
      if (!current() || performance.now() >= ctx.leaseValidUntil) return;
      try { stt!.send(admitted); } catch (error) { void ctx.failure(error, human); }
    };
    const send = (data: Int16Array, capturedAt: number) => {
      if (current()) ctx.meter?.capture(data, capturedAt, deliver);
    };
    // Authorization buffering shares the meter's call-wide byte/duration cap.
    const pump = (async () => {
      while (!ctx.closed && ctx.inputVersions.get(human) === version) {
        const frame = await reader.read();
        if (frame.done || !ownsInput()) break;
        if (stt) send(frame.value.data, Date.now());
        else {
          if (track.muted) continue;
          const release = ctx.meter?.retain(frame.value.data.length / 16, frame.value.data.byteLength);
          if (release) buffered.push({ data: frame.value.data.slice(), at: Date.now(), release });
        }
      }
    })();
    void pump.catch(error => { if (ownsInput()) return ctx.failure(error, human); });
    try {
      const authorityVersion = ++ctx.authorityRevision; ctx.authorityVersions.set(human, authorityVersion);
      await ctx.retry(() => ctx.service.access(ctx.roomId, human));
      if (!ownsInput()) { releaseBuffered(); return; }
      if (ctx.authorityVersions.get(human) === authorityVersion && ctx.inputVersions.get(human) === version)
        ctx.authorityPaused.delete(human);
      const member = await ctx.retry(() => ctx.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL`,
        [ctx.callId, human]));
      // A completed read belongs to its original track generation. In
      // particular an old denial cannot stop the replacement microphone.
      if (!ownsInput()) { releaseBuffered(); return; }
      if (!member.rowCount) { ctx.stopInput(human); return; }
      const [agents, budget, contacts] = await Promise.all([
        ctx.retry(() => ctx.service.agents(ctx.roomId, human)), ctx.retry(() => ctx.service.budget.read(ctx.workspaceId)),
        ctx.retry(() => ctx.service.db.query<{ name: string }>(
          `SELECT btrim(title) AS name FROM agent_subscriptions
           WHERE room_id=$1 AND source='webhook' AND btrim(title)<>''
           GROUP BY btrim(title) ORDER BY name LIMIT 80`, [ctx.roomId])),
        ctx.refreshSpeakingSpeed(human),
      ]);
      if (ctx.closed || ctx.inputVersions.get(human) !== version) { releaseBuffered(); return; }
      ctx.task(() => ctx.enforceBudget(budget));
      if (budget.remainingMs <= 0) { ctx.stopInput(human); return; }
      const externalContacts = contacts.rows.map(contact => contact.name.slice(0, 80));
      ctx.externalContacts.set(human, externalContacts);
      const hints = [...new Set([...agents.flatMap(agent => [agent.name, agent.handle]), ...externalContacts])].slice(0, 80);
      stt = await ctx.service.config.stt(event => {
      if (!ownsInput()) return;
      const receivedAt = performance.now();
      ctx.task(async () => {
      if (ctx.inputVersions.get(human) === version && event.turn_index >= (ctx.turnIndices.get(human) ?? -1))
        ctx.observeCallerResume(human, event);
      // A resumed final still belongs to the active conversational request.
      const resumesFinal = event.event === 'TurnResumed' && event.turn_index === ctx.turnIndices.get(human) &&
        (!!ctx.assembler.current(human) || (!!ctx.speaking && ctx.speakingHuman === human));
      if (ctx.inputVersions.get(human) !== version ||
          (event.turn_index <= (ctx.turnIndices.get(human) ?? -1) && !resumesFinal)) return;
      // Reopen the STT turn even when its resumed fragment is empty or filtered.
      // Speech filters still decide whether to pause playback or classification.
      if (resumesFinal && ctx.assembler.current(human)) {
        ctx.resumedFinals.set(human, { turn: event.turn_index, text: ctx.assembler.current(human)!.text });
        ctx.turnIndices.delete(human);
      }
      if (event.event === 'TurnResumed' || event.event === 'StartOfTurn') ctx.cancelEager(human);
      if (event.event === 'EndOfTurn') ctx.humanQuiet(human);
      const recent = ctx.recentSpeech.filter(spoken => spoken.until > performance.now());
      let input = ctx.inputSpeech.get(human);
      if (input?.turn !== event.turn_index) {
        input = { turn: event.turn_index, playback: new Set() };
        ctx.inputSpeech.set(human, input);
      }
      for (const spoken of recent) input.playback.add(spoken.text);
      const context = [...input.playback].join(' ');
      // Retain a turn's echo context through its final, even after playout
      // ends. Missing confidence must not make a short playback noise valid.
      const acknowledgment = /^(hey|yeah|yes|yep|okay|ok|uh|huh|hmm)$/.test(speechWords(event.transcript).join(' '));
      const words = speechWords(event.transcript);
      const final = event.event === 'EndOfTurn';
      const named = voiceNameOnly(event.transcript, agents) ||
        voiceContactNameOnly(event.transcript, ctx.externalContacts.get(human));
      const filler = (words.length === 1 && BACKCHANNEL.test(words[0]!)) ||
        /^(mm hmm|uh huh|yeah okay)$/.test(words.join(' '));
      const answering = ctx.awaitingAnswer.has(human);
      // Only a completed spoken question licenses a standalone backchannel.
      // Keep meaningful final words; partials retain their interruption policy.
      const continuing = !!ctx.assembler.current(human) &&
        (words.length > 1 || SINGLE_WORD_REPLIES.has(words[0]!));
      const ignoredFinal = final && !named && (filler ? !answering && !continuing :
        words.length === 1 && /^(hey|i|so|and)$/.test(words[0]!));
      const strayWord = !final && words.length === 1 && !SINGLE_WORD_REPLIES.has(words[0]!) &&
        !voiceContactNameOnly(event.transcript, ctx.externalContacts.get(human)) &&
        !agents.some(agent => [agent.name, agent.handle].some(alias =>
          speechWords(alias).join(' ') === words[0]));
      // Filter partials too: a confident stray word must never pause or barge in.
      // Final rejection consumes the turn before it can enter request assembly.
      if (strayWord || ignoredFinal) {
        if (event.event === 'EndOfTurn') { ctx.cancelEager(human); ctx.turnIndices.set(human, event.turn_index); }
        return;
      }
      if (event.event === 'EndOfTurn' && words.length && !confirmedVoiceSpeech(event))
        console.info('[voice-speech-shadow]', JSON.stringify({ callId: ctx.callId, turnIndex: event.turn_index,
          transcript: event.transcript, words: event.words ?? [] }));
      const recognized = event.event === 'EndOfTurn' ? words.length > 0 : confirmedVoiceSpeech(event);
      if (!recognized || (!(final && filler && answering) && voicePlaybackEcho(event.transcript, context)) ||
          (!(final && filler && answering) && context && acknowledgment && !event.words?.length)) {
        if (event.event === 'EndOfTurn') { ctx.cancelEager(human); ctx.turnIndices.set(human, event.turn_index); }
        return;
      }
      if (event.event === 'EagerEndOfTurn') {
        ctx.task(() => ctx.prepareEager(human, event), human); return;
      }
      ctx.markCallActivity();
      if (event.event !== 'EndOfTurn') ctx.humanSpeaking.add(human);
      ctx.assembler.speaking(human);
      // Recognized speech fences classification even when it is too short to barge in.
      const activeRequest = ctx.assembler.current(human);
      let pausedReply = event.event !== 'EndOfTurn' && !!activeRequest && activeRequest.state !== 'playing' && ctx.speakingHuman === human;
      let liveHumans: number | undefined;
      if (event.event !== 'EndOfTurn') {
        if (activeRequest?.state === 'playing') {
          if (!voiceInterrupt(event)) liveHumans = await ctx.retry(() => ctx.service.humanCount(ctx.callId));
          if (!ownsInput()) return;
          // A final can arrive while live membership resolves. Never cancel its newer request.
          if ((liveHumans === 1 || voiceInterrupt(event)) && ctx.assembler.current(human) === activeRequest) {
            ctx.interruptPlayback(); ctx.assembler.pause(human); pausedReply = true;
          }
        } else {
          if (pausedReply) ctx.interruptPlayback();
          ctx.assembler.pause(human);
        }
      }
      ctx.task(() => ctx.signal({ type: 'speech' }, human), human);
      // Partial recognized names can aim the strip immediately; only EndOfTurn dispatches.
      if (event.event !== 'EndOfTurn') ctx.task(() => ctx.aimSpokenName(human, event.transcript, version), human);
      const stop = /^(stop|cancel|stop conversation|end conversation|leave conversation|stop conversation mode)$/.test(speechWords(event.transcript).join(' '));
      if (event.event === 'EndOfTurn' && event.transcript.trim() && !stop) {
        ctx.turnIndices.set(human, event.turn_index);
        const draft = ctx.assembler.current(human);
        const contacts = ctx.externalContacts.get(human) ?? [];
        if (draft && voiceContactNameOnly(draft.text, contacts)) {
          const contact = contacts.find(name => voiceContactNameOnly(event.transcript, [name]));
          const named = openingVoiceName(event.transcript, agents);
          if (voiceNameOnly(event.transcript, agents) || (named && named.id !== draft.agent?.id) ||
              (contact && !voiceContactNameOnly(draft.text, [contact]))) ctx.assembler.cancel(human, 'contact recipient changed');
          else if (contact) return;
        }
        const resumed = ctx.resumedFinals.get(human);
        ctx.resumedFinals.delete(human);
        const fragment = resumed?.turn === event.turn_index && event.transcript.startsWith(resumed.text)
          ? event.transcript.slice(resumed.text.length).trim() : event.transcript;
        const interrupts = voiceInterrupt(event);
        ctx.task(() => ctx.utterance(human, fragment, receivedAt, interrupts, confirmedVoiceSpeech(event)), human);
        return;
      }
      // With several humans, anyone may interrupt, but only with real speech.
      const humans = liveHumans ?? await ctx.retry(() => ctx.service.humanCount(ctx.callId));
      if (ctx.inputVersions.get(human) !== version || event.turn_index <= (ctx.turnIndices.get(human) ?? -1)) return;
      const interrupts = humans === 1 || voiceInterrupt(event);
      if (interrupts && !pausedReply) ctx.interruptPlayback();
      if (event.event !== 'EndOfTurn' || !event.transcript.trim() ||
          event.turn_index <= (ctx.turnIndices.get(human) ?? -1)) return;
      ctx.turnIndices.set(human, event.turn_index);
      if (stop) {
        ctx.awaitingAnswer.delete(human);
        ctx.cancelEager(human);
        ctx.assembler.cancel(human);
        ctx.speaking?.abort(); ctx.clearAudioQueue();
        return;
      }
      }, human); }, error => {
        if (ctx.inputVersions.get(human) !== version) return;
        ctx.task(() => ctx.failure(error, human)); ctx.stopInput(human);
      }, hints);
    } catch (error) {
      if (ctx.inputVersions.get(human) !== version) { releaseBuffered(); await reader.cancel().catch(() => {}); return; }
      ctx.stopInput(human); throw error;
    }
    if (ctx.closed || ctx.inputVersions.get(human) !== version) { releaseBuffered(); stt.close(); await reader.cancel().catch(() => {}); return; }
    ctx.inputs.set(human, { stt, reader, track, participant });
    try {
      while (buffered.length) {
        const frame = buffered.shift()!;
        if (current() && ctx.meter) ctx.meter.captureReserved(frame.data, frame.at, deliver, frame.release);
        else frame.release();
      }
      await pump;
    } finally { releaseBuffered(); if (ctx.inputs.get(human)?.stt === stt) ctx.stopInput(human); }
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
      if ((await ctx.retry(() => ctx.service.budget.read(ctx.workspaceId))).remainingMs > 0) return;
      await ctx.service.endWorkspaceCalls(ctx.workspaceId);
    } finally { ctx.budgetEnding = false; }
  }


  export function voiceRoomRuntimeArmLeaseExpiry(ctx: VoiceRoomRuntime) {
    clearTimeout(ctx.leaseExpiry);
    ctx.leaseExpiry = setTimeout(() => ctx.task(() => ctx.close()),
      Math.max(0, ctx.leaseValidUntil - performance.now()));
    ctx.leaseExpiry.unref();
  }

  export function voiceRoomRuntimeArmLeaseRenewal(ctx: VoiceRoomRuntime) {
    if (ctx.closed || ctx.leaseParked || ctx.leaseRenewal) return;
    // Private owner evidence only: no participant, budget or projection read.
    ctx.leaseRenewal = startConnectionWork(() => ctx.task(() => ctx.renewLease()), 5000);
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
        const kept = await ctx.retry(() => ctx.service.db.query(`UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '15 seconds'
          WHERE id=$1 AND runtime_owner=$2 AND ended_at IS NULL AND runtime_until>clock_timestamp()`, [ctx.callId, ctx.leaseOwner]));
        if (!kept.rowCount) { await ctx.close(); return false; }
        if (ctx.closed) return false;
        ctx.leaseValidUntil = requestedAt + 15_000;
        ctx.armLeaseExpiry();
        renewed = true; return true;
      } catch (error) {
        failure = error; ctx.leaseParked = true;
        ctx.leaseRenewal?.(); ctx.leaseRenewal = undefined;
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
    clearTimeout(ctx.leaseRecoveryTimer); ctx.leaseRecoveryTimer = undefined;
    const waiting = ctx.leaseRecoveryWait; ctx.leaseRecoveryWait = undefined;
    ctx.leaseRecoveryBackground = false;
    if (error) waiting?.reject(error); else waiting?.resolve(renewed);
  }

  export function voiceRoomRuntimeResumeLeaseEvidence(ctx: VoiceRoomRuntime) {
    if (ctx.closed || ctx.leaseRecoveryTimer || !ctx.leaseRecoveryWait) return;
    // This wake belongs to actual recovery/Resume and enforces the control
    // quota. Its one failed attempt cannot recreate the same intent.
    ctx.leaseRecoveryTimer = setTimeout(() => {
      ctx.leaseRecoveryTimer = undefined;
      if (ctx.closed || !ctx.leaseParked) { ctx.settleLeaseRecovery(false); return; }
      ctx.leaseParked = false;
      ctx.task(async () => { if (await ctx.renewLease()) ctx.armLeaseRenewal(); });
    }, Math.max(0, Math.ceil(ctx.nextLeaseAt - performance.now())));
    ctx.leaseRecoveryTimer.unref();
  }


  /** Existing explicit resume action, never invoked by PCM or lease ticks. */
  export async function voiceRoomRuntimeHeartbeat(ctx: VoiceRoomRuntime) {
    if (!await ctx.renewLease()) return;
    await ctx.revalidateParticipants();
    await ctx.reconcileParticipants();
    await ctx.countHumans();
    await ctx.refresh();
  }

  export async function voiceRoomRuntimeRevalidateAuthorityChange(ctx: VoiceRoomRuntime, event: Extract<LiveEvent, { type: 'invalidate' }>): Promise<void> {
    if (ctx.closed || !ctx.workspaceId) return;
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
        await ctx.retry(() => ctx.service.access(ctx.roomId, participant.identity));
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


  export function voiceRoomRuntimeCancelAbsent(ctx: VoiceRoomRuntime, human: string) {
    const absent = ctx.absent.get(human);
    clearTimeout(absent?.timer); ctx.absent.delete(human);
  }

  export function voiceRoomRuntimeArmAbsent(ctx: VoiceRoomRuntime, human: string) {
    if (ctx.closed || ctx.room.remoteParticipants.has(human)) return;
    const session = ctx.participantSessions.get(human);
    if (session === undefined) return;
    const previous = ctx.absent.get(human);
    if (previous?.session === session) return;
    ctx.cancelAbsent(human);
    const absent = { session, due: performance.now() + 120_000, attempted: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined };
    ctx.absent.set(human, absent);
    absent.timer = setTimeout(() => {
      absent.timer = undefined;
      if (ctx.closed || ctx.absent.get(human) !== absent || absent.attempted ||
        ctx.participantSessions.get(human) !== absent.session || ctx.room.remoteParticipants.has(human)) return;
      absent.attempted = true;
      ctx.task(() => ctx.service.leave(ctx.callId, human, true, absent.session, undefined, ctx.leaseOwner), human);
    }, Math.max(0, absent.due - performance.now()));
    absent.timer.unref();
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
          const current = await ctx.retry(() => ctx.service.db.query<{ identity_id: string; session_id: string }>(
            `SELECT identity_id,session_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL LIMIT 513`, [ctx.callId]));
          if (ctx.closed) return;
          if (current.rows.length > 512) { await ctx.close(); throw new Error('Voice participant bound exceeded'); }
          const sessions = new Map(current.rows.map(row => [row.identity_id, row.session_id]));
          for (const human of ctx.participantSessions.keys()) if (!sessions.has(human)) ctx.participantLeft(human);
          for (const [human, intent] of ctx.resumeIntents) if (sessions.get(human) !== intent.session) ctx.cancelResume(human);
          ctx.participantSessions.clear();
          for (const [human, session] of sessions) {
            ctx.participantSessions.set(human, session);
            if (ctx.room.remoteParticipants.has(human)) ctx.cancelAbsent(human);
            else ctx.armAbsent(human);
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
