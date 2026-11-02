import { voiceTempo, VOICE_PCM_THRESHOLD } from './voice-tempo.js';
import { VoiceEagerReply } from './voice-eager-reply.js';
import { VoiceSpeechPrefetch } from './voice-speech-prefetch.js';
import { cleanVoiceReply } from './voice-reply.js';
import { readVoiceContext } from './voice-context.js';
import { captureServerError } from './sentry.js';
import { VoiceAudioMeter, VOICE_WARNING_MS } from './voice-budget.js';
import { randomUUID } from 'node:crypto';
import { markdownToSpeech, MarkdownSpeechStream, type SpeechMember } from './markdown-to-speech.js';
import { AccessToken } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';
import { VOICE_DATA_TOPIC, type VoiceSignal, type VoiceBudget } from '@beeline/api-contract/phone';
import type { VoiceService } from './voice-service.js';
import type { LiveEvent } from './live.js';
import { VOICE_SAMPLE_RATE, VoiceQuotaError, type VoiceAgent, type VoiceStt, type FluxEvent, type VoiceBrain } from './voice-providers.js';

import { VoiceRequestAssembler, voiceNameOnly, voiceContactNameOnly } from './voice-request-assembler.js';
import { namedVoiceTarget, openingVoiceName } from './voice-target.js';
export { namedVoiceTarget } from './voice-target.js';

class DeliveredVoicePlaybackError extends Error {
  constructor(cause: unknown) { super('Request delivered; voice reply unavailable', { cause }); }
}

const speechWords = (text: string) => text.trim().toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

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
const SINGLE_WORD_REPLIES = new Set(['yes', 'no', 'yeah', 'yep', 'yup', 'nope', 'sure',
  'okay', 'ok', 'stop', 'wait', 'cancel', 'pause', 'continue', 'thanks']);

const BACKCHANNEL = /^(uh|um|uhm|er|erm|ah|oh|ha|haha|hah|hm|hmm|mm|mhm|mmhmm|uhhuh|huh|yeah|yes|yep|yup|ok|okay|right|sure|cool|nice|wow)$/;

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

/** One lease-bound call runtime. Real agents continue outside this audio turn. */
export class VoiceRoomRuntime {
  private readonly room = new Room();
  private readonly audio = new AudioSource(VOICE_SAMPLE_RATE, 1, 100);
  private readonly inputs = new Map<string, { stt?: VoiceStt; reader: ReadableStreamDefaultReader<AudioFrame>;
    track: RemoteTrack; participant: RemoteParticipant; releaseBuffered?(): void; buffered?: readonly { data: Int16Array }[] }>();
  private meter?: VoiceAudioMeter;
  private workspaceId = '';
  private authorityRoomId = '';
  private readonly authorityPaused = new Set<string>();
  private readonly authorityVersions = new Map<string, number>();
  private authorityRevision = 0;
  private budgetDisplay = '';
  private budgetEnding = false;
  private readonly awaitingAnswer = new Set<string>();
  private readonly recentSpeech: { text: string; until: number }[] = [];
  private readonly speedRefreshes = new Map<string, symbol>();
  private readonly speakingSpeeds = new Map<string, number>();
  async refreshSpeakingSpeed(human: string) {
    if (!this.inputs.has(human)) return;
    const version = this.inputVersions.get(human);
    const refresh = Symbol();
    this.speedRefreshes.set(human, refresh);
    this.speakingSpeeds.delete(human);
    try {
      const row = (await this.service.db.query<{ speaking_speed: number }>(
        `SELECT speaking_speed FROM identities WHERE id=$1`, [human])).rows[0];
      if (this.inputs.has(human) && this.inputVersions.get(human) === version && this.speedRefreshes.get(human) === refresh) this.speakingSpeeds.set(human, row?.speaking_speed ?? 1.15);
    } catch { /* Optional preference reads never block a call. */ }
  }
  private readonly targets = new Map<string, string>();
  private readonly explicitTargets = new Map<string, string>();
  private readonly turnIndices = new Map<string, number>();
  private readonly resumedFinals = new Map<string, { turn: number; text: string }>();
  private readonly inputVersions = new Map<string, number>();
  private readonly inputSpeech = new Map<string, { turn: number; playback: Set<string> }>();
  private readonly externalContacts = new Map<string, readonly string[]>();
  private readonly eager = new Map<string, { turn: number; text: string; reply?: VoiceEagerReply }>();
  private readonly assembler = new VoiceRequestAssembler();
  private spokenWrites = Promise.resolve();
  private readonly shutdown = new AbortController();
  private lastAnnouncedHumanCount?: number;
  private humanCountRefresh = Promise.resolve();
  private speaking?: AbortController;
  private speakingHuman?: string;
  private voicedReply?: { human: string; traceId: string; kind: 'turn' | 'report'; signal: AbortSignal; firstAt: number; lastAt: number;
    resumedAt?: number; clearedAt?: number };
  private observeCallerResume(human: string, event: FluxEvent) {
    const reply = this.voicedReply;
    if (!reply || this.speaking?.signal !== reply.signal || reply.human !== human || reply.resumedAt !== undefined ||
        event.event === 'EndOfTurn' || event.event === 'EagerEndOfTurn' || !confirmedVoiceSpeech(event)) return;
    const context = this.recentSpeech.filter(spoken => spoken.until > performance.now()).map(spoken => spoken.text).join(' ');
    if (voicePlaybackEcho(event.transcript, context)) return;
    reply.resumedAt = performance.now();
    console.info('[voice-playback-resume]', JSON.stringify({ callId: this.callId, traceId: reply.traceId,
      callerId: human, replyKind: reply.kind, event: event.event, turnIndex: event.turn_index, sinceFirstVoicedMs: reply.resumedAt - reply.firstAt }));
  }
  private finishVoicedReply(signal: AbortSignal) {
    const reply = this.voicedReply;
    if (!reply || reply.signal !== signal) return;
    if (reply.resumedAt !== undefined) console.info('[voice-playback-stopped]', JSON.stringify({ callId: this.callId,
      traceId: reply.traceId, callerId: reply.human, replyKind: reply.kind, publicationTailMs: Math.max(0, reply.lastAt - reply.resumedAt),
      queueClearMs: reply.clearedAt === undefined ? null : reply.clearedAt - reply.resumedAt,
      cleanupMs: performance.now() - reply.resumedAt }));
    this.voicedReply = undefined;
  }
  private readonly humanSpeaking = new Set<string>();
  private readonly quietWaiters = new Set<() => void>();
  private humanQuiet(human: string) {
    this.humanSpeaking.delete(human);
    for (const resolve of this.quietWaiters) resolve();
    this.quietWaiters.clear();
  }
  private async waitForQuiet() {
    while (!this.closed && (this.speaking || this.humanSpeaking.size)) {
      if (this.speaking) await this.speechIdle;
      else await new Promise<void>(resolve => this.quietWaiters.add(resolve));
    }
  }
  private playbackVersion = 0;
  private speechIdle = Promise.resolve();
  private lastActivity = performance.now();
  private lastWorkFinishedAt = 0;
  private endingDeadline: number | null = null;
  private endingTonePlayed = false;
  private quietCheck?: ReturnType<typeof setTimeout>;
  private inactivityCheck?: Promise<void>;
  private leaseExpiry?: ReturnType<typeof setTimeout>;
  private leaseRenewal?: ReturnType<typeof setInterval>;
  private closed = false;
  private closeWork?: Promise<void>;
  private audioDisposed = false;
  private leaseValidUntil = 0;
  private refreshPending = false;
  private reportQueue = Promise.resolve();
  private readonly queuedReports = new Set<string>();
  private workHydrated = false;
  private readonly pendingWork = new Map<string, { text: string; agent_id: string; human_id: string }>();
  private readonly participantSessions = new Map<string, string>();
  private readonly absent = new Map<string, { session: string; due: number; attempted: boolean; timer?: ReturnType<typeof setTimeout> }>();
  private participantsRefresh?: Promise<void>;
  private participantsDirty = false;
  private readonly resumeIntents = new Map<string, { participant: RemoteParticipant; session: string | undefined;
    controller: AbortController; promise?: Promise<void> }>();
  private leaseFlight?: Promise<boolean>;
  private nextLeaseAt = 0;
  private leaseParked = false;
  private leaseRecovery = 0;
  private leaseRecoveryTimer?: ReturnType<typeof setTimeout>;
  private leaseRecoveryBackground = false;
  private leaseRecoveryWait?: { promise: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void };
  private readonly recoveryRelease?: () => void;
  private constructor(private readonly service: VoiceService, readonly callId: string, readonly roomId: string,
    private readonly leaseOwner: string, readonly callCardId?: string) {
    this.recoveryRelease = service.onDatabaseRecovery?.(() => {
      if (!this.closed) this.task(() => this.recover());
    });
  }

