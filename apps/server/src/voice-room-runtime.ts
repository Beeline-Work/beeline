import { type VoiceAgent, VOICE_SAMPLE_RATE, type VoiceStt, type FluxEvent } from "./voice-providers.js";
import { type SpeechMember, markdownToSpeech } from "./markdown-to-speech.js";
import { VoiceSpeechPrefetch } from "./voice-speech-prefetch.js";
import { cleanVoiceReply } from "./voice-reply.js";
import { voiceTempo, VOICE_PCM_THRESHOLD } from "./voice-tempo.js";
import { AudioFrame, TrackKind, RoomEvent, TrackPublishOptions, TrackSource, LocalAudioTrack, type RemoteTrack, type RemoteParticipant, AudioStream, Room, AudioSource } from "@livekit/rtc-node";
import { VoiceAudioMeter } from "./voice-budget.js";
import { AccessToken } from "livekit-server-sdk";
import { VOICE_DATA_TOPIC, type VoiceSignal, type VoiceBudget } from "@beeline/api-contract/phone";
import { voiceNameOnly, voiceContactNameOnly, VoiceRequestAssembler } from "./voice-request-assembler.js";
import { openingVoiceName } from "./voice-target.js";
import { VoiceEagerReply } from "./voice-eager-reply.js";
import type { VoiceService } from "./voice-service.js";
import type { LiveEvent } from "./live.js";
import { voiceRoomRuntimeRefreshSpeakingSpeed, voiceRoomRuntimeObserveCallerResume, voiceRoomRuntimeFinishVoicedReply, voiceRoomRuntimeHumanQuiet, voiceRoomRuntimeWaitForQuiet, voiceRoomRuntimeTask, voiceRoomRuntimeFailure, voiceRoomRuntimeSafeSignal, voiceRoomRuntimeSignal, voiceRoomRuntimeStopInput, voiceRoomRuntimeEnforceBudget, voiceRoomRuntimeRenewLease, voiceRoomRuntimeRecover, voiceRoomRuntimeRequestLeaseRecovery, voiceRoomRuntimeSettleLeaseRecovery, voiceRoomRuntimeResumeLeaseEvidence, voiceRoomRuntimeRevalidateAuthorityChange, voiceRoomRuntimeRevalidateParticipants, voiceRoomRuntimeReconcileParticipants } from './voice-room-runtime-refresh-speaking-speed.js';
import { voiceRoomRuntimeClearAudioQueue, voiceRoomRuntimeInterruptPlayback, voiceRoomRuntimeParticipantLeft, voiceRoomRuntimeStopCall, voiceRoomRuntimeAimSpokenName, voiceRoomRuntimeCountHumans, voiceRoomRuntimeCancelEager, voiceRoomRuntimePrepareEager, voiceRoomRuntimeUtterance, voiceRoomRuntimeRefresh, voiceRoomRuntimeCancelResume } from './voice-room-runtime-check-inactivity.js';
import { voiceRoomRuntimeClose, voiceRoomRuntimeFinishClose } from './voice-room-runtime-close.js';





export class DeliveredVoicePlaybackError extends Error {
  constructor(cause: unknown) { super('Request delivered; voice reply unavailable', { cause }); }
}



export const speechWords = (text: string) => text.trim().toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];



/** Flux VAD alone can fire on noise. Wait for confident recognized words. */
export function confirmedVoiceSpeech(event: FluxEvent): boolean {
  if (!speechWords(event.transcript).length) return false;
  if (!event.words?.length) return event.event === 'EndOfTurn';
  const words = event.words.filter(word => Number.isFinite(word.confidence) && word.confidence >= 0.8);
  return words.length > 0 && words.length >= event.words.length * 0.75 &&
    words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end)) &&
    words[words.length - 1]!.end - words[0]!.start >= 0.12;
}



// Partial speech keeps the existing conservative interruption vocabulary.
export const SINGLE_WORD_REPLIES = new Set(['yes', 'no', 'yeah', 'yep', 'yup', 'nope', 'sure',
  'okay', 'ok', 'stop', 'wait', 'cancel', 'pause', 'continue', 'thanks']);



