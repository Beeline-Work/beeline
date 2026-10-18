import { captureServerError } from './sentry.js';
import { VoiceAudioMeter, VOICE_WARNING_MS } from './voice-budget.js';
import { randomUUID } from 'node:crypto';
import { markdownToSpeech, MarkdownSpeechStream, type SpeechMember } from './markdown-to-speech.js';
import { AccessToken } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';
import { VOICE_DATA_TOPIC, type VoiceSignal, type VoiceBudget } from '@beeline/api-contract/phone';
import type { VoiceService } from './voice-service.js';
import { VOICE_SAMPLE_RATE, VoiceQuotaError, type VoiceAgent, type VoiceStt, type FluxEvent } from './voice-providers.js';

import { VoiceRequestAssembler, voiceNameOnly } from './voice-request-assembler.js';
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

/** Only known transport/database failures are retryable, never arbitrary operations. */
async function retryVoice<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await work(); } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      const transient = !!code && /^(08|40|53|57P0|ECONN|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code) ||
        error instanceof Error && /^(Connection terminated (unexpectedly|due to connection timeout)|Connection ended unexpectedly)$/.test(error.message);
      if (attempt === 2 || !transient) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); },
          [250, 1000][attempt]! * (0.8 + Math.random() * 0.4));
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

/** One lease-bound call runtime. Real agents continue outside this audio turn. */
export class VoiceRoomRuntime {
  private readonly room = new Room();
  private readonly audio = new AudioSource(VOICE_SAMPLE_RATE, 1, 100);
  private readonly inputs = new Map<string, { stt?: VoiceStt; reader: ReadableStreamDefaultReader<AudioFrame>;
    track: RemoteTrack; participant: RemoteParticipant }>();
  private meter?: VoiceAudioMeter;
  private workspaceId = '';
  private budgetDisplay = '';
  private budgetEnding = false;
  private readonly recentSpeech: { text: string; until: number }[] = [];
  private readonly targets = new Map<string, string>();
  private readonly turnIndices = new Map<string, number>();
  private readonly inputVersions = new Map<string, number>();
  private readonly inputSpeech = new Map<string, { turn: number; playback: Set<string> }>();
  private readonly assembler = new VoiceRequestAssembler();
  private readonly shutdown = new AbortController();
  private lastAnnouncedHumanCount?: number;
  private humanCountRefresh = Promise.resolve();
  private speaking?: AbortController;
  private playbackVersion = 0;
  private speechIdle = Promise.resolve();
  private lastActivity = performance.now();
  private lastWorkFinishedAt = 0;
  private endingDeadline: number | null = null;
  private endingTonePlayed = false;
  private quietCheck?: ReturnType<typeof setInterval>;
  private checkingInactivity = false;
  private lastTouch = 0;
  private touching = false;
  private leaseExpiry?: ReturnType<typeof setTimeout>;
  private leaseRenewal?: ReturnType<typeof setInterval>;
  private closed = false;
  private leaseValidUntil = 0;
  private refreshPending = false;
  private reportQueue = Promise.resolve();
  private readonly queuedReports = new Set<string>();
  private readonly history = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();
  private readonly missingSince = new Map<string, number>();
  private constructor(private readonly service: VoiceService, readonly callId: string, readonly roomId: string, private readonly leaseOwner: string) {}

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
  private retry<T>(work: () => Promise<T>): Promise<T> { return retryVoice(work, this.shutdown.signal); }