  /** Terminal boundary for every RTC callback and detached call task. */
  private task(work: () => Promise<unknown> | unknown, human?: string): Promise<void> {
    try { return Promise.resolve(work()).then(() => {}, error => this.failure(error, human)); }
    catch (error) { return this.failure(error, human); }
  }
  private async failure(error: unknown, human?: string): Promise<void> {
    if (error instanceof Error && error.name === 'AbortError') return;
    captureServerError(error, { surface: 'voice', callId: this.callId });
    try {
      const cause = error instanceof DeliveredVoicePlaybackError ? error.cause : error;
      const message = cause instanceof VoiceQuotaError ? cause.message : 'Voice reply unavailable; please try again';
      await this.signal({ type: 'error', message: error instanceof DeliveredVoicePlaybackError
        ? `Request delivered; ${cause instanceof VoiceQuotaError ? message : 'voice reply unavailable'}` : message,
        ...(cause instanceof VoiceQuotaError ? { code: cause.code } : {}) }, human);
    } catch (reportError) { captureServerError(reportError, { surface: 'voice-error-signal' }); }
  }
  private async safeSignal(signal: VoiceSignal, human?: string): Promise<void> {
    try { await this.signal(signal, human); }
    catch (error) { captureServerError(error, { surface: 'voice-signal' }); }
  }
  /** One admitted attempt. A failed observation cannot create a retry clock;
   * the existing action/source/ownership boundary decides subsequent work. */
  private retry<T>(work: () => Promise<T>): Promise<T> {
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
  private async start() {
    const scope = await this.retry(() => this.service.runtimeScope(this.roomId));
    this.workspaceId = scope.workspaceId; this.authorityRoomId = scope.authorityRoomId;
    const budget = await this.retry(() => this.service.budget.read(this.workspaceId));
    this.meter = new VoiceAudioMeter(this.service.budget, this.callId, this.leaseOwner, this.workspaceId, budget,
      remaining => {
        this.task(() => remaining ? this.enforceBudget(remaining) : this.close());
      }, message => console.warn('[voice-budget]', message));
    const token = new AccessToken(this.service.config.apiKey, this.service.config.apiSecret,
      { identity: `beeline-voice-${this.callId}`, ttl: '1h', metadata: JSON.stringify({ kind: 'transport' }) });
    token.addGrant({ roomJoin: true, room: `beeline-voice-${this.callId}`, canPublish: true,
      canSubscribe: true, canPublishData: true });
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO) this.task(() => this.listen(track, participant), participant.identity);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => this.task(() => {
      if (this.inputs.get(participant.identity)?.track === track) this.stopInput(participant.identity);
    }, participant.identity));
    this.room.on(RoomEvent.ParticipantDisconnected, participant => this.task(() => {
      if (this.closed) return;
      if (this.inputs.get(participant.identity)?.participant === participant) this.stopInput(participant.identity);
      // A newer device with the same Beeline identity can replace this RTC
      // participant. Do not let the old socket remove its successor.
      if (!this.room.remoteParticipants.has(participant.identity)) { this.cancelResume(participant.identity); this.armAbsent(participant.identity); }
    }, participant.identity));
    this.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (!participant || topic !== VOICE_DATA_TOPIC || bytes.length > 2048) return;
      this.task(async () => {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
        if (data.type !== 'target' && data.type !== 'unpin' && data.type !== 'resume' && data.type !== 'park') return;
        await this.retry(() => this.service.access(this.roomId, participant.identity));
        if (data.type === 'target' || data.type === 'unpin') this.cancelEager(participant.identity);
        if (data.type === 'unpin') {
          this.explicitTargets.delete(participant.identity);
          this.assembler.clearAddress(participant.identity);
          await this.refresh(); return;
        }
        if (data.type === 'target') {
          const allowed = await this.retry(() => this.service.agents(this.roomId, participant.identity));
          if (!allowed.some(a => a.id === data.agentId)) return;
          this.targets.set(participant.identity, data.agentId);
          if (data.tap) {
            this.assembler.address(participant.identity, data.agentId);
            this.awaitingAnswer.delete(participant.identity);
            this.explicitTargets.set(participant.identity, data.agentId);
          }
        }
        if (data.type === 'target') { await this.refresh(); return; }
        // HTTP may land on another server; the retained RTC channel reaches
        // the owner. Durable session/state checks fence queued old packets.
        if (typeof data.sessionId !== 'string' || !(await this.retry(() => this.service.db.query(`SELECT 1 FROM voice_participants
          WHERE call_id=$1 AND identity_id=$2 AND session_id=$3 AND left_at IS NULL
          AND (parked_at IS NOT NULL)=$4`, [this.callId, participant.identity, data.sessionId, data.type === 'park']))).rowCount) return;
        if (data.type === 'park') return;
        else await this.resume(participant.identity);
      }, participant.identity);
    });
    this.room.on(RoomEvent.ParticipantConnected, participant => {
      this.cancelAbsent(participant.identity);
      this.task(async () => { await this.reconcileParticipants(); await this.countHumans(true); });
    });
    this.room.on(RoomEvent.Disconnected, () => { if (!this.closed) this.task(() => this.close()); });
    await this.room.connect(this.service.config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    this.shutdown.signal.throwIfAborted();
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('beeline-agent-speech', this.audio), options);
    this.shutdown.signal.throwIfAborted();
    this.armLeaseExpiry();
    this.armLeaseRenewal();
    await this.reconcileParticipants();
    await this.countHumans(true).catch(() => {});
    await this.refresh();
  }

  private async signal(signal: VoiceSignal, human?: string) {
    // A visual countdown must not start heartbeat work or count as activity.
    if (!this.closed) await this.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(signal)),
      { reliable: true, topic: VOICE_DATA_TOPIC, ...(human ? { destination_identities: [human] } : {}) });
  }
  private async listen(track: RemoteTrack, participant: RemoteParticipant) {
    const human = participant.identity;
    if (this.inputs.get(human)?.track === track) return;
    this.stopInput(human);
    // A new device/track needs its current countdown even within the same unit.
    this.budgetDisplay = '';
    const version = (this.inputVersions.get(human) ?? 0) + 1;
    this.inputVersions.set(human, version);
    this.turnIndices.delete(human);
    // Start buffering RTC frames immediately: waiting for the STT handshake
    // otherwise clips the first spoken name after a phone publishes its mic.
    const reader = new AudioStream(track, 16_000, 1).getReader();
    const buffered: { data: Int16Array; at: number; release(): void }[] = [];
    const releaseBuffered = () => { for (const frame of buffered) frame.release(); buffered.length = 0; };
    this.inputs.set(human, { reader, track, participant, releaseBuffered, buffered });
    let stt: VoiceStt | undefined;
    const current = () => !track.muted && !this.closed && !this.authorityPaused.has(human) && this.inputVersions.get(human) === version;
    const deliver = (admitted: Int16Array) => {
      if (!current() || performance.now() >= this.leaseValidUntil) return;
      try { stt!.send(admitted); } catch (error) { void this.failure(error, human); }
    };
    const send = (data: Int16Array, capturedAt: number) => {
      if (current()) this.meter?.capture(data, capturedAt, deliver);
    };
    // Authorization buffering shares the meter's call-wide byte/duration cap.
    const pump = (async () => {
      while (!this.closed && this.inputVersions.get(human) === version) {
        const frame = await reader.read();
        if (frame.done) break;
        if (stt) send(frame.value.data, Date.now());
        else {
          if (track.muted) continue;
          const release = this.meter?.retain(frame.value.data.length / 16, frame.value.data.byteLength);
          if (release) buffered.push({ data: frame.value.data.slice(), at: Date.now(), release });
        }
      }
    })();
    void pump.catch(error => this.failure(error, human));
    try {
      const authorityVersion = ++this.authorityRevision; this.authorityVersions.set(human, authorityVersion);
      await this.retry(() => this.service.access(this.roomId, human));
      if (this.authorityVersions.get(human) === authorityVersion && this.inputVersions.get(human) === version)
        this.authorityPaused.delete(human);
      if (!(await this.retry(() => this.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL`,
        [this.callId, human]))).rowCount) { this.stopInput(human); return; }
      const [agents, budget, contacts] = await Promise.all([
        this.retry(() => this.service.agents(this.roomId, human)), this.retry(() => this.service.budget.read(this.workspaceId)),
        this.retry(() => this.service.db.query<{ name: string }>(
          `SELECT btrim(title) AS name FROM agent_subscriptions
           WHERE room_id=$1 AND source='webhook' AND btrim(title)<>''
           GROUP BY btrim(title) ORDER BY name LIMIT 80`, [this.roomId])),
        this.refreshSpeakingSpeed(human),
      ]);
      if (this.closed || this.inputVersions.get(human) !== version) { releaseBuffered(); return; }
      this.task(() => this.enforceBudget(budget));
      if (budget.remainingMs <= 0) { this.stopInput(human); return; }
      const externalContacts = contacts.rows.map(contact => contact.name.slice(0, 80));
      this.externalContacts.set(human, externalContacts);
      const hints = [...new Set([...agents.flatMap(agent => [agent.name, agent.handle]), ...externalContacts])].slice(0, 80);
      stt = await this.service.config.stt(event => {
      const receivedAt = performance.now();
      this.task(async () => {
      if (this.inputVersions.get(human) === version && event.turn_index >= (this.turnIndices.get(human) ?? -1))
        this.observeCallerResume(human, event);
      // A resumed final still belongs to the active conversational request.
      const resumesFinal = event.event === 'TurnResumed' && event.turn_index === this.turnIndices.get(human) &&
        (!!this.assembler.current(human) || (!!this.speaking && this.speakingHuman === human));
      if (this.inputVersions.get(human) !== version ||
          (event.turn_index <= (this.turnIndices.get(human) ?? -1) && !resumesFinal)) return;
      // Reopen the STT turn even when its resumed fragment is empty or filtered.
      // Speech filters still decide whether to pause playback or classification.
      if (resumesFinal && this.assembler.current(human)) {
        this.resumedFinals.set(human, { turn: event.turn_index, text: this.assembler.current(human)!.text });
        this.turnIndices.delete(human);
      }
      if (event.event === 'TurnResumed' || event.event === 'StartOfTurn') this.cancelEager(human);
      if (event.event === 'EndOfTurn') this.humanQuiet(human);
      const recent = this.recentSpeech.filter(spoken => spoken.until > performance.now());
      let input = this.inputSpeech.get(human);
      if (input?.turn !== event.turn_index) {
        input = { turn: event.turn_index, playback: new Set() };
        this.inputSpeech.set(human, input);
      }
      for (const spoken of recent) input.playback.add(spoken.text);
      const context = [...input.playback].join(' ');
      // Retain a turn's echo context through its final, even after playout
      // ends. Missing confidence must not make a short playback noise valid.
      const acknowledgment = /^(hey|yeah|yes|yep|okay|ok|uh|huh|hmm)$/.test(speechWords(event.transcript).join(' '));
      const words = speechWords(event.transcript);
      const final = event.event === 'EndOfTurn';
      const named = voiceNameOnly(event.transcript, agents) ||
        voiceContactNameOnly(event.transcript, this.externalContacts.get(human));
      const filler = (words.length === 1 && BACKCHANNEL.test(words[0]!)) ||
        /^(mm hmm|uh huh|yeah okay)$/.test(words.join(' '));
      const answering = this.awaitingAnswer.has(human);
      // Only a completed spoken question licenses a standalone backchannel.
      // Keep meaningful final words; partials retain their interruption policy.
      const continuing = !!this.assembler.current(human) &&
        (words.length > 1 || SINGLE_WORD_REPLIES.has(words[0]!));
      const ignoredFinal = final && !named && (filler ? !answering && !continuing :
        words.length === 1 && /^(hey|i|so|and)$/.test(words[0]!));
      const strayWord = !final && words.length === 1 && !SINGLE_WORD_REPLIES.has(words[0]!) &&
        !voiceContactNameOnly(event.transcript, this.externalContacts.get(human)) &&
        !agents.some(agent => [agent.name, agent.handle].some(alias =>
          speechWords(alias).join(' ') === words[0]));
      // Filter partials too: a confident stray word must never pause or barge in.
      // Final rejection consumes the turn before it can enter request assembly.
      if (strayWord || ignoredFinal) {
        if (event.event === 'EndOfTurn') { this.cancelEager(human); this.turnIndices.set(human, event.turn_index); }
        return;
      }
      if (event.event === 'EndOfTurn' && words.length && !confirmedVoiceSpeech(event))
        console.info('[voice-speech-shadow]', JSON.stringify({ callId: this.callId, turnIndex: event.turn_index,
          transcript: event.transcript, words: event.words ?? [] }));
      const recognized = event.event === 'EndOfTurn' ? words.length > 0 : confirmedVoiceSpeech(event);
      if (!recognized || (!(final && filler && answering) && voicePlaybackEcho(event.transcript, context)) ||
          (!(final && filler && answering) && context && acknowledgment && !event.words?.length)) {
        if (event.event === 'EndOfTurn') { this.cancelEager(human); this.turnIndices.set(human, event.turn_index); }
        return;
      }
      if (event.event === 'EagerEndOfTurn') {
        this.task(() => this.prepareEager(human, event), human); return;
      }
      this.markCallActivity();
      if (event.event !== 'EndOfTurn') this.humanSpeaking.add(human);
      this.assembler.speaking(human);
      // Recognized speech fences classification even when it is too short to barge in.
      const activeRequest = this.assembler.current(human);
      let pausedReply = event.event !== 'EndOfTurn' && !!activeRequest && activeRequest.state !== 'playing' && this.speakingHuman === human;
      let liveHumans: number | undefined;
      if (event.event !== 'EndOfTurn') {
        if (activeRequest?.state === 'playing') {
          if (!voiceInterrupt(event)) liveHumans = await this.retry(() => this.service.humanCount(this.callId));
          // A final can arrive while live membership resolves. Never cancel its newer request.
          if ((liveHumans === 1 || voiceInterrupt(event)) && this.assembler.current(human) === activeRequest) {
            this.interruptPlayback(); this.assembler.pause(human); pausedReply = true;
          }
        } else {
          if (pausedReply) this.interruptPlayback();
          this.assembler.pause(human);
        }
      }
      this.task(() => this.signal({ type: 'speech' }, human), human);
      // Partial recognized names can aim the strip immediately; only EndOfTurn dispatches.
      if (event.event !== 'EndOfTurn') this.task(() => this.aimSpokenName(human, event.transcript, version), human);
      const stop = /^(stop|cancel|stop conversation|end conversation|leave conversation|stop conversation mode)$/.test(speechWords(event.transcript).join(' '));
      if (event.event === 'EndOfTurn' && event.transcript.trim() && !stop) {
        this.turnIndices.set(human, event.turn_index);
        const draft = this.assembler.current(human);
        const contacts = this.externalContacts.get(human) ?? [];
        if (draft && voiceContactNameOnly(draft.text, contacts)) {
          const contact = contacts.find(name => voiceContactNameOnly(event.transcript, [name]));
          const named = openingVoiceName(event.transcript, agents);
          if (voiceNameOnly(event.transcript, agents) || (named && named.id !== draft.agent?.id) ||
              (contact && !voiceContactNameOnly(draft.text, [contact]))) this.assembler.cancel(human, 'contact recipient changed');
          else if (contact) return;
        }
        const resumed = this.resumedFinals.get(human);
        this.resumedFinals.delete(human);
        const fragment = resumed?.turn === event.turn_index && event.transcript.startsWith(resumed.text)
          ? event.transcript.slice(resumed.text.length).trim() : event.transcript;
        const interrupts = voiceInterrupt(event);
        this.task(() => this.utterance(human, fragment, receivedAt, interrupts, confirmedVoiceSpeech(event)), human);
        return;
      }
      // With several humans, anyone may interrupt, but only with real speech.
      const humans = liveHumans ?? await this.retry(() => this.service.humanCount(this.callId));
      if (this.inputVersions.get(human) !== version || event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      const interrupts = humans === 1 || voiceInterrupt(event);
      if (interrupts && !pausedReply) this.interruptPlayback();
      if (event.event !== 'EndOfTurn' || !event.transcript.trim() ||
          event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      this.turnIndices.set(human, event.turn_index);
      if (stop) {
        this.awaitingAnswer.delete(human);
        this.cancelEager(human);
        this.assembler.cancel(human);
        this.speaking?.abort(); this.clearAudioQueue();
        return;
      }
      }, human); }, error => {
        if (this.inputVersions.get(human) !== version) return;
        this.task(() => this.failure(error, human)); this.stopInput(human);
      }, hints);
    } catch (error) {
      if (this.inputVersions.get(human) !== version) { releaseBuffered(); await reader.cancel().catch(() => {}); return; }
      this.stopInput(human); throw error;
    }
    if (this.closed || this.inputVersions.get(human) !== version) { releaseBuffered(); stt.close(); await reader.cancel().catch(() => {}); return; }
    this.inputs.set(human, { stt, reader, track, participant });
    try {
      while (buffered.length) {
        const frame = buffered.shift()!;
        if (current() && this.meter) this.meter.captureReserved(frame.data, frame.at, deliver, frame.release);
        else frame.release();
      }
      await pump;
    } finally { releaseBuffered(); if (this.inputs.get(human)?.stt === stt) this.stopInput(human); }
  }
  private stopInput(human: string) {
    this.cancelEager(human);
    this.resumedFinals.delete(human);
    this.inputVersions.set(human, (this.inputVersions.get(human) ?? 0) + 1);
    this.inputSpeech.delete(human);
    this.externalContacts.delete(human);
    this.awaitingAnswer.delete(human);
    this.speakingSpeeds.delete(human);
    this.speedRefreshes.delete(human);
    const input = this.inputs.get(human);
    if (!input) return;
    this.inputs.delete(human);
    input.releaseBuffered?.();
    this.humanQuiet(human);
    this.task(() => input.stt?.close(), human);
    this.task(() => input.reader.cancel(), human);
  }
  private async enforceBudget(budget: VoiceBudget) {
    if (this.closed || this.budgetEnding) return;
    if (budget.remainingMs > VOICE_WARNING_MS) {
      if (this.budgetDisplay) { this.budgetDisplay = ''; await this.signal({ type: 'budget', budget }); }
      return;
    }
    if (budget.remainingMs > 0) {
      const unit = budget.remainingMs >= 60_000 ? 60_000 : 1000;
      const display = `${budget.resetAt}:${unit}:${Math.ceil(budget.remainingMs / unit)}`;
      if (this.budgetDisplay === display) return;
      await this.signal({ type: 'budget', budget });
      this.budgetDisplay = display;
      return;
    }
    this.budgetEnding = true;
    try {
      if ((await this.retry(() => this.service.budget.read(this.workspaceId))).remainingMs > 0) return;
      await this.service.endWorkspaceCalls(this.workspaceId);
    } finally { this.budgetEnding = false; }
  }

  private armLeaseExpiry() {
    clearTimeout(this.leaseExpiry);
    this.leaseExpiry = setTimeout(() => this.task(() => this.close()),
      Math.max(0, this.leaseValidUntil - performance.now()));
    this.leaseExpiry.unref();
  }
  private armLeaseRenewal() {
    if (this.closed || this.leaseParked || this.leaseRenewal) return;
    // Private owner evidence only: no participant, budget or projection read.
    this.leaseRenewal = setInterval(() => this.task(() => this.renewLease()), 5000);
    this.leaseRenewal.unref();
  }
  private renewLease(): Promise<boolean> {
    if (this.closed || this.leaseParked) return Promise.resolve(false);
    if (this.leaseFlight) return this.leaseFlight;
    const requestedAt = performance.now();
    if (requestedAt < this.nextLeaseAt) return Promise.resolve(requestedAt < this.leaseValidUntil);
    this.nextLeaseAt = requestedAt + 5000;
    const admittedRecovery = this.leaseRecovery;
    let renewed = false; let failure: unknown;
    this.leaseFlight = (async () => {
      try {
        const kept = await this.retry(() => this.service.db.query(`UPDATE voice_calls SET runtime_until=clock_timestamp()+interval '15 seconds'
          WHERE id=$1 AND runtime_owner=$2 AND ended_at IS NULL AND runtime_until>clock_timestamp()`, [this.callId, this.leaseOwner]));
        if (!kept.rowCount) { await this.close(); return false; }
        if (this.closed) return false;
        this.leaseValidUntil = requestedAt + 15_000;
        this.armLeaseExpiry();
        renewed = true; return true;
      } catch (error) {
        failure = error; this.leaseParked = true;
        clearInterval(this.leaseRenewal); this.leaseRenewal = undefined;
        if (performance.now() >= this.leaseValidUntil) await this.close();
        throw error;
      }
    })().finally(() => {
      this.leaseFlight = undefined;
      if (this.leaseParked && !this.closed && this.leaseRecovery > admittedRecovery) this.resumeLeaseEvidence();
      else this.settleLeaseRecovery(renewed, failure);
    });
    return this.leaseFlight;
  }
  private async recover() {
    // One actual database recovery boundary; no health probe or failure timer.
    if (this.leaseParked || this.leaseFlight) {
      if (!await this.requestLeaseRecovery(true)) return;
    }
    await this.meter?.recover();
  }
  private requestLeaseRecovery(background: boolean): Promise<boolean> {
    this.leaseRecovery++;
    this.leaseRecoveryBackground ||= background;
    if (!this.leaseParked && !this.leaseFlight) return Promise.resolve(performance.now() < this.leaseValidUntil);
    if (!this.leaseRecoveryWait) {
      let resolve!: (value: boolean) => void; let reject!: (error: unknown) => void;
      const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      this.leaseRecoveryWait = { promise, resolve, reject };
    }
    if (!this.leaseFlight) this.resumeLeaseEvidence();
    return this.leaseRecoveryWait.promise;
  }
  private settleLeaseRecovery(renewed: boolean, error?: unknown) {
    clearTimeout(this.leaseRecoveryTimer); this.leaseRecoveryTimer = undefined;
    const waiting = this.leaseRecoveryWait; this.leaseRecoveryWait = undefined;
    this.leaseRecoveryBackground = false;
    if (error) waiting?.reject(error); else waiting?.resolve(renewed);
  }
  private resumeLeaseEvidence() {
    if (this.closed || this.leaseRecoveryTimer || !this.leaseRecoveryWait) return;
    // This wake belongs to actual recovery/Resume and enforces the control
    // quota. Its one failed attempt cannot recreate the same intent.
    this.leaseRecoveryTimer = setTimeout(() => {
      this.leaseRecoveryTimer = undefined;
      if (this.closed || !this.leaseParked) { this.settleLeaseRecovery(false); return; }
      this.leaseParked = false;
      this.task(async () => { if (await this.renewLease()) this.armLeaseRenewal(); });
    }, Math.max(0, Math.ceil(this.nextLeaseAt - performance.now())));
    this.leaseRecoveryTimer.unref();
  }

  /** Existing explicit resume action, never invoked by PCM or lease ticks. */
  private async heartbeat() {
    if (!await this.renewLease()) return;
    await this.revalidateParticipants();
    await this.reconcileParticipants();
    await this.countHumans();
    await this.refresh();
  }
  async revalidateAuthorityChange(event: Extract<LiveEvent, { type: 'invalidate' }>): Promise<void> {
    if (this.closed || !this.workspaceId) return;
    if (event.workspaceId && event.workspaceId !== this.workspaceId) return;
    if (event.roomId && event.roomId !== this.roomId && event.roomId !== this.authorityRoomId) return;
    const human = event.readerId ?? event.targetAgentId ?? event.personId;
    if (human && !this.room.remoteParticipants.has(human) && !this.inputs.has(human) && !this.participantSessions.has(human)) return;
    if (!event.roomId && !event.workspaceId) {
      // Legacy incomplete evidence cannot select a Workspace. Park only this
      // known person's input, without querying or ending other calls. A real
      // correlated source/Resume must reauthorize before any later PCM.
      if (human) {
        this.authorityVersions.set(human, ++this.authorityRevision);
        this.authorityPaused.add(human); this.cancelResume(human); this.stopInput(human);
      }
      return;
    }
    await this.revalidateParticipants(human);
  }
  async revalidateParticipants(affectedHuman?: string) {
    for (const participant of this.room.remoteParticipants.values()) {
      if (affectedHuman && participant.identity !== affectedHuman) continue;
      if (this.closed) return;
      const version = ++this.authorityRevision; this.authorityVersions.set(participant.identity, version);
      try {
        await this.retry(() => this.service.access(this.roomId, participant.identity));
        if (!this.closed && this.authorityVersions.get(participant.identity) === version) this.authorityPaused.delete(participant.identity);
      }
      catch (error) {
        if (this.closed || this.authorityVersions.get(participant.identity) !== version) continue;
        if (error instanceof Error && error.message === 'voice call access denied') {
          this.authorityPaused.add(participant.identity); this.cancelResume(participant.identity); this.stopInput(participant.identity);
          await this.service.leave(this.callId, participant.identity, true,
            this.participantSessions.get(participant.identity), undefined, this.leaseOwner);
        } else await this.failure(error, participant.identity);
      }
    }
  }

  private cancelAbsent(human: string) {
    const absent = this.absent.get(human);
    clearTimeout(absent?.timer); this.absent.delete(human);
  }
  private armAbsent(human: string) {
    if (this.closed || this.room.remoteParticipants.has(human)) return;
    const session = this.participantSessions.get(human);
    if (session === undefined) return;
    const previous = this.absent.get(human);
    if (previous?.session === session) return;
    this.cancelAbsent(human);
    const absent = { session, due: performance.now() + 120_000, attempted: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.absent.set(human, absent);
    absent.timer = setTimeout(() => {
      absent.timer = undefined;
      if (this.closed || this.absent.get(human) !== absent || absent.attempted ||
        this.participantSessions.get(human) !== absent.session || this.room.remoteParticipants.has(human)) return;
      absent.attempted = true;
      this.task(() => this.service.leave(this.callId, human, true, absent.session, undefined, this.leaseOwner), human);
    }, Math.max(0, absent.due - performance.now()));
    absent.timer.unref();
  }
  /** Startup and actual participant/card source changes own this snapshot.
   * Session IDs remain server-private and fence late device departures. */
  reconcileParticipants(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.participantsDirty = true;
    if (this.participantsRefresh) return this.participantsRefresh;
    let failed = false;
    this.participantsRefresh = (async () => {
      while (this.participantsDirty && !this.closed) {
        this.participantsDirty = false;
        try {
          const current = await this.retry(() => this.service.db.query<{ identity_id: string; session_id: string }>(
            `SELECT identity_id,session_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL LIMIT 513`, [this.callId]));
          if (this.closed) return;
          if (current.rows.length > 512) { await this.close(); throw new Error('Voice participant bound exceeded'); }
          const sessions = new Map(current.rows.map(row => [row.identity_id, row.session_id]));
          for (const human of this.participantSessions.keys()) if (!sessions.has(human)) this.participantLeft(human);
          for (const [human, intent] of this.resumeIntents) if (sessions.get(human) !== intent.session) this.cancelResume(human);
          this.participantSessions.clear();
          for (const [human, session] of sessions) {
            this.participantSessions.set(human, session);
            if (this.room.remoteParticipants.has(human)) this.cancelAbsent(human);
            else this.armAbsent(human);
          }
        } catch (error) {
          failed = true; this.participantsDirty = false; throw error;
        }
      }
    })().finally(() => {
      this.participantsRefresh = undefined;
      if (!failed && this.participantsDirty && !this.closed) this.task(() => this.reconcileParticipants());
    });
    return this.participantsRefresh;
  }
  /** Audio frames and lease traffic are not speech. Only real activity resets this window. */
  private checkInactivity(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inactivityCheck) return this.inactivityCheck;
    clearTimeout(this.quietCheck); this.quietCheck = undefined;
    this.inactivityCheck = (async () => {
      const { pending: work, finishedAt } = await this.retry(() => this.service.callWorkState(this.callId));
      if (work) this.markCallActivity();
      if (finishedAt > this.lastWorkFinishedAt) {
        this.lastWorkFinishedAt = finishedAt;
        this.endingTonePlayed = false;
        this.lastActivity = Math.max(this.lastActivity, performance.now() - Math.max(0, Date.now() - finishedAt));
      }
      const quietFor = performance.now() - this.lastActivity;
      const warning = !work && quietFor >= 45_000;
      if (warning && this.endingDeadline === null) {
        this.endingDeadline = Date.now() + Math.max(0, 60_000 - quietFor);
        await this.signal({ type: 'ending', deadline: this.endingDeadline, serverNow: Date.now() });
      } else if (!warning && this.endingDeadline !== null) {
        this.endingDeadline = null;
        await this.signal({ type: 'ending', deadline: null, serverNow: Date.now() });
      }
      if (warning && quietFor >= 50_000 && quietFor < 60_000 && !this.endingTonePlayed) {
        this.endingTonePlayed = true;
        // A warning tone is not speech and must not restart the quiet window.
        const samples = new Int16Array(Math.floor(VOICE_SAMPLE_RATE * 0.12));
        for (let i = 0; i < samples.length; i++) {
          const envelope = Math.sin(Math.PI * i / samples.length);
          samples[i] = Math.round(1800 * envelope * Math.sin(2 * Math.PI * 660 * i / VOICE_SAMPLE_RATE));
        }
        await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
      }
      const inactive = () => !this.closed && !work && performance.now() - this.lastActivity >= 60_000;
      if (inactive()) await this.service.endInactive(this.callId, this.leaseOwner, inactive);
      // Only the actual warning/tone/end boundaries own a wake. Pending work
      // waits for its committed completion; protected multi-human idle does
      // not repeatedly ask the database whether it can end.
      clearTimeout(this.quietCheck); this.quietCheck = undefined;
      const currentQuiet = performance.now() - this.lastActivity;
      if (!work && !this.closed && currentQuiet < 60_000)
        this.armInactivity(currentQuiet < 45_000 ? 45_000 : currentQuiet < 50_000 ? 50_000 : 60_000);
    })().finally(() => { this.inactivityCheck = undefined; });
    return this.inactivityCheck;
  }

  private armInactivity(afterMs = 45_000) {
    clearTimeout(this.quietCheck); this.quietCheck = undefined;
    if (this.closed) return;
    this.quietCheck = setTimeout(() => {
      this.quietCheck = undefined;
      this.task(() => this.checkInactivity());
    }, Math.max(0, this.lastActivity + afterMs - performance.now()));
    this.quietCheck.unref();
  }

  private markCallActivity() {
    this.lastActivity = performance.now();
    this.armInactivity();
    this.endingTonePlayed = false;
    if (this.endingDeadline !== null) {
      this.endingDeadline = null;
      this.task(() => this.signal({ type: 'ending', deadline: null, serverNow: Date.now() }));
    }
  }

  private clearAudioQueue() {
    // Provider cancellation can unwind after close has disposed the native handle.
    if (!this.audioDisposed) this.audio.clearQueue();
    if (this.voicedReply?.resumedAt !== undefined && this.voicedReply.clearedAt === undefined)
      this.voicedReply.clearedAt = performance.now();
  }

  private interruptPlayback() {
    this.playbackVersion++;
    this.speaking?.abort(); this.clearAudioQueue();
  }

  participantLeft(human: string) {
    this.authorityVersions.delete(human);
    this.authorityPaused.delete(human);
    this.cancelResume(human);
    this.cancelAbsent(human);
    this.participantSessions.delete(human);
    this.humanQuiet(human);
    this.assembler.cancel(human);
    this.targets.delete(human);
    this.explicitTargets.delete(human);
    this.stopInput(human);
  }

  async stopCall() { await this.signal({ type: 'stop' }); }

  private async aimSpokenName(human: string, text: string, version: number) {
    const agent = namedVoiceTarget(text, await this.retry(() => this.service.agents(this.roomId, human)), undefined, 2);
    if (!agent || this.closed || this.inputVersions.get(human) !== version) return;
    this.targets.set(human, agent.id);
    await this.signal({ type: 'target', agentId: agent.id }, human);
  }

  /** Deduplicate announcements only; mode decisions always read the database count. */
  countHumans(announce = false): Promise<void> {
    const refresh = this.humanCountRefresh.catch(() => {}).then(async () => {
      const count = await this.retry(() => this.service.humanCount(this.callId));
      const changed = count !== this.lastAnnouncedHumanCount;
      if (changed || announce) {
        await this.signal({ type: 'humans', count });
        if (this.endingDeadline !== null) await this.signal({ type: 'ending', deadline: this.endingDeadline, serverNow: Date.now() });
      }
      this.lastAnnouncedHumanCount = count;
      const humans = this.assembler.humans();
      if (humans.length) {
        const active = await this.retry(() => this.service.db.query<{identity_id: string}>(
          `SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL AND identity_id=ANY($2::text[])`,
          [this.callId, humans]));
        const joined = new Set(active.rows.map(row => row.identity_id));
        for (const human of humans) if (!joined.has(human)) this.participantLeft(human);
      }
    });
    this.humanCountRefresh = refresh;
    return refresh;
  }

  private cancelEager(human: string) {
    const draft = this.eager.get(human);
    if (draft) {
      draft.reply?.cancel(); this.eager.delete(human);
      console.info('[voice-eager]', JSON.stringify({ callId: this.callId, outcome: 'cancelled' }));
    }
  }

  private async prepareEager(human: string, event: FluxEvent) {
    // Continuation assembly and pending dispatch retries retain their existing path.
    if (this.assembler.current(human) || this.assembler.retryable(human) || this.closed) return;
    const existing = this.eager.get(human);
    if (existing?.turn === event.turn_index && existing.text === event.transcript) return;
    this.cancelEager(human);
    const draft: { turn: number; text: string; reply?: VoiceEagerReply } = { turn: event.turn_index, text: event.transcript };
    this.eager.set(human, draft);
    const agents = await this.retry(() => this.service.agents(this.roomId, human));
    const humans = await this.retry(() => this.service.humanCount(this.callId));
    const named = openingVoiceName(event.transcript, agents);
    const pinned = agents.find(agent => agent.id === this.explicitTargets.get(human));
    const tapped = agents.find(agent => agent.id === this.assembler.target(human));
    const selected = humans === 1 && !named && !pinned && !tapped
      ? await this.retry(() => this.service.lastActiveAgent(this.roomId, agents)) ?? this.targets.get(human)
      : this.targets.get(human);
    const agent = pinned ?? named ?? tapped ?? (humans === 1 ? namedVoiceTarget(event.transcript, agents, selected, humans) : undefined);
    if (!agent || voiceNameOnly(event.transcript, agents) || voiceContactNameOnly(event.transcript, this.externalContacts.get(human))) { if (this.eager.get(human) === draft) this.cancelEager(human); return; }
    const history = await this.retry(() => readVoiceContext(this.service.db, this.roomId, '', agent.id));
    const pending = [...this.pendingWork.values()].filter(work => work.agent_id === agent.id && work.human_id === human);
    if (pending.length) history.push({ role: 'user', content:
      'Call work still pending; no report or progress is available for these requests: ' + JSON.stringify(pending.map(row => row.text)) });
    history.push({ role: 'user', content: event.transcript });
    if (this.eager.get(human) !== draft || this.closed || event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
    draft.reply = new VoiceEagerReply(this.service.config.brain, agent, history, agents.map(({ name, handle }) => ({ name, handle })), this.externalContacts.get(human));
    console.info('[voice-eager]', JSON.stringify({ callId: this.callId, outcome: 'started' }));
  }

  async utterance(human: string, fragment: string, startedAt = performance.now(), interrupts = true, confirmedSpeech = true) {
    this.awaitingAnswer.delete(human);
    const speakingSpeed = this.speakingSpeeds.get(human);
    const eager = this.eager.get(human);
    this.eager.delete(human);
    this.markCallActivity();
    if (!interrupts && !this.assembler.current(human) && this.speaking && await this.retry(() => this.service.humanCount(this.callId)) > 1 &&
        !voiceNameOnly(fragment, await this.retry(() => this.service.agents(this.roomId, human))) &&
        !voiceContactNameOnly(fragment, this.externalContacts.get(human))) { eager?.reply?.cancel(); return; }
    if (interrupts) this.interruptPlayback();
    let playbackVersion = this.playbackVersion;
    const traceId = randomUUID();
    const stages = new Set<string>();
    const timing = (stage: string) => {
      if (stages.has(stage)) return;
      stages.add(stage);
      const row = { traceId, callId: this.callId, stage, elapsedMs: performance.now() - startedAt };
      if (stage === 'first_voiced_audio_published') this.voicedReply = { human, traceId, kind: 'turn', signal: controller.signal,
        firstAt: performance.now(), lastAt: performance.now() };
      console.info('[voice-turn-timing]', JSON.stringify(row));
      void Promise.resolve().then(() => this.service.recordTiming?.(row))
        .catch(error => captureServerError(error, { surface: 'voice-timing' }));
    };
    timing('flux_final');
    const failed = this.assembler.retryable(human);
    const retry = failed?.state === 'retryable' && /^(retry|try again|retry that)[.!?]*$/i.test(fragment.trim());
    const { request, previous } = retry ? { request: failed, previous: undefined } : this.assembler.begin(human, fragment);
    if (retry) request.classification = new AbortController();
    const generation = request.classification;
    const controller = new AbortController();
    const pausePlayback = () => {
      console.info('[voice-draft-cancelled]', JSON.stringify({ traceId, callId: this.callId,
        reason: generation.signal.reason ?? 'superseded', elapsedMs: performance.now() - startedAt }));
      controller.abort();
    };
    generation.signal.addEventListener('abort', pausePlayback, { once: true });
    const stop = () => { generation.abort('call closed'); controller.abort(); };
    this.shutdown.signal.addEventListener('abort', stop, { once: true });
    let resolveSource!: (id: string) => void;
    let rejectSource!: (error: unknown) => void;
    const priorSource = request.source;
    if (!retry) {
      request.source = new Promise<string>((resolve, reject) => { resolveSource = resolve; rejectSource = reject; });
      void request.source.catch(() => {});
    }
    let finishSpeech: (() => void) | undefined;
    let delivered = false;
    const completions: Promise<void>[] = [];
    let answerToRecord: { agentId: string; text: string } | undefined;
    let answerRecorded = false;
    let opening: VoiceSpeechPrefetch | undefined;
    let committedSourceId: string | undefined;
    let finalRoutesMentions = true;
    const recordSpoken = (agentId: string, text: string, final = false) => {
      const write = this.spokenWrites.then(() => this.service.recordAnswer(this.roomId, agentId, text, {
        replyId: final ? request.id : undefined, sourceId: final ? committedSourceId : undefined, routeMentions: final && finalRoutesMentions,
      }));
      this.spokenWrites = write.catch(() => {});
      completions.push(write);
    };
    const recordAnswer = () => {
      if (answerToRecord && !answerRecorded) {
        answerRecorded = true;
        recordSpoken(answerToRecord.agentId, answerToRecord.text, true);
      }
    };
    try {
      const roomMembers = this.service.memberNames
        ? this.retry(() => this.service.memberNames(this.roomId)).catch(() => []) : Promise.resolve([]);
      const agents = await this.retry(() => this.service.agents(this.roomId, human));
      const humans = await this.retry(() => this.service.humanCount(this.callId));
      if (humans === 1 && !interrupts && confirmedSpeech) { this.interruptPlayback(); playbackVersion = this.playbackVersion; }
      const members: SpeechMember[] = [...agents.map(agent => ({ handle: agent.handle, name: agent.name })), ...await roomMembers];
      let sourceId = retry ? await request.source : previous ? await priorSource : '';
      const named = openingVoiceName(fragment, agents);
      const pinned = agents.find(agent => agent.id === this.explicitTargets.get(human));
      const tapped = pinned ?? agents.find(agent => agent.id === this.assembler.target(human));
      let selected = request.agent?.id ?? this.targets.get(human);
      if (humans === 1 && !previous && !named && !tapped && !retry)
        selected = await this.retry(() => this.service.lastActiveAgent(this.roomId, agents)) ?? selected;
      const changedTarget = previous?.agent && this.targets.get(human) !== previous.agent.id
        ? agents.find(agent => agent.id === this.targets.get(human)) : undefined;
      const agent = retry ? request.agent : pinned ?? named ?? tapped ?? changedTarget ?? request.agent ?? openingVoiceName(request.text, agents) ??
        (humans === 1 ? namedVoiceTarget(request.text, agents, selected, humans) : undefined);
      if (generation.signal.aborted || this.closed) { resolveSource?.(sourceId); return; }
      if (!agent) {
        resolveSource?.(''); this.assembler.finish(human, request);
        await this.safeSignal({ type: 'unaddressed' }, human); return;
      }
      request.agent = agent;
      this.targets.set(human, agent.id);
      await this.safeSignal({ type: 'target', agentId: agent.id }, human);
      if (voiceNameOnly(fragment, agents) && !previous && !retry) {
        this.assembler.finish(human, request);
        this.assembler.address(human, agent.id);
        resolveSource(''); return;
      }
      // Read the bounded room window alongside the human write, never after it.
      const context = this.retry(() => readVoiceContext(this.service.db, this.roomId, sourceId || request.id, agent.id));
      void context.catch(() => {});
      if (!retry) {
        if (sourceId) await this.retry(() => this.service.reviseHuman(this.callId, this.roomId, human, agent, sourceId, request.text, this.leaseOwner));
        else sourceId = await this.retry(() => this.service.recordHuman(this.callId, this.roomId, human, agent, request.text, this.leaseOwner, request.id));
        resolveSource(sourceId);
      }
      if (voiceContactNameOnly(fragment, this.externalContacts.get(human)) && !previous && !retry) {
        // Retain the recorded contact draft so the next phrase includes its recipient.
        this.assembler.waitForContact(human, request);
        this.assembler.address(human, agent.id);
        return;
      }
      committedSourceId = sourceId;
      timing('human_committed');
      if (generation.signal.aborted || this.closed || !sourceId) return;
      const history = await context;
      if (generation.signal.aborted || this.closed) return;
      const pending = [...this.pendingWork.values()].filter(work => work.agent_id === agent.id && work.human_id === human);
      const brainHistory = [...history];
      if (pending.length) brainHistory.push({ role: 'user', content:
        'Call work still pending; no report or progress is available for these requests: ' + JSON.stringify(pending.map(row => row.text)) });
      brainHistory.push({ role: 'user', content: request.text });
      request.state = 'classifying';
      timing('brain_request');
      // Synthesis overlaps generation, but audio stays private until the final
      // route and exact cleaned phrase are known. Work still commits before sound.
      const openingStream = new MarkdownSpeechStream(members);
      let openingText = '';
      let openingSkipped = false;
      let streamed = false;
      let firstAudio = false;
      const brain: VoiceBrain = { answer: (selectedAgent, selectedHistory, delta, signal, search) => {
        if (eager?.text === request.text && search && eager.reply?.matches(selectedAgent, selectedHistory, search.agents, search.externalContacts)) {
          console.info('[voice-eager]', JSON.stringify({ traceId, callId: this.callId, outcome: 'used' }));
          return eager.reply.consume(delta, search, signal);
        }
        eager?.reply?.cancel();
        return this.service.config.brain.answer(selectedAgent, selectedHistory, delta, signal, search);
      } };
      const reply = retry ? { order: true, text: "Checking. I’ll tell you when I have it." } :
        await brain.answer(agent, brainHistory, delta => {
          if (!delta) return;
          streamed = true; timing('brain_first_token');
          if (opening || openingSkipped || generation.signal.aborted) return;
          openingText += delta;
          if (openingText.length > 240 || /[\[\]()*_`~@#>|\n]/.test(openingText)) { openingSkipped = true; return; }
          const phrase = openingStream.push(delta)[0];
          if (!phrase || phrase.length > 240) return;
          const text = markdownToSpeech(cleanVoiceReply(phrase, agent.name), members);
          if (!text) return;
          const service = this.service; const thisRoom = this.roomId;
          opening = new VoiceSpeechPrefetch(text, AbortSignal.any([generation.signal, controller.signal]), async function* (signal) {
            const speech = await service.speech(thisRoom);
            signal.throwIfAborted();
            timing('tts_prefetch_request');
            yield* speech.synthesize(text, agent.voice, signal);
          });
        }, generation.signal, {
          agents: agents.map(({ name, handle }) => ({ name, handle })),
          externalContacts: this.externalContacts.get(human),
          diagnostic: metadata => console.info('[voice-brain-trace]', JSON.stringify({ traceId, callId: this.callId, ...metadata })),
          search: (search, signal) => {
            console.info('[voice-router-decision]', JSON.stringify({ traceId, callId: this.callId, decision: search.name }));
            return this.service.search(this.callId, sourceId, agent.id, search, signal);
          },
          announce: async text => {
            text = cleanVoiceReply(text, agent.name);
            if (!text || this.humanSpeaking.has(human) || generation.signal.aborted || this.closed || this.speaking || playbackVersion !== this.playbackVersion) return;
            this.speaking = controller; this.speakingHuman = human;
            this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
            let recorded = false;
            try {
              await this.safeSignal({ type: 'speaker', agentId: agent.id });
              // A lookup acknowledgement leaves the caller's request editable.
              await this.play(text, agent, controller.signal, () => {
                if (!recorded) { recorded = true; recordSpoken(agent.id, text); }
                if (firstAudio) return;
                firstAudio = true; timing('first_voiced_audio_published');
                this.task(() => this.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt }));
              }, () => { generation.signal.throwIfAborted(); }, timing, members, undefined, speakingSpeed);
            } finally {
              if (this.speaking === controller) {
                this.speaking = undefined;
                await this.safeSignal({ type: 'speaker', agentId: null });
              }
              finishSpeech?.();
            }
          },
        });
      finalRoutesMentions = !reply.order;
      timing('brain_complete');
      console.info('[voice-router-decision]', JSON.stringify({ traceId, callId: this.callId, decision: reply.order ? 'order' : 'answer' }));
      if (generation.signal.aborted || this.closed) return;
      let committed = false;
      const commitReply = async () => {
        if (committed) return;
        if (generation.signal.aborted || this.closed || this.humanSpeaking.has(human))
          throw new DOMException('Interrupted', 'AbortError');
        committed = true;
        if (!reply.order) request.state = 'playing';
        if (reply.order) {
          // Accepted work cannot be revised or dispatched again by later speech.
          this.assembler.finish(human, request);
          request.state = 'delivering';
          try { await this.retry(() => this.service.dispatch(this.callId, sourceId, agent.id)); }
          catch (error) { this.assembler.retainFailure(human, request); throw error; }
          this.pendingWork.set(sourceId, { text: request.text, agent_id: agent.id, human_id: human });
          delivered = true;
          timing('delivery_committed');
        }
      };
      if (generation.signal.aborted || this.closed) return;
      request.state = 'replying';
      const answer = cleanVoiceReply(reply.text, agent.name) || (reply.order ? "Checking. I’ll tell you when I have it." : '');
      answerToRecord = {agentId: agent.id, text: answer};
      // A different speaker may have taken the audio lane during classification.
      if (this.humanSpeaking.has(human) || controller.signal.aborted || this.closed || (this.speaking && !this.speaking.signal.aborted) || playbackVersion !== this.playbackVersion) {
        // Another speaker can suppress acknowledgement audio, never accepted work.
        if (reply.order && !generation.signal.aborted && !this.closed && !this.humanSpeaking.has(human)) await commitReply();
        return;
      }
      this.speaking = controller; this.speakingHuman = human;
      this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
      await this.safeSignal({ type: 'speaker', agentId: agent.id });
      if (controller.signal.aborted || this.closed) {
        if (reply.order && !generation.signal.aborted && !this.closed && !this.humanSpeaking.has(human)) await commitReply();
        return;
      }
      const stream = new MarkdownSpeechStream(members);
      const phrases = streamed ? [...stream.push(answer), stream.finish()] : [answer];
      if (opening?.text !== markdownToSpeech(cleanVoiceReply(phrases[0] ?? '', agent.name), members)) {
        opening?.cancel(); opening = undefined;
      }
      try {
        for (const phrase of phrases) {
          if (!phrase.trim()) continue;
          if (controller.signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
          await this.play(phrase, agent, controller.signal, () => {
            recordAnswer();
            if (firstAudio) return;
            firstAudio = true; timing('first_voiced_audio_published');
            this.task(() => this.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt }));
          }, commitReply, timing, members, opening, speakingSpeed);
          opening = undefined;
        }
      } catch (error) {
        if (reply.order && !generation.signal.aborted && !this.closed && !this.humanSpeaking.has(human)) await commitReply();
        throw error;
      }
      // Empty or failed synthesis must not drop an accepted work request.
      if (reply.order && !committed) await commitReply();
      if (!controller.signal.aborted && /[?？]["'”’)*_\s]*$/.test(answer)) this.awaitingAnswer.add(human);
      // Keep a conversational request editable while its audio is playing.
      if (!reply.order && !generation.signal.aborted) this.assembler.finish(human, request);
    } catch (error) {
      rejectSource?.(error);
      // Assembler cancellation reasons are strings, not AbortError instances.
      if (generation.signal.aborted && error === generation.signal.reason) return;
      if (!delivered && request.state !== 'replying' && request.state !== 'retryable' && !(generation.signal.aborted && error instanceof Error && error.name === 'AbortError'))
        this.assembler.finish(human, request);
      if (delivered && !(error instanceof Error && error.name === 'AbortError')) throw new DeliveredVoicePlaybackError(error);
      throw error;
    } finally {
      eager?.reply?.cancel();
      opening?.cancel();
      controller.abort();
      try {
        if (this.speaking === controller) {
          this.speaking = undefined;
          this.clearAudioQueue();
          await this.safeSignal({ type: 'speaker', agentId: null });
        }
      } finally {
        finishSpeech?.();
        this.shutdown.signal.removeEventListener('abort', stop);
        generation.signal.removeEventListener('abort', pausePlayback);
        this.finishVoicedReply(controller.signal);
        await Promise.all(completions);
      }
    }
  }

  /** Match actual command provenance, never agent thought/draft events. No work deadline. */
  async refresh() {
    if (this.closed || this.refreshPending) return;
    this.refreshPending = true;
    try {
      // Hydrate on lease acquisition; this runtime records every subsequent dispatch.
      // Transcript invalidations with no outstanding work need no work query.
      if (!this.workHydrated || this.pendingWork.size) {
        const known = new Set(this.pendingWork.keys());
        const pending = await this.retry(() => this.service.db.query<{ source_message_id: string; text: string; agent_id: string; human_id: string }>(
          `SELECT source.text,o.source_message_id,o.agent_id,source.author_id human_id FROM voice_orders o
           JOIN messages source ON source.id=o.source_message_id
           JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
           WHERE o.call_id=$1 AND c.state IN ('pending','claimed') ORDER BY c.created_at`, [this.callId]));
        for (const id of known) this.pendingWork.delete(id);
        for (const row of pending.rows) this.pendingWork.set(row.source_message_id, row);
        this.workHydrated = true;
      }
      const reports = await this.retry(() => this.service.db.query<{ source_message_id: string; id: string; text: string; agent_id: string; human_id: string }>(
        `SELECT DISTINCT ON (o.source_message_id) o.source_message_id,m.id,m.text,o.agent_id,source.author_id human_id
         FROM voice_orders o JOIN messages source ON source.id=o.source_message_id
         JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
         JOIN messages m ON m.author_id=o.agent_id AND m.room_id=$2
           AND (m.id=c.result_message_id OR m.request_id=c.id OR m.request_id=c.turn_request_id)
         WHERE o.call_id=$1 AND o.spoken_message_id IS NULL AND m.presentation='message' AND m.deleted_at IS NULL
         ORDER BY o.source_message_id,m.created_at DESC`, [this.callId, this.roomId]));
      for (const report of reports.rows) {
        if (this.queuedReports.has(report.source_message_id)) continue;
        this.queuedReports.add(report.source_message_id);
        this.reportQueue = this.reportQueue.catch(() => {}).then(async () => {
          try {
            await this.waitForQuiet();
            const agent = (await this.retry(() => this.service.agents(this.roomId))).find(a => a.id === report.agent_id);
            if (this.closed) return;
            const members: SpeechMember[] = this.service.memberNames
              ? await this.retry(() => this.service.memberNames(this.roomId)).catch(() => []) : [];
            // Claim before playback so interruptions and lease handoffs cannot replay the opening.
            const claimed = await this.service.db.query(`UPDATE voice_orders o SET spoken_message_id=$2
              FROM voice_calls c WHERE o.source_message_id=$1 AND o.spoken_message_id IS NULL
                AND c.id=o.call_id AND c.runtime_owner=$3 AND c.runtime_until>now() AND c.ended_at IS NULL`,
              [report.source_message_id, report.id, this.leaseOwner]);
            if (!claimed.rowCount) return;
            // A new utterance may have started during the asynchronous claim.
            await this.waitForQuiet();
            if (this.closed) return;
            let present = false;
            do {
              await this.waitForQuiet();
              if (this.closed) return;
              present = !!(await this.service.db.query(`SELECT 1 FROM voice_participants
                WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL AND parked_at IS NULL`,
                [this.callId, report.human_id])).rowCount;
            } while (this.speaking || this.humanSpeaking.size);
            if (this.closed || !agent || !present || !this.room.remoteParticipants.has(report.human_id) ||
                this.targets.get(report.human_id) !== report.agent_id) return;
            const controller = new AbortController(); this.speaking = controller; this.speakingHuman = report.human_id;
            let finishSpeech!: () => void;
            this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
            try {
              this.awaitingAnswer.delete(report.human_id);
              await this.signal({ type: 'speaker', agentId: agent.id }); await this.play(spokenReport(cleanVoiceReply(report.text, agent.name)), agent, controller.signal, () => {
                this.voicedReply = { human: report.human_id, traceId: report.id, kind: 'report', signal: controller.signal,
                  firstAt: performance.now(), lastAt: performance.now() };
                const request = this.assembler.current(report.human_id);
                if (request?.id === report.source_message_id) this.assembler.finish(report.human_id, request);
              }, undefined, undefined, members, undefined, this.speakingSpeeds.get(report.human_id));
              if (!controller.signal.aborted && /[?？]["'”’)*_\s]*$/.test(spokenReport(cleanVoiceReply(report.text, agent.name))))
                this.awaitingAnswer.add(report.human_id);
            } finally { controller.abort(); finishSpeech(); if (this.speaking === controller) { this.clearAudioQueue(); this.speaking = undefined; await this.safeSignal({ type: 'speaker', agentId: null }); } this.finishVoicedReply(controller.signal); }
          } finally { this.queuedReports.delete(report.source_message_id); }
        });
        const queued = this.reportQueue;
        this.task(() => queued);
      }
    } finally { this.refreshPending = false; await this.checkInactivity(); }
  }

  private async play(text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void,
    onFirstVoicedFrame?: () => void | Promise<void>, timing?: (stage: string) => void, members?: SpeechMember[], opening?: VoiceSpeechPrefetch, speakingSpeed?: number) {
    text = markdownToSpeech(cleanVoiceReply(text, agent.name), members);
    if (!text) return;
    let pending = Buffer.alloc(0); let first = true; let firstByte = true; let firstPublished = true;
    // 20ms mono frames. Carry odd byte boundaries between provider chunks.
    const frameBytes = VOICE_SAMPLE_RATE / 50 * 2;
    const [speech, playbackAgents] = await Promise.all([
      this.service.speech(this.roomId), this.retry(() => this.service.agents(this.roomId)),
    ]);
    // A settings change applies to the next playback with that provider's own timbre.
    const current = playbackAgents.find(a => a.id === agent.id);
    const voice = current?.voice ?? agent.voice;
    if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
    const cancelOpening = () => opening?.cancel();
    signal.addEventListener('abort', cancelOpening, { once: true });
    const spoken = { text: text.trim(), until: Infinity };
    this.recentSpeech.push(spoken);
    if (this.recentSpeech.length > 12) this.recentSpeech.shift();
    try {
      timing?.('tts_request');
      if (voice !== agent.voice) { opening?.cancel(); opening = undefined; }
      for await (const bytes of voiceTempo(opening ? opening.read() : speech.synthesize(spoken.text, voice, signal), speakingSpeed)) {
        if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
        if (firstByte && bytes.length) { firstByte = false; timing?.('tts_first_byte'); }
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= frameBytes) {
          if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
          const samples = new Int16Array(frameBytes / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
          pending = pending.subarray(frameBytes);
          this.markCallActivity();
            const voiced = first && samples.some(sample => Math.abs(sample) > VOICE_PCM_THRESHOLD);
          if (voiced) { first = false; await onFirstVoicedFrame?.(); }
          if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
          await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
          if (this.voicedReply?.signal === signal) this.voicedReply.lastAt = performance.now();
          if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
          if (!signal.aborted && !this.closed && voiced) onFirstAudio?.();
        }
      }
      if (pending.length > 1) {
        const samples = new Int16Array(Math.floor(pending.length / 2));
        for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
        this.markCallActivity();
        const voiced = first && samples.some(sample => Math.abs(sample) > VOICE_PCM_THRESHOLD);
        if (voiced) { first = false; await onFirstVoicedFrame?.(); }
        if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
        await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
        if (this.voicedReply?.signal === signal) this.voicedReply.lastAt = performance.now();
        if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
        if (!signal.aborted && !this.closed && voiced) onFirstAudio?.();
      }
      await this.audio.waitForPlayout();
    } finally {
      signal.removeEventListener('abort', cancelOpening);
      opening?.cancel();
      spoken.until = performance.now() + 1500;
    }
  }

  get isClosed() { return this.closed; }

  private cancelResume(human: string) {
    this.resumeIntents.get(human)?.controller.abort();
    if (!this.leaseRecoveryBackground && ![...this.resumeIntents.values()].some(intent => !intent.controller.signal.aborted))
      this.settleLeaseRecovery(false);
  }
  resume(human: string): Promise<void> {
    const existing = this.resumeIntents.get(human);
    if (existing && !existing.controller.signal.aborted) return existing.promise!;
    const participant = this.room.remoteParticipants.get(human);
    if (!participant || this.closed) return Promise.reject(new Error('voice transport disconnected'));
    const intent = { participant, session: this.participantSessions.get(human), controller: new AbortController(),
      promise: undefined as Promise<void> | undefined };
    this.resumeIntents.set(human, intent);
    intent.promise = (async () => {
      let stop!: () => void;
      const canceled = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new DOMException('Voice Resume source changed', 'AbortError'));
        intent.controller.signal.addEventListener('abort', stop, { once: true });
      });
      try {
        const evidence = this.leaseParked || this.leaseFlight ? this.requestLeaseRecovery(false) : this.renewLease();
        const owned = await Promise.race([evidence, canceled]);
        const current = () => !this.closed && !intent.controller.signal.aborted &&
          this.room.remoteParticipants.get(human) === participant && this.participantSessions.get(human) === intent.session;
        if (!owned || !current()) throw new DOMException('Voice Resume source changed', 'AbortError');
        await this.revalidateParticipants();
        if (!current()) throw new DOMException('Voice Resume source changed', 'AbortError');
        for (const publication of participant.trackPublications.values()) {
          if (publication.track?.kind === TrackKind.KIND_AUDIO) this.task(() => this.listen(publication.track!, participant), human);
        }
        await this.refresh();
        if (current() && !this.speaking) await this.signal({ type: 'speaker', agentId: null }, human);
      } finally { intent.controller.signal.removeEventListener('abort', stop); }
    })().finally(() => { if (this.resumeIntents.get(human) === intent) this.resumeIntents.delete(human); });
    return intent.promise;
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    for (const input of this.inputs.values()) input.releaseBuffered?.();
    for (const human of this.resumeIntents.keys()) this.cancelResume(human);
    this.settleLeaseRecovery(false);
    for (const resolve of this.quietWaiters) resolve();
    this.quietWaiters.clear();
    clearInterval(this.leaseRenewal);
    clearTimeout(this.leaseExpiry);
    clearTimeout(this.leaseRecoveryTimer);
    clearTimeout(this.quietCheck);
    this.shutdown.abort();
    for (const human of this.eager.keys()) this.cancelEager(human);
    this.assembler.close();
    // Closing the meter revokes queued callbacks synchronously. Attach the
    // error observer immediately even if transport disposal subsequently waits.
    const meterClose = Promise.resolve(this.meter?.close()).catch(error => {
      captureServerError(error, { surface: 'voice-cleanup' });
    });
    this.closeWork = this.finishClose(meterClose);
    return this.closeWork;
  }
  private async finishClose(meterClose: Promise<void>) {
    const cleanup = async (work: () => unknown) => {
      try { await work(); } catch (error) { captureServerError(error, { surface: 'voice-cleanup' }); }
    };
    await cleanup(() => { this.speaking?.abort(); this.clearAudioQueue(); });
    this.recoveryRelease?.();
    for (const human of this.absent.keys()) this.cancelAbsent(human);
    this.participantSessions.clear();
    for (const human of this.inputs.keys()) await cleanup(() => this.stopInput(human));
    await meterClose;
    await cleanup(() => this.room.disconnect());
    this.audioDisposed = true;
    await cleanup(() => this.audio.close());
    await cleanup(() => this.spokenWrites);
    await cleanup(() => this.service.db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1 AND runtime_owner=$2`,
      [this.callId, this.leaseOwner]));
    await cleanup(() => this.service.runtimeClosed(this.callId, this));
    await cleanup(() => this.service.db.query(`UPDATE messages SET card=card WHERE id=(
      SELECT message_id FROM voice_calls WHERE id=$1 AND ended_at IS NULL)`, [this.callId]));
  }
}