export const BACKCHANNEL = /^(uh|um|uhm|er|erm|ah|oh|ha|haha|hah|hm|hmm|mm|mhm|mmhmm|uhhuh|huh|yeah|yes|yep|yup|ok|okay|right|sure|cool|nice|wow)$/;



/** In a call with several humans, any of them may interrupt an agent, but noise and
 * backchannel words never do. Confirmed speech needs two words or about 400 ms. */
export function voiceInterrupt(event: FluxEvent): boolean {
  const words = speechWords(event.transcript).filter(word => !BACKCHANNEL.test(word.replace(/-/g, '')));
  if (!words.length) return false;
  if (words.length >= 2) return true;
  const timed = event.words?.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end)) ?? [];
  return timed.length > 0 && timed[timed.length - 1]!.end - timed[0]!.start >= 0.4;
}



/** A recognized fragment of our own recent output must not start another answer. */
export function voicePlaybackEcho(transcript: string, playback: string): boolean {
  const words = speechWords(transcript), spoken = speechWords(playback);
  if (!words.length) return false;
  if (/^(stop|wait|pause|cancel|no)$/.test(words.join(' '))) return false;
  return spoken.some((_, at) => words.every((word, i) => spoken[at + i] === word));
}



/** About a minute at conversational pace, preserving whole sentences. */
export function spokenReport(text: string): string {
  const plain = markdownToSpeech(text);
  const first = markdownToSpeech(text.trim().split(/\n\s*\n/)[0] ?? '');
  const words = (value: string) => value.match(/\S+/g)?.length ?? 0;
  const short = (value: string) => words(value) <= 150 && value.length <= 1080 &&
    (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0) <= 240;
  let opening = first;
  if (!short(first)) {
    opening = '';
    for (const sentence of plain.match(/[^.!?。！？]+[.!?。！？]+(?:["’”']|$)?/g) ?? []) {
      if (!short(opening + sentence)) break;
      opening += sentence;
    }
  }
  const spoken = opening.trim();
  return [spoken, spoken !== plain.trim() ? 'The rest is in the chat.' : ''].filter(Boolean).join(' ');
}


export class VoiceRoomRuntime {

   readonly room = new Room();

   readonly audio = new AudioSource(VOICE_SAMPLE_RATE, 1, 100);

   readonly inputs = new Map<string, { stt?: VoiceStt; reader: ReadableStreamDefaultReader<AudioFrame>;
    track: RemoteTrack; participant: RemoteParticipant; releaseBuffered?(): void; buffered?: readonly { data: Int16Array }[] }>();

   meter?: VoiceAudioMeter;

   workspaceId = '';

   authorityRoomId = '';

   readonly authorityPaused = new Set<string>();

   readonly authorityVersions = new Map<string, number>();

   authorityRevision = 0;

   budgetDisplay = '';

   budgetEnding = false;

   readonly awaitingAnswer = new Set<string>();

   readonly recentSpeech: { text: string; until: number }[] = [];

   readonly speedRefreshes = new Map<string, symbol>();

   readonly speakingSpeeds = new Map<string, number>();
async refreshSpeakingSpeed(human: string) { return voiceRoomRuntimeRefreshSpeakingSpeed(this, human); }

   readonly targets = new Map<string, string>();

   readonly explicitTargets = new Map<string, string>();

   readonly turnIndices = new Map<string, number>();

   readonly resumedFinals = new Map<string, { turn: number; text: string }>();

   readonly inputVersions = new Map<string, number>();

   readonly inputSpeech = new Map<string, { turn: number; playback: Set<string> }>();

   readonly externalContacts = new Map<string, readonly string[]>();

   readonly eager = new Map<string, { turn: number; text: string; reply?: VoiceEagerReply }>();

   readonly assembler = new VoiceRequestAssembler();

   spokenWrites = Promise.resolve();

   readonly shutdown = new AbortController();

   lastAnnouncedHumanCount?: number;

   humanCountRefresh = Promise.resolve();

   speaking?: AbortController;

   speakingHuman?: string;

   voicedReply?: { human: string; traceId: string; kind: 'turn' | 'report'; signal: AbortSignal; firstAt: number; lastAt: number;
    resumedAt?: number; clearedAt?: number };
observeCallerResume(human: string, event: FluxEvent) { return voiceRoomRuntimeObserveCallerResume(this, human, event); }
finishVoicedReply(signal: AbortSignal) { return voiceRoomRuntimeFinishVoicedReply(this, signal); }

   readonly humanSpeaking = new Set<string>();

   readonly quietWaiters = new Set<() => void>();
humanQuiet(human: string) { return voiceRoomRuntimeHumanQuiet(this, human); }
async waitForQuiet() { return voiceRoomRuntimeWaitForQuiet(this); }

   playbackVersion = 0;

   speechIdle = Promise.resolve();

   closed = false;

   closeWork?: Promise<void>;

   audioDisposed = false;

   leaseValidUntil = 0;

   refreshPending = false;

   reportQueue = Promise.resolve();

   readonly queuedReports = new Set<string>();

   workHydrated = false;

   readonly pendingWork = new Map<string, { text: string; agent_id: string; human_id: string }>();

   readonly participantSessions = new Map<string, string>();

   participantsRefresh?: Promise<void>;

   participantsDirty = false;

   readonly resumeIntents = new Map<string, { participant: RemoteParticipant; session: string | undefined;
    controller: AbortController; promise?: Promise<void> }>();

   leaseFlight?: Promise<boolean>;

   nextLeaseAt = 0;

   leaseParked = false;

   leaseRecovery = 0;

   leaseRecoveryBackground = false;

   leaseRecoveryWait?: { promise: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void };

   readonly recoveryRelease?: () => void;

   constructor( readonly service: VoiceService, readonly callId: string, readonly roomId: string,
     readonly leaseOwner: string, readonly callCardId?: string) {
    this.recoveryRelease = service.onDatabaseRecovery?.(() => {
      if (!this.closed) this.task(() => this.recover());
    });
  }


  /** Terminal boundary for every RTC callback and detached call task. */
   async eventLease(): Promise<boolean> {
    if (this.closed) return false;
    if (performance.now() >= this.leaseValidUntil) { await this.close(); return false; }
    return this.renewLease();
  }
async task(work: () => Promise<unknown> | unknown, human?: string): Promise<void> { return voiceRoomRuntimeTask(this, work, human); }
async failure(error: unknown, human?: string): Promise<void> { return voiceRoomRuntimeFailure(this, error, human); }
async safeSignal(signal: VoiceSignal, human?: string): Promise<void> { return voiceRoomRuntimeSafeSignal(this, signal, human); }

  /** One admitted attempt. A failed observation cannot create a retry clock;
   * the existing action/source/ownership boundary decides subsequent work. */
   observe<T>(work: () => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    return work();
  }


  static async connect(service: VoiceService, callId: string, roomId: string, leaseOwner: string = service.owner, callCardId?: string) {
    const runtime = new VoiceRoomRuntime(service, callId, roomId, leaseOwner, callCardId);
    try {
      if (!await runtime.renewLease()) throw new Error('Voice call ownership expired');
      await runtime.start(); return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
async start() { return voiceRoomRuntimeStart(this); }
async signal(signal: VoiceSignal, human?: string) { return voiceRoomRuntimeSignal(this, signal, human); }
async listen(track: RemoteTrack, participant: RemoteParticipant) { return voiceRoomRuntimeListen(this, track, participant); }
stopInput(human: string) { return voiceRoomRuntimeStopInput(this, human); }
async enforceBudget(budget: VoiceBudget) { return voiceRoomRuntimeEnforceBudget(this, budget); }
renewLease(): Promise<boolean> { return voiceRoomRuntimeRenewLease(this); }
async recover() { return voiceRoomRuntimeRecover(this); }
requestLeaseRecovery(background: boolean): Promise<boolean> { return voiceRoomRuntimeRequestLeaseRecovery(this, background); }
settleLeaseRecovery(renewed: boolean, error?: unknown) { return voiceRoomRuntimeSettleLeaseRecovery(this, renewed, error); }
resumeLeaseEvidence() { return voiceRoomRuntimeResumeLeaseEvidence(this); }
async revalidateAuthorityChange(event: Extract<LiveEvent, {
    type: 'invalidate';
}>): Promise<void> { return voiceRoomRuntimeRevalidateAuthorityChange(this, event); }
async revalidateParticipants(affectedHuman?: string) { return voiceRoomRuntimeRevalidateParticipants(this, affectedHuman); }


   departed(human: string) {
    if (this.closed || this.room.remoteParticipants.has(human)) return;
    const session = this.participantSessions.get(human);
    if (session !== undefined) this.task(() => this.service.leave(this.callId, human, true, session, undefined, this.leaseOwner), human);
  }
/** Startup and actual participant/card source changes own this snapshot.
 * Session IDs remain server-private and fence late device departures. */
reconcileParticipants(): Promise<void> { return voiceRoomRuntimeReconcileParticipants(this); }
clearAudioQueue() { return voiceRoomRuntimeClearAudioQueue(this); }
interruptPlayback() { return voiceRoomRuntimeInterruptPlayback(this); }
participantLeft(human: string) { return voiceRoomRuntimeParticipantLeft(this, human); }
async stopCall() { return voiceRoomRuntimeStopCall(this); }
async aimSpokenName(human: string, text: string, version: number) { return voiceRoomRuntimeAimSpokenName(this, human, text, version); }
/** Deduplicate announcements only; mode decisions always read the database count. */
countHumans(announce = false): Promise<void> { return voiceRoomRuntimeCountHumans(this, announce); }
cancelEager(human: string) { return voiceRoomRuntimeCancelEager(this, human); }
async prepareEager(human: string, event: FluxEvent) { return voiceRoomRuntimePrepareEager(this, human, event); }
async utterance(human: string, fragment: string, startedAt = performance.now(), interrupts = true, confirmedSpeech = true) { return voiceRoomRuntimeUtterance(this, human, fragment, startedAt, interrupts, confirmedSpeech); }
/** Match actual command provenance, never agent thought/draft events. No work deadline. */
async refresh() { return voiceRoomRuntimeRefresh(this); }
async play(text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void, onFirstVoicedFrame?: () => void | Promise<void>, timing?: (stage: string) => void, members?: SpeechMember[], opening?: VoiceSpeechPrefetch, speakingSpeed?: number) { return voiceRoomRuntimePlay(this, text, agent, signal, onFirstAudio, onFirstVoicedFrame, timing, members, opening, speakingSpeed); }


  get isClosed() { return this.closed; }
cancelResume(human: string) { return voiceRoomRuntimeCancelResume(this, human); }
resume(human: string): Promise<void> { return voiceRoomRuntimeResume(this, human); }
close(): Promise<void> { return voiceRoomRuntimeClose(this); }
async finishClose(meterClose: Promise<void>) { return voiceRoomRuntimeFinishClose(this, meterClose); }
}



  export async function voiceRoomRuntimePlay(ctx: VoiceRoomRuntime, text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void,
    onFirstVoicedFrame?: () => void | Promise<void>, timing?: (stage: string) => void, members?: SpeechMember[], opening?: VoiceSpeechPrefetch, speakingSpeed?: number) {
    text = markdownToSpeech(cleanVoiceReply(text, agent.name), members);
    if (!text) return;
    let pending = Buffer.alloc(0); let first = true; let firstByte = true; let firstPublished = true;
    // 20ms mono frames. Carry odd byte boundaries between provider chunks.
    const frameBytes = VOICE_SAMPLE_RATE / 50 * 2;
    const [speech, playbackAgents] = await Promise.all([
      ctx.service.speech(ctx.roomId), ctx.observe(() => ctx.service.agents(ctx.roomId)),
    ]);
    // A settings change applies to the next playback with that provider's own timbre.
    const current = playbackAgents.find(a => a.id === agent.id);
    const voice = current?.voice ?? agent.voice;
    if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
    const cancelOpening = () => opening?.cancel();
    signal.addEventListener('abort', cancelOpening, { once: true });
    const spoken = { text: text.trim(), until: Infinity };
    ctx.recentSpeech.push(spoken);
    if (ctx.recentSpeech.length > 12) ctx.recentSpeech.shift();
    try {
      timing?.('tts_request');
      if (voice !== agent.voice) { opening?.cancel(); opening = undefined; }
      for await (const bytes of voiceTempo(opening ? opening.read() : speech.synthesize(spoken.text, voice, signal), speakingSpeed)) {
        if (!await ctx.eventLease()) throw new DOMException('Voice ownership expired', 'AbortError');
        if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
        if (firstByte && bytes.length) { firstByte = false; timing?.('tts_first_byte'); }
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= frameBytes) {
          if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
          const samples = new Int16Array(frameBytes / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
          pending = pending.subarray(frameBytes);

            const voiced = first && samples.some(sample => Math.abs(sample) > VOICE_PCM_THRESHOLD);
          if (voiced) { first = false; await onFirstVoicedFrame?.(); }
          if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
          await ctx.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
          if (ctx.voicedReply?.signal === signal) ctx.voicedReply.lastAt = performance.now();
          if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
          if (!signal.aborted && !ctx.closed && voiced) onFirstAudio?.();
        }
      }
      if (pending.length > 1) {
        const samples = new Int16Array(Math.floor(pending.length / 2));
        for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);

        const voiced = first && samples.some(sample => Math.abs(sample) > VOICE_PCM_THRESHOLD);
        if (voiced) { first = false; await onFirstVoicedFrame?.(); }
        if (signal.aborted || ctx.closed) throw new DOMException('Interrupted', 'AbortError');
        await ctx.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
        if (ctx.voicedReply?.signal === signal) ctx.voicedReply.lastAt = performance.now();
        if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
        if (!signal.aborted && !ctx.closed && voiced) onFirstAudio?.();
      }
      await ctx.audio.waitForPlayout();
    } finally {
      signal.removeEventListener('abort', cancelOpening);
      opening?.cancel();
      spoken.until = performance.now() + 1500;
    }
  }


  export function voiceRoomRuntimeResume(ctx: VoiceRoomRuntime, human: string): Promise<void> {
    const existing = ctx.resumeIntents.get(human);
    if (existing && !existing.controller.signal.aborted) return existing.promise!;
    const participant = ctx.room.remoteParticipants.get(human);
    if (!participant || ctx.closed) return Promise.reject(new Error('voice transport disconnected'));
    const intent = { participant, session: ctx.participantSessions.get(human), controller: new AbortController(),
      promise: undefined as Promise<void> | undefined };
    ctx.resumeIntents.set(human, intent);
    intent.promise = (async () => {
      let stop!: () => void;
      const canceled = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new DOMException('Voice Resume source changed', 'AbortError'));
        intent.controller.signal.addEventListener('abort', stop, { once: true });
      });
      try {
        const evidence = ctx.leaseParked || ctx.leaseFlight ? ctx.requestLeaseRecovery(false) : ctx.renewLease();
        const owned = await Promise.race([evidence, canceled]);
        const current = () => !ctx.closed && !intent.controller.signal.aborted &&
          ctx.room.remoteParticipants.get(human) === participant && ctx.participantSessions.get(human) === intent.session;
        if (!owned || !current()) throw new DOMException('Voice Resume source changed', 'AbortError');
        await ctx.revalidateParticipants();
        if (!current()) throw new DOMException('Voice Resume source changed', 'AbortError');
        for (const publication of participant.trackPublications.values()) {
          if (publication.track?.kind === TrackKind.KIND_AUDIO) ctx.task(() => ctx.listen(publication.track!, participant), human);
        }
        await ctx.refresh();
        if (current() && !ctx.speaking) await ctx.signal({ type: 'speaker', agentId: null }, human);
      } finally { intent.controller.signal.removeEventListener('abort', stop); }
    })().finally(() => { if (ctx.resumeIntents.get(human) === intent) ctx.resumeIntents.delete(human); });
    return intent.promise;
  }


  export async function voiceRoomRuntimeStart(ctx: VoiceRoomRuntime) {
    const scope = await ctx.observe(() => ctx.service.runtimeScope(ctx.roomId));
    ctx.workspaceId = scope.workspaceId; ctx.authorityRoomId = scope.authorityRoomId;
    const budget = await ctx.observe(() => ctx.service.budget.read(ctx.workspaceId));
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
      if (!ctx.room.remoteParticipants.has(participant.identity)) { ctx.cancelResume(participant.identity); ctx.departed(participant.identity); }
    }, participant.identity));
    ctx.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (!participant || topic !== VOICE_DATA_TOPIC || bytes.length > 2048) return;
      ctx.task(async () => {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
        if (data.type !== 'target' && data.type !== 'unpin' && data.type !== 'resume' && data.type !== 'park') return;
        await ctx.observe(() => ctx.service.access(ctx.roomId, participant.identity));
        if (data.type === 'target' || data.type === 'unpin') ctx.cancelEager(participant.identity);
        if (data.type === 'unpin') {
          ctx.explicitTargets.delete(participant.identity);
          ctx.assembler.clearAddress(participant.identity);
          await ctx.refresh(); return;
        }
        if (data.type === 'target') {
          const allowed = await ctx.observe(() => ctx.service.agents(ctx.roomId, participant.identity));
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
        if (typeof data.sessionId !== 'string' || !(await ctx.observe(() => ctx.service.db.query(`SELECT 1 FROM voice_participants
          WHERE call_id=$1 AND identity_id=$2 AND session_id=$3 AND left_at IS NULL
          AND (parked_at IS NOT NULL)=$4`, [ctx.callId, participant.identity, data.sessionId, data.type === 'park']))).rowCount) return;
        if (data.type === 'park') return;
        else await ctx.resume(participant.identity);
      }, participant.identity);
    });
    ctx.room.on(RoomEvent.ParticipantConnected, participant => {
      ctx.task(async () => { await ctx.reconcileParticipants(); await ctx.countHumans(true); });
    });
    ctx.room.on(RoomEvent.Disconnected, () => { if (!ctx.closed) ctx.task(() => ctx.close()); });
    await ctx.room.connect(ctx.service.config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    ctx.shutdown.signal.throwIfAborted();
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await ctx.room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('beeline-agent-speech', ctx.audio), options);
    ctx.shutdown.signal.throwIfAborted();
    await ctx.reconcileParticipants();
    await ctx.countHumans(true).catch(() => {});
    await ctx.refresh();
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
      if (!current()) return;
      if (performance.now() >= ctx.leaseValidUntil) { void ctx.close(); return; }
      try { stt!.send(admitted); } catch (error) { void ctx.failure(error, human); }
    };
    const send = (data: Int16Array, capturedAt: number) => {
      if (current()) ctx.meter?.capture(data, capturedAt, deliver);
    };
    // Authorization buffering shares the meter's call-wide byte/duration cap.
    const pump = (async () => {
      while (!ctx.closed && ctx.inputVersions.get(human) === version) {
        const frame = await reader.read();
        if (frame.done || !ownsInput() || !await ctx.eventLease()) break;
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
      await ctx.observe(() => ctx.service.access(ctx.roomId, human));
      if (!ownsInput()) { releaseBuffered(); return; }
      if (ctx.authorityVersions.get(human) === authorityVersion && ctx.inputVersions.get(human) === version)
        ctx.authorityPaused.delete(human);
      const member = await ctx.observe(() => ctx.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL`,
        [ctx.callId, human]));
      // A completed read belongs to its original track generation. In
      // particular an old denial cannot stop the replacement microphone.
      if (!ownsInput()) { releaseBuffered(); return; }
      if (!member.rowCount) { ctx.stopInput(human); return; }
      const [agents, budget, contacts] = await Promise.all([
        ctx.observe(() => ctx.service.agents(ctx.roomId, human)), ctx.observe(() => ctx.service.budget.read(ctx.workspaceId)),
        ctx.observe(() => ctx.service.db.query<{ name: string }>(
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

      if (event.event !== 'EndOfTurn') ctx.humanSpeaking.add(human);
      ctx.assembler.speaking(human);
      // Recognized speech fences classification even when it is too short to barge in.
      const activeRequest = ctx.assembler.current(human);
      let pausedReply = event.event !== 'EndOfTurn' && !!activeRequest && activeRequest.state !== 'playing' && ctx.speakingHuman === human;
      let liveHumans: number | undefined;
      if (event.event !== 'EndOfTurn') {
        if (activeRequest?.state === 'playing') {
          if (!voiceInterrupt(event)) liveHumans = await ctx.observe(() => ctx.service.humanCount(ctx.callId));
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
      const humans = liveHumans ?? await ctx.observe(() => ctx.service.humanCount(ctx.callId));
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
export { namedVoiceTarget } from './voice-target.js';