  static async connect(service: VoiceService, callId: string, roomId: string, leaseOwner: string = service.owner) {
    const runtime = new VoiceRoomRuntime(service, callId, roomId, leaseOwner);
    try {
      if (!await runtime.renewLease()) throw new Error('Voice call ownership expired');
      await runtime.start(); return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
  private async start() {
    this.workspaceId = await this.retry(() => this.service.workspaceId(this.roomId));
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
      if (!this.room.remoteParticipants.has(participant.identity) && !this.missingSince.has(participant.identity))
        this.missingSince.set(participant.identity, performance.now());
    }, participant.identity));
    this.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (!participant || topic !== VOICE_DATA_TOPIC || bytes.length > 2048) return;
      this.task(async () => {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
        if (data.type !== 'target' && data.type !== 'resume' && data.type !== 'park') return;
        await this.retry(() => this.service.access(this.roomId, participant.identity));
        if (data.type === 'target') {
          const allowed = await this.retry(() => this.service.agents(this.roomId, participant.identity));
          if (!allowed.some(a => a.id === data.agentId)) return;
          this.targets.set(participant.identity, data.agentId);
          if (data.tap) this.assembler.address(participant.identity, data.agentId);
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
    this.room.on(RoomEvent.ParticipantConnected, () => { this.task(() => this.countHumans(true)); });
    this.room.on(RoomEvent.Disconnected, () => { if (!this.closed) this.task(() => this.close()); });
    await this.room.connect(this.service.config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    this.shutdown.signal.throwIfAborted();
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('beeline-agent-speech', this.audio), options);
    this.shutdown.signal.throwIfAborted();
    // RTC ownership outlives audio activity, including a parked pending order.
    // Sweep missing humans even when no audio or signals arrive.
    // Committed events still drive report reads.
    this.armLeaseExpiry();
    this.leaseRenewal = setInterval(() => {
      this.task(async () => {
        if (await this.renewLease()) await this.sweepMissingParticipants();
      });
    }, 5000);
    this.leaseRenewal.unref();
    this.quietCheck = setInterval(() => this.task(() => this.checkInactivity()), 1000);
    this.quietCheck.unref();
    this.touch();
    await this.countHumans(true).catch(() => {});
    await this.refresh();
  }

  private async signal(signal: VoiceSignal, human?: string) {
    // A visual countdown must not start heartbeat work or count as activity.
    if (signal.type !== 'stop' && signal.type !== 'ending') this.touch();
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
    this.inputs.set(human, { reader, track, participant });
    let stt: VoiceStt | undefined;
    const send = (data: Int16Array, capturedAt: number) => {
      if (track.muted) return;
      const allowed = this.meter?.audio(data.length / 16, capturedAt) ?? 0;
      if (allowed > 0) stt!.send(data.subarray(0, Math.min(data.length, Math.floor(allowed * 16))));
    };
    // Drain the SDK continuously while opening STT; retain at most two seconds.
    const buffered: { data: Int16Array; at: number }[] = [];
    const pump = (async () => {
      while (!this.closed && this.inputVersions.get(human) === version) {
        const frame = await reader.read();
        if (frame.done) break;
        this.touch();
        if (stt) send(frame.value.data, Date.now());
        else {
          buffered.push({ data: frame.value.data.slice(), at: Date.now() });
          if (buffered.length > 100) buffered.shift();
        }
      }
    })();
    void pump.catch(error => this.failure(error, human));
    try {
      await this.retry(() => this.service.access(this.roomId, human));
      if (!(await this.retry(() => this.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL`,
        [this.callId, human]))).rowCount) { this.stopInput(human); return; }
      const [agents, budget] = await Promise.all([
        this.retry(() => this.service.agents(this.roomId, human)), this.retry(() => this.service.budget.read(this.workspaceId)),
      ]);
      if (this.closed || this.inputVersions.get(human) !== version) return;
      this.task(() => this.enforceBudget(budget));
      if (budget.remainingMs <= 0) { this.stopInput(human); return; }
      const hints = agents.flatMap(agent => [agent.name, agent.handle]);
      stt = await this.service.config.stt(event => { this.task(async () => {
      if (this.inputVersions.get(human) !== version ||
          event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
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
      if (!confirmedVoiceSpeech(event) || voicePlaybackEcho(event.transcript, context) ||
          (context && acknowledgment && !event.words?.length)) {
        if (event.event === 'EndOfTurn') this.turnIndices.set(human, event.turn_index);
        return;
      }
      this.markCallActivity();
      this.assembler.speaking(human);
      this.task(() => this.signal({ type: 'speech' }, human), human);
      // Partial recognized names can aim the strip immediately; only EndOfTurn dispatches.
      if (event.event !== 'EndOfTurn') this.task(() => this.aimSpokenName(human, event.transcript, version), human);
      const stop = /^(stop|cancel|stop conversation|end conversation|leave conversation|stop conversation mode)$/.test(speechWords(event.transcript).join(' '));
      if (event.event === 'EndOfTurn' && event.transcript.trim() && !stop) {
        this.turnIndices.set(human, event.turn_index);
        const interrupts = voiceInterrupt(event);
        this.task(() => this.utterance(human, event.transcript, performance.now(), interrupts), human);
        return;
      }
      // With several humans, anyone may interrupt, but only with real speech.
      const humans = await this.retry(() => this.service.humanCount(this.callId));
      if (this.inputVersions.get(human) !== version || event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      const interrupts = humans === 1 || voiceInterrupt(event);
      if (interrupts) {
        if (event.event !== 'EndOfTurn') this.assembler.pause(human);
        this.interruptPlayback();
      }
      if (event.event !== 'EndOfTurn' || !event.transcript.trim() ||
          event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      this.turnIndices.set(human, event.turn_index);
      if (stop) {
        this.assembler.cancel(human);
        this.speaking?.abort(); this.audio.clearQueue();
        return;
      }
      }, human); }, error => {
        if (this.inputVersions.get(human) !== version) return;
        this.task(() => this.failure(error, human)); this.stopInput(human);
      }, hints);
    } catch (error) {
      if (this.inputVersions.get(human) !== version) { await reader.cancel().catch(() => {}); return; }
      this.stopInput(human); throw error;
    }
    if (this.closed || this.inputVersions.get(human) !== version) { stt.close(); await reader.cancel().catch(() => {}); return; }
    this.inputs.set(human, { stt, reader, track, participant });
    try {
      for (const frame of buffered) send(frame.data, frame.at);
      buffered.length = 0;
      await pump;
    } finally { if (this.inputs.get(human)?.stt === stt) this.stopInput(human); }
  }
  private stopInput(human: string) {
    this.inputVersions.set(human, (this.inputVersions.get(human) ?? 0) + 1);
    this.inputSpeech.delete(human);
    const input = this.inputs.get(human);
    if (!input) return;
    this.inputs.delete(human);
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

  private touch() {
    if (this.closed || this.touching || performance.now() - this.lastTouch < 5000) return;
    this.lastTouch = performance.now(); this.touching = true;
    this.task(async () => { try { await this.heartbeat(); } finally { this.touching = false; } });
  }
  private armLeaseExpiry() {
    clearTimeout(this.leaseExpiry);
    this.leaseExpiry = setTimeout(() => this.task(() => this.close()),
      Math.max(0, this.leaseValidUntil - performance.now()));
    this.leaseExpiry.unref();
  }
  private async renewLease() {
    if (this.closed) return false;
    const requestedAt = performance.now();
    try {
      const kept = await this.retry(() => this.service.db.query(`UPDATE voice_calls SET runtime_until=now()+interval '20 seconds'
        WHERE id=$1 AND runtime_owner=$2 AND ended_at IS NULL AND runtime_until>now()`, [this.callId, this.leaseOwner]));
      if (!kept.rowCount) { await this.close(); return false; }
      if (this.closed) return false;
      this.leaseValidUntil = requestedAt + 20_000;
      this.armLeaseExpiry();
      return true;
    } catch (error) {
      if (performance.now() >= this.leaseValidUntil) await this.close();
      throw error;
    }
  }

  private async heartbeat() {
    if (!await this.renewLease()) return;
    // Token refresh does not re-grant Beeline membership: remove a retired/removed member.
    for (const participant of this.room.remoteParticipants.values()) {
      this.missingSince.delete(participant.identity);
      try { await this.retry(() => this.service.access(this.roomId, participant.identity)); }
      catch (error) {
        if (error instanceof Error && error.message === 'voice call access denied')
          await this.service.leave(this.callId, participant.identity, true);
        else await this.failure(error, participant.identity);
      }
    }
    await this.sweepMissingParticipants();
    await this.countHumans();
    await this.refresh();
  }

  private async sweepMissingParticipants() {
    if (this.closed) return;
    const missing = await this.retry(() => this.service.db.query<{ identity_id: string }>(
      `SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL
        AND NOT identity_id=ANY($2::text[])`,
      [this.callId, [...this.room.remoteParticipants.keys()]]));
    const absent = new Set(missing.rows.map(participant => participant.identity_id));
    for (const identity of this.missingSince.keys()) if (!absent.has(identity)) this.missingSince.delete(identity);
    for (const participant of missing.rows) {
      const since = this.missingSince.get(participant.identity_id);
      if (since === undefined) this.missingSince.set(participant.identity_id, performance.now());
      // Allow RTC's retry window and a fresh mobile join after a radio handoff.
      else if (performance.now() - since >= 120_000 && !this.room.remoteParticipants.has(participant.identity_id)) {
        await this.service.leave(this.callId, participant.identity_id, true);
        this.missingSince.delete(participant.identity_id);
      }
    }
  }
  /** Audio frames and lease traffic are not speech. Only real activity resets this window. */
  private async checkInactivity() {
    if (this.closed || this.checkingInactivity) return;
    this.checkingInactivity = true;
    try {
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
    } finally { this.checkingInactivity = false; }
  }

  private markCallActivity() {
    this.lastActivity = performance.now();
    this.endingTonePlayed = false;
    if (this.endingDeadline !== null) {
      this.endingDeadline = null;
      this.task(() => this.signal({ type: 'ending', deadline: null, serverNow: Date.now() }));
    }
  }

  private interruptPlayback() {
    this.playbackVersion++;
    this.speaking?.abort(); this.audio.clearQueue();
  }

  participantLeft(human: string) {
    this.assembler.cancel(human);
    this.targets.delete(human);
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

  async utterance(human: string, fragment: string, startedAt = performance.now(), interrupts = true) {
    this.markCallActivity();
    if (!interrupts && this.speaking && await this.retry(() => this.service.humanCount(this.callId)) > 1 &&
        !voiceNameOnly(fragment, await this.retry(() => this.service.agents(this.roomId, human)))) return;
    if (interrupts) this.interruptPlayback();
    let playbackVersion = this.playbackVersion;
    const traceId = randomUUID();
    const stages = new Set<string>();
    const timing = (stage: string) => {
      if (stages.has(stage)) return;
      stages.add(stage);
      console.info('[voice-turn-timing]', JSON.stringify({ traceId, callId: this.callId, stage,
        elapsedMs: performance.now() - startedAt }));
    };
    timing('flux_final');
    const failed = this.assembler.retryable(human);
    const retry = failed?.state === 'retryable' && /^(retry|try again|retry that)[.!?]*$/i.test(fragment.trim());
    const { request, previous } = retry ? { request: failed, previous: undefined } : this.assembler.begin(human, fragment);
    const generation = request.classification;
    const controller = new AbortController();
    const stop = () => { generation.abort(); controller.abort(); };
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
    let completion: Promise<void> | undefined;
    let answerToRecord: { agentId: string; text: string } | undefined;
    const recordAnswer = () => {
      if (answerToRecord && !completion) {
        completion = this.service.recordAnswer(this.roomId, answerToRecord.agentId, answerToRecord.text);
        void completion.catch(() => {});
      }
    };
    try {
      const roomMembers = this.service.memberNames
        ? this.retry(() => this.service.memberNames(this.roomId)).catch(() => []) : Promise.resolve([]);
      const agents = await this.retry(() => this.service.agents(this.roomId, human));
      const humans = await this.retry(() => this.service.humanCount(this.callId));
      if (humans === 1 && !interrupts) { this.interruptPlayback(); playbackVersion = this.playbackVersion; }
      const members: SpeechMember[] = [...agents.map(agent => ({ handle: agent.handle, name: agent.name })), ...await roomMembers];
      let sourceId = retry ? await request.source : previous ? await priorSource : '';
      const named = openingVoiceName(fragment, agents);
      const tapped = agents.find(agent => agent.id === this.assembler.target(human));
      let selected = request.agent?.id ?? this.targets.get(human);
      if (humans === 1 && !previous && !named && !tapped && !retry)
        selected = await this.retry(() => this.service.lastActiveAgent(this.roomId, agents)) ?? selected;
      const changedTarget = previous?.agent && this.targets.get(human) !== previous.agent.id
        ? agents.find(agent => agent.id === this.targets.get(human)) : undefined;
      const agent = retry ? request.agent : named ?? tapped ?? changedTarget ?? request.agent ?? openingVoiceName(request.text, agents) ??
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
      if (!retry) {
        if (sourceId) await this.retry(() => this.service.reviseHuman(this.callId, this.roomId, human, agent, sourceId, request.text, this.leaseOwner));
        else sourceId = await this.retry(() => this.service.recordHuman(this.callId, this.roomId, human, agent, request.text, this.leaseOwner, request.id));
        resolveSource(sourceId);
      }
      timing('human_committed');
      if (generation.signal.aborted || this.closed || !sourceId) return;
      const key = `${human}:${agent.id}`;
      let history = this.history.get(key)?.map(message => ({ ...message }));
      if (!history) {
        const rows = await this.retry(() => this.service.db.query<{ text: string; author_id: string }>(
          `SELECT text,author_id FROM messages WHERE room_id=$1 AND author_id=ANY($2::text[])
            AND id<>$3 AND presentation='message' AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 16`,
          [this.roomId, [human, agent.id], sourceId]));
        history = rows.rows.reverse().map(row => ({ role: row.author_id === agent.id ? 'assistant' : 'user', content: row.text }));
      }
      history.push({ role: 'user', content: request.text });
      request.state = 'classifying';
      timing('brain_request');
      // Deltas cannot announce work before the final decision has committed it.
      let streamed = false;
      const reply = retry ? { order: true, text: "Checking. I’ll tell you when I have it." } :
        await this.service.config.brain.answer(agent, history, delta => { if (delta) { streamed = true; timing('brain_first_token'); } }, generation.signal);
      timing('brain_complete');
      if (generation.signal.aborted || this.closed) return;
      if (reply.order) {
        request.state = 'delivering';
        try {
          await this.retry(() => this.service.dispatch(this.callId, sourceId, agent.id));
        } catch (error) { this.assembler.retainFailure(human, request); throw error; }
        delivered = true;
        timing('delivery_committed');
      }
      this.assembler.finish(human, request);
      const answer = reply.text || (reply.order ? "Checking. I’ll tell you when I have it." : '');
      if (!reply.order) answerToRecord = {agentId: agent.id, text: answer};
      history.push({ role: 'assistant', content: answer });
      this.history.set(key, history.slice(-16));
      // A different speaker may have taken the audio lane during classification.
      if (controller.signal.aborted || this.closed || (this.speaking && !this.speaking.signal.aborted) || playbackVersion !== this.playbackVersion) return;
      this.speaking = controller;
      this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
      await this.safeSignal({ type: 'speaker', agentId: agent.id });
      let firstAudio = false;
      if (controller.signal.aborted || this.closed) return;
      const stream = new MarkdownSpeechStream(members);
      const phrases = streamed ? [...stream.push(answer), stream.finish()] : [answer];
      for (const phrase of phrases) {
        if (!phrase.trim()) continue;
        if (controller.signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
        await this.play(phrase, agent, controller.signal, () => {
          if (firstAudio) return;
          firstAudio = true; timing('first_voiced_audio_published');
          this.task(() => this.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt }));
          recordAnswer();
        }, undefined, timing, members);
      }
    } catch (error) {
      rejectSource?.(error);
      if (request.state !== 'retryable' && !(generation.signal.aborted && error instanceof Error && error.name === 'AbortError'))
        this.assembler.finish(human, request);
      if (delivered && !(error instanceof Error && error.name === 'AbortError')) throw new DeliveredVoicePlaybackError(error);
      throw error;
    } finally {
      controller.abort();
      if (this.speaking === controller) {
        this.audio.clearQueue(); this.speaking = undefined;
        await this.safeSignal({ type: 'speaker', agentId: null });
      }
      finishSpeech?.();
      this.shutdown.signal.removeEventListener('abort', stop);
      recordAnswer();
      await completion;
    }
  }

  /** Match actual command provenance, never agent thought/draft events. No work deadline. */
  async refresh() {
    if (this.closed || this.refreshPending) return;
    this.refreshPending = true;
    try {
      const reports = await this.retry(() => this.service.db.query<{ source_message_id: string; id: string; text: string; agent_id: string; human_id: string }>(
        `SELECT DISTINCT ON (o.source_message_id) o.source_message_id,m.id,m.text,o.agent_id,source.author_id human_id
         FROM voice_orders o JOIN messages source ON source.id=o.source_message_id
         JOIN voice_participants p ON p.call_id=o.call_id AND p.identity_id=source.author_id AND p.left_at IS NULL AND p.parked_at IS NULL
         JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
         JOIN messages m ON m.author_id=o.agent_id AND m.room_id=$2
           AND (m.id=c.result_message_id OR m.request_id=c.id OR m.request_id=c.turn_request_id)
         WHERE o.call_id=$1 AND o.spoken_message_id IS NULL AND m.presentation='message' AND m.deleted_at IS NULL
         ORDER BY o.source_message_id,m.created_at DESC`, [this.callId, this.roomId]));
      for (const report of reports.rows) {
        if (!this.room.remoteParticipants.has(report.human_id)) continue;
        if (this.queuedReports.has(report.source_message_id)) continue;
        this.queuedReports.add(report.source_message_id);
        this.reportQueue = this.reportQueue.catch(() => {}).then(async () => {
          try {
            while (this.speaking && !this.closed) await this.speechIdle;
            const agent = (await this.retry(() => this.service.agents(this.roomId, report.human_id))).find(a => a.id === report.agent_id);
            if (!agent || this.closed) return;
            const members: SpeechMember[] = this.service.memberNames
              ? await this.retry(() => this.service.memberNames(this.roomId)).catch(() => []) : [];
            for (const [key, history] of this.history) if (key.endsWith(`:${agent.id}`)) {
              this.history.set(key, [...history, { role: 'assistant' as const, content: report.text }].slice(-16));
            }
            // Claim before playback so interruptions and lease handoffs cannot replay the opening.
            const claimed = await this.service.db.query(`UPDATE voice_orders o SET spoken_message_id=$2
              FROM voice_calls c WHERE o.source_message_id=$1 AND o.spoken_message_id IS NULL
                AND c.id=o.call_id AND c.runtime_owner=$3 AND c.runtime_until>now() AND c.ended_at IS NULL`,
              [report.source_message_id, report.id, this.leaseOwner]);
            if (!claimed.rowCount) return;
            // A new utterance may have started during the asynchronous claim.
            while (this.speaking && !this.closed) await this.speechIdle;
            if (this.closed) return;
            const controller = new AbortController(); this.speaking = controller;
            let finishSpeech!: () => void;
            this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
            try {
              await this.signal({ type: 'speaker', agentId: agent.id }); await this.play(report.text, agent, controller.signal, undefined, undefined, undefined, members);
            } finally { controller.abort(); finishSpeech(); if (this.speaking === controller) { this.audio.clearQueue(); this.speaking = undefined; await this.safeSignal({ type: 'speaker', agentId: null }); } }
          } finally { this.queuedReports.delete(report.source_message_id); }
        });
        const queued = this.reportQueue;
        this.task(() => queued);
      }
    } finally { this.refreshPending = false; await this.checkInactivity(); }
  }

  private async play(text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void,
    onFirstVoicedFrame?: () => void, timing?: (stage: string) => void, members?: SpeechMember[]) {
    text = markdownToSpeech(text, members);
    if (!text) return;
    let pending = Buffer.alloc(0); let first = true; let firstByte = true; let firstPublished = true;
    // 20ms mono frames. Carry odd byte boundaries between provider chunks.
    const frameBytes = VOICE_SAMPLE_RATE / 50 * 2;
    const speech = await this.service.speech(this.roomId);
    // A settings change applies to the next playback with that provider's own timbre.
    const current = (await this.retry(() => this.service.agents(this.roomId))).find(a => a.id === agent.id);
    const voice = current?.voice ?? agent.voice;
    if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
    const spoken = { text: text.trim(), until: Infinity };
    this.recentSpeech.push(spoken);
    if (this.recentSpeech.length > 12) this.recentSpeech.shift();
    try {
      timing?.('tts_request');
      for await (const bytes of speech.synthesize(spoken.text, voice, signal)) {
        if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
        if (firstByte && bytes.length) { firstByte = false; timing?.('tts_first_byte'); }
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= frameBytes) {
          if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
          const samples = new Int16Array(frameBytes / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
          pending = pending.subarray(frameBytes);
          this.markCallActivity();
          this.touch();
          const voiced = first && samples.some(sample => Math.abs(sample) > 150);
          if (voiced) { first = false; onFirstVoicedFrame?.(); }
          await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
          if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
          if (!signal.aborted && !this.closed && voiced) onFirstAudio?.();
        }
      }
      if (pending.length > 1) {
        const samples = new Int16Array(Math.floor(pending.length / 2));
        for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
        this.markCallActivity();
        this.touch();
        const voiced = first && samples.some(sample => Math.abs(sample) > 150);
        if (voiced) { first = false; onFirstVoicedFrame?.(); }
        await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
        if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
        if (!signal.aborted && !this.closed && voiced) onFirstAudio?.();
      }
      await this.audio.waitForPlayout();
    } finally {
      spoken.until = performance.now() + 1500;
    }
  }

  get isClosed() { return this.closed; }

  async resume(human: string) {
    const participant = this.room.remoteParticipants.get(human);
    if (!participant) throw new Error('voice transport disconnected');
    await this.heartbeat();
    for (const publication of participant.trackPublications.values()) {
      if (publication.track?.kind === TrackKind.KIND_AUDIO) this.task(() => this.listen(publication.track!, participant), human);
    }
    await this.refresh();
    // Older clients wait for playback to finish before restoring their mic.
    // A protected multi-human idle can resume with no report to produce that signal.
    if (!this.speaking) await this.signal({ type: 'speaker', agentId: null }, human);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.leaseRenewal);
    clearTimeout(this.leaseExpiry);
    clearInterval(this.quietCheck);
    this.shutdown.abort();
    this.assembler.close();
    const cleanup = async (work: () => unknown) => {
      try { await work(); } catch (error) { captureServerError(error, { surface: 'voice-cleanup' }); }
    };
    await cleanup(() => { this.speaking?.abort(); this.audio.clearQueue(); });
    this.missingSince.clear();
    for (const human of this.inputs.keys()) await cleanup(() => this.stopInput(human));
    await cleanup(() => this.meter?.close());
    await cleanup(() => this.room.disconnect());
    await cleanup(() => this.audio.close());
    await cleanup(() => this.service.db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1 AND runtime_owner=$2`,
      [this.callId, this.leaseOwner]));
    await cleanup(() => this.service.runtimeClosed(this.callId, this));
    await cleanup(() => this.service.db.query(`UPDATE messages SET card=card WHERE id=(
      SELECT message_id FROM voice_calls WHERE id=$1 AND ended_at IS NULL)`, [this.callId]));
  }
}
