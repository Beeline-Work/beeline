import { randomUUID } from 'node:crypto';
import { markdownToSpeech, MarkdownSpeechStream } from './markdown-to-speech.js';
import { AccessToken } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';
import { VOICE_DATA_TOPIC, type VoiceSignal } from '@beeline/api-contract/phone';
import type { VoiceService } from './voice-service.js';
import { VOICE_SAMPLE_RATE, VoiceQuotaError, type VoiceAgent, type VoiceStt, type FluxEvent } from './voice-providers.js';

import { namedVoiceTarget, openingVoiceName } from './voice-target.js';
export { namedVoiceTarget } from './voice-target.js';

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

/** One lease-bound call runtime. Real agents continue outside this audio turn. */
export class VoiceRoomRuntime {
  private readonly room = new Room();
  private readonly audio = new AudioSource(VOICE_SAMPLE_RATE, 1, 100);
  private readonly inputs = new Map<string, { stt?: VoiceStt; reader: ReadableStreamDefaultReader<AudioFrame>;
    track: RemoteTrack; participant: RemoteParticipant }>();
  private readonly recentSpeech: { text: string; until: number }[] = [];
  private readonly targets = new Map<string, string>();
  private readonly turnIndices = new Map<string, number>();
  private readonly inputVersions = new Map<string, number>();
  private readonly inputSpeech = new Map<string, { turn: number; playback: Set<string> }>();
  private readonly pendingTurns = new Map<string, { text: string; source: Promise<string>;
    controller: AbortController; playbackStarted: boolean; audible: boolean; agent?: VoiceAgent; selected?: string }>();
  private readonly shutdown = new AbortController();
  /** One-turn avatar taps in a call with several humans. */
  private readonly taps = new Map<string, string>();
  private humans = 1;
  private speaking?: AbortController;
  private speechIdle = Promise.resolve();
  private lastTouch = 0;
  private touching = false;
  private leaseRenewal?: ReturnType<typeof setInterval>;
  private closed = false;
  private refreshPending = false;
  private reportQueue = Promise.resolve();
  private readonly queuedReports = new Set<string>();
  private readonly history = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();
  private readonly missingSince = new Map<string, number>();
  private constructor(private readonly service: VoiceService, readonly callId: string, readonly roomId: string, private readonly leaseOwner: string) {}

  static async connect(service: VoiceService, callId: string, roomId: string, leaseOwner: string = service.owner) {
    const runtime = new VoiceRoomRuntime(service, callId, roomId, leaseOwner);
    try { await runtime.start(); return runtime; } catch (error) { await runtime.close(); throw error; }
  }
  private async start() {
    const token = new AccessToken(this.service.config.apiKey, this.service.config.apiSecret,
      { identity: `beeline-voice-${this.callId}`, ttl: '1h', metadata: JSON.stringify({ kind: 'transport' }) });
    token.addGrant({ roomJoin: true, room: `beeline-voice-${this.callId}`, canPublish: true,
      canSubscribe: true, canPublishData: true });
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO) void this.listen(track, participant).catch(error =>
        this.signal({ type: 'error', message: error instanceof VoiceQuotaError ? error.message : 'Speech input unavailable; please try again',
          ...(error instanceof VoiceQuotaError ? { code: error.code } : {}) }, participant.identity));
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      if (this.inputs.get(participant.identity)?.track === track) this.stopInput(participant.identity);
    });
    this.room.on(RoomEvent.ParticipantDisconnected, participant => {
      if (this.closed) return;
      if (this.inputs.get(participant.identity)?.participant === participant) this.stopInput(participant.identity);
      // A newer device with the same Beeline identity can replace this RTC
      // participant. Do not let the old socket remove its successor.
      if (!this.room.remoteParticipants.has(participant.identity) && !this.missingSince.has(participant.identity))
        this.missingSince.set(participant.identity, performance.now());
    });
    this.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (!participant || topic !== VOICE_DATA_TOPIC || bytes.length > 2048) return;
      void (async () => {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
        if (data.type !== 'target' && data.type !== 'resume' && data.type !== 'park') return;
        await this.service.access(this.roomId, participant.identity);
        if (data.type === 'target') {
          const allowed = await this.service.agents(this.roomId, participant.identity);
          if (!allowed.some(a => a.id === data.agentId)) return;
          this.targets.set(participant.identity, data.agentId);
          if (data.tap) this.taps.set(participant.identity, data.agentId);
        }
        if (data.type === 'target') { await this.refresh(); return; }
        // HTTP may land on another server; the retained RTC channel reaches
        // the owner. Durable session/state checks fence queued old packets.
        if (typeof data.sessionId !== 'string' || !(await this.service.db.query(`SELECT 1 FROM voice_participants
          WHERE call_id=$1 AND identity_id=$2 AND session_id=$3 AND left_at IS NULL
          AND (parked_at IS NOT NULL)=$4`, [this.callId, participant.identity, data.sessionId, data.type === 'park'])).rowCount) return;
        if (data.type === 'park') await this.park(participant.identity, data.sessionId);
        else await this.resume(participant.identity);
      })().catch(() => {});
    });
    this.room.on(RoomEvent.ParticipantConnected, () => { void this.countHumans(undefined, true).catch(() => {}); });
    this.room.on(RoomEvent.Disconnected, () => { if (!this.closed) void this.close(); });
    await this.room.connect(this.service.config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('beeline-agent-speech', this.audio), options);
    // RTC ownership outlives audio activity, including a parked pending order.
    // Sweep missing humans even when no audio or signals arrive.
    // Committed events still drive report reads.
    this.leaseRenewal = setInterval(() => {
      return this.renewLease().then(kept => {
        if (kept) return this.sweepMissingParticipants();
      }).catch(() => this.close());
    }, 5000);
    this.leaseRenewal.unref();
    this.touch();
    await this.countHumans(undefined, true).catch(() => {});
    await this.refresh();
  }

  private async signal(signal: VoiceSignal, human?: string) {
    this.touch();
    if (!this.closed) await this.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(signal)),
      { reliable: true, topic: VOICE_DATA_TOPIC, ...(human ? { destination_identities: [human] } : {}) });
  }
  private async listen(track: RemoteTrack, participant: RemoteParticipant) {
    const human = participant.identity;
    if (this.inputs.get(human)?.track === track) return;
    this.stopInput(human);
    const version = (this.inputVersions.get(human) ?? 0) + 1;
    this.inputVersions.set(human, version);
    this.turnIndices.delete(human);
    // Start buffering RTC frames immediately: waiting for the STT handshake
    // otherwise clips the first spoken name after a phone publishes its mic.
    const reader = new AudioStream(track, 16_000, 1).getReader();
    this.inputs.set(human, { reader, track, participant });
    let stt: VoiceStt | undefined;
    // Drain the SDK continuously while opening STT; retain at most two seconds.
    const buffered: Int16Array[] = [];
    const pump = (async () => {
      while (!this.closed && this.inputVersions.get(human) === version) {
        const frame = await reader.read();
        if (frame.done) break;
        this.touch();
        if (stt) stt.send(frame.value.data);
        else {
          buffered.push(frame.value.data.slice());
          if (buffered.length > 100) buffered.shift();
        }
      }
    })();
    void pump.catch(() => {});
    try {
      await this.service.access(this.roomId, human);
      if (!(await this.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL AND parked_at IS NULL`,
        [this.callId, human])).rowCount) { this.stopInput(human); return; }
      const hints = (await this.service.agents(this.roomId, human)).flatMap(agent => [agent.name, agent.handle]);
      stt = await this.service.config.stt(event => {
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
      void this.signal({ type: 'speech' }, human);
      // Partial recognized names can aim the strip immediately; only EndOfTurn dispatches.
      if (event.event !== 'EndOfTurn') void this.aimSpokenName(human, event.transcript, version);
      // With several humans, anyone may interrupt, but only with real speech.
      const interrupts = this.humans === 1 || voiceInterrupt(event);
      if (interrupts) { this.pendingTurns.get(human)?.controller.abort(); this.speaking?.abort(); this.audio.clearQueue(); }
      if (event.event !== 'EndOfTurn' || !event.transcript.trim() ||
          event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      this.turnIndices.set(human, event.turn_index);
      if (/^(stop|stop conversation|end conversation|leave conversation|stop conversation mode)$/.test(speechWords(event.transcript).join(' '))) {
        this.inputVersions.set(human, version + 1);
        this.stopInput(human);
        void this.signal({ type: 'stop' }, human)
          .finally(() => this.service.leave(this.callId, human, true)).catch(() => {});
        return;
      }
      void this.utterance(human, event.transcript, performance.now(), interrupts).catch(error => {
        if (error instanceof Error && error.name === 'AbortError') return;
        void this.signal({ type: 'error', message: error instanceof VoiceQuotaError ? error.message : 'Voice reply unavailable; your message is in the transcript',
          ...(error instanceof VoiceQuotaError ? { code: error.code } : {}) }, human);
      });
      }, error => {
        if (this.inputVersions.get(human) !== version) return;
        void this.signal({ type: 'error', message: error instanceof VoiceQuotaError ? error.message : 'Speech input disconnected; please rejoin',
          ...(error instanceof VoiceQuotaError ? { code: error.code } : {}) }, human); this.stopInput(human);
      }, hints);
    } catch (error) {
      if (this.inputVersions.get(human) !== version) { await reader.cancel().catch(() => {}); return; }
      this.stopInput(human); throw error;
    }
    if (this.closed || this.inputVersions.get(human) !== version) { stt.close(); await reader.cancel().catch(() => {}); return; }
    this.inputs.set(human, { stt, reader, track, participant });
    try {
      for (const frame of buffered) stt.send(frame);
      buffered.length = 0;
      await pump;
    } finally { if (this.inputs.get(human)?.stt === stt) this.stopInput(human); }
  }
  private stopInput(human: string) {
    this.inputVersions.set(human, (this.inputVersions.get(human) ?? 0) + 1);
    this.inputSpeech.delete(human);
    const input = this.inputs.get(human);
    if (!input) return;
    this.inputs.delete(human); input.stt?.close(); void input.reader.cancel().catch(() => {});
  }
  private touch() {
    if (this.closed || this.touching || performance.now() - this.lastTouch < 5000) return;
    this.lastTouch = performance.now(); this.touching = true;
    void this.heartbeat().catch(() => this.close()).finally(() => { this.touching = false; });
  }
  private async renewLease() {
    if (this.closed) return false;
    const kept = await this.service.db.query(`UPDATE voice_calls SET runtime_until=now()+interval '20 seconds'
      WHERE id=$1 AND runtime_owner=$2 AND ended_at IS NULL`, [this.callId, this.leaseOwner]);
    if (!kept.rowCount) { await this.close(); return false; }
    return true;
  }
  private async heartbeat() {
    if (!await this.renewLease()) return;
    // Token refresh does not re-grant Beeline membership: remove a retired/removed member.
    for (const participant of this.room.remoteParticipants.values()) {
      this.missingSince.delete(participant.identity);
      try { await this.service.access(this.roomId, participant.identity); }
      catch { await this.service.leave(this.callId, participant.identity, true); }
    }
    await this.sweepMissingParticipants();
    await this.countHumans();
    await this.refresh();
  }

  private async sweepMissingParticipants() {
    if (this.closed) return;
    const missing = await this.service.db.query<{ identity_id: string }>(
      `SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL AND parked_at IS NULL
        AND NOT identity_id=ANY($2::text[])`,
      [this.callId, [...this.room.remoteParticipants.keys()]]);
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
  private async aimSpokenName(human: string, text: string, version: number) {
    const agent = namedVoiceTarget(text, await this.service.agents(this.roomId, human), undefined, 2);
    if (!agent || this.closed || this.inputVersions.get(human) !== version) return;
    this.targets.set(human, agent.id);
    await this.signal({ type: 'target', agentId: agent.id }, human);
  }

  /** Every human hears the same count, so each panel shows the same speaking tips. */
  private async countHumans(count?: number, announce = false) {
    count ??= await this.service.humanCount(this.callId);
    const changed = count !== this.humans;
    this.humans = count;
    if (changed || announce) await this.signal({ type: 'humans', count });
  }

  async utterance(human: string, text: string, startedAt = performance.now(), interrupts = true) {
    if (this.humans > 1 && this.speaking && !interrupts) return;
    const traceId = randomUUID();
    const stages = new Set<string>();
    const timing = (stage: string) => {
      if (stages.has(stage)) return;
      stages.add(stage);
      console.info('[voice-turn-timing]', JSON.stringify({ traceId, callId: this.callId, stage,
        elapsedMs: performance.now() - startedAt }));
    };
    timing('flux_final');
    const fragment = text;
    const previous = this.pendingTurns.get(human);
    const continuation = previous && !previous.playbackStarted ? previous : undefined;
    if (continuation) {
      timing('continuation_restart');
      continuation.controller.abort();
      text = `${continuation.text} ${text}`;
    }
    const controller = new AbortController();
    let resolveSource!: (id: string) => void;
    let rejectSource!: (error: unknown) => void;
    const source = new Promise<string>((resolve, reject) => { resolveSource = resolve; rejectSource = reject; });
    void source.catch(() => {});
    const turn: { text: string; source: Promise<string>; controller: AbortController; playbackStarted: boolean; audible: boolean; agent?: VoiceAgent; selected?: string } =
      { text, source, controller, playbackStarted: false, audible: false, selected: this.targets.get(human) };
    const generation = new AbortController();
    let decisionFinal = false;
    controller.signal.addEventListener('abort', () => { if (!turn.audible || decisionFinal) generation.abort(); }, { once: true });
    const stopGeneration = () => generation.abort();
    this.shutdown.signal.addEventListener('abort', stopGeneration, { once: true });
    // Reserve the draft and its write before any await. Successors share the
    // initial insert and wait for this revision before editing the same row.
    this.pendingTurns.set(human, turn);
    try {
      const agents = await this.service.agents(this.roomId, human);
      const humans = await this.service.humanCount(this.callId);
      void this.countHumans(humans).catch(() => {});
      let sourceId = continuation ? await continuation.source : '';
      let selected = this.targets.get(human);
      const inherited = selected !== continuation?.selected && selected !== continuation?.agent?.id
        ? selected : continuation?.agent?.id ?? selected;
      const named = openingVoiceName(continuation ? fragment : text, agents);
      const tapped = agents.find(agent => agent.id === this.taps.get(human));
      this.taps.delete(human);
      if (humans === 1 && !continuation && !named && !tapped) {
        selected = await this.service.lastActiveAgent(this.roomId, agents) ?? selected;
      }
      const agent = continuation
        ? namedVoiceTarget(fragment, agents, inherited, 1)
        : humans > 1 ? named ?? tapped
          : named ?? tapped ?? namedVoiceTarget(text, agents, selected, humans);
      if (!agent || this.closed) {
        resolveSource('');
        if (!agent && !this.closed) await this.signal({ type: 'unaddressed' }, human);
        if (this.pendingTurns.get(human) === turn) this.pendingTurns.delete(human);
        return;
      }
      turn.agent = agent;
      if (!controller.signal.aborted) {
        this.targets.set(human, agent.id);
        await this.signal({ type: 'target', agentId: agent.id }, human);
      }
      if (this.closed) { resolveSource(''); return; }
      if (!continuation) {
        sourceId = await this.service.recordHuman(this.callId, this.roomId, human, agent, text, this.leaseOwner);
      } else if (!controller.signal.aborted) {
        if (sourceId) await this.service.reviseHuman(this.callId, this.roomId, human, agent, sourceId, text, this.leaseOwner);
        else sourceId = await this.service.recordHuman(this.callId, this.roomId, human, agent, text, this.leaseOwner);
      }
      resolveSource(sourceId);
      timing('human_committed');
      if (controller.signal.aborted || this.closed || !sourceId) return;
      this.speaking?.abort(); this.audio.clearQueue();
      this.speaking = controller;
      let finishSpeech!: () => void;
      this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
      const key = `${human}:${agent.id}`;
      let history = this.history.get(key)?.map(message => ({ ...message }));
      const speechText = new MarkdownSpeechStream();
      let receivedText = ''; let handedOff = false; let firstAudio = false; let speechQueue = Promise.resolve();
      let answer: string | undefined;
      let completion: Promise<void> | undefined;
      const commitAudibleReply = () => {
        if (!firstAudio || answer === undefined || completion) return;
        // Barge-in cancels playback, never work whose acknowledgement was heard.
        // Start the write once both the final decision and first audio exist.
        completion = handedOff ? this.service.dispatch(this.callId, sourceId, agent.id)
          : this.service.recordAnswer(this.roomId, agent.id, answer);
        void completion.catch(() => {});
      };
      try {
        if (!history) {
          const rows = await this.service.db.query<{ text: string; author_id: string }>(
            `SELECT text,author_id FROM messages WHERE room_id=$1 AND author_id=ANY($2::text[])
              AND id<>$3 AND presentation='message' AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 16`,
            [this.roomId, [human, agent.id], sourceId]);
          history = rows.rows.reverse().map(row => ({ role: row.author_id === agent.id ? 'assistant' : 'user', content: row.text }));
        }
        if (controller.signal.aborted || this.closed) return;
        history.push({ role: 'user', content: text });
        const flush = (phrase: string) => {
          if (!phrase.trim()) return;
          speechQueue = speechQueue.then(async () => {
            if (controller.signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
            await this.signal({ type: 'speaker', agentId: agent.id });
            if (controller.signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
            await this.play(phrase, agent, controller.signal, () => {
              if (!firstAudio) {
                timing('first_voiced_audio_published');
                firstAudio = true; turn.audible = true; commitAudibleReply();
                void this.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt });
              }
            }, () => { turn.playbackStarted = true; }, timing);
          });
          void speechQueue.catch(() => {});
        };
        timing('brain_request');
        const reply = await this.service.config.brain.answer(agent, history, delta => {
          if (controller.signal.aborted || this.closed) return;
          if (delta) timing('brain_first_token');
          receivedText += delta;
          for (const phrase of speechText.push(delta)) flush(phrase);
        }, generation.signal);
        timing('brain_complete');
        decisionFinal = true;
        if (controller.signal.aborted) generation.abort();
        if (!firstAudio && (controller.signal.aborted || this.closed)) throw new DOMException('Interrupted', 'AbortError');
        handedOff = !!reply.order;
        answer = reply.text || (handedOff ? "Checking. I’ll tell you when I have it." : '');
        commitAudibleReply();
        if (!reply.text || !receivedText.trim()) { speechText.finish(); flush(answer); }
        else if (answer.startsWith(receivedText)) speechText.push(answer.slice(receivedText.length)).forEach(flush);
        flush(speechText.finish()); await speechQueue;
        if (!firstAudio && (controller.signal.aborted || this.closed)) throw new DOMException('Interrupted', 'AbortError');
        if (handedOff && !completion) throw new Error('Voice acknowledgement produced no audio');
        if (!handedOff && !completion) completion = this.service.recordAnswer(this.roomId, agent.id, answer);
        await completion;
        if (!controller.signal.aborted && !this.closed) {
          history.push({ role: 'assistant', content: answer });
          this.history.set(key, history.slice(-16));
        }
        if (this.pendingTurns.get(human) === turn) this.pendingTurns.delete(human);
      } finally {
        if (this.speaking === controller) {
          this.speaking = undefined; finishSpeech();
          await this.signal({ type: 'speaker', agentId: null });
        } else finishSpeech();
        if (this.pendingTurns.get(human) === turn && firstAudio) this.pendingTurns.delete(human);
        // No unheard text enters the ledger. An in-flight commit owns its row
        // even if playback was interrupted while the database was writing.
        if (!completion && !handedOff && firstAudio && receivedText.trim()) {
          completion = this.service.recordAnswer(this.roomId, agent.id, receivedText.trim());
        }
        await completion;
      }
    } catch (error) {
      rejectSource(error);
      const interrupted = error instanceof Error && error.name === 'AbortError';
      if ((!interrupted || !controller.signal.aborted || turn.audible) && this.pendingTurns.get(human) === turn) this.pendingTurns.delete(human);
      throw error;
    } finally { this.shutdown.signal.removeEventListener('abort', stopGeneration); }
  }

  /** Match actual command provenance, never agent thought/draft events. No work deadline. */
  async refresh() {
    if (this.closed || this.refreshPending) return;
    this.refreshPending = true;
    try {
      const reports = await this.service.db.query<{ source_message_id: string; id: string; text: string; agent_id: string; human_id: string }>(
        `SELECT DISTINCT ON (o.source_message_id) o.source_message_id,m.id,m.text,o.agent_id,source.author_id human_id
         FROM voice_orders o JOIN messages source ON source.id=o.source_message_id
         JOIN voice_participants p ON p.call_id=o.call_id AND p.identity_id=source.author_id AND p.left_at IS NULL AND p.parked_at IS NULL
         JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
         JOIN messages m ON m.author_id=o.agent_id AND m.room_id=$2
           AND (m.id=c.result_message_id OR m.request_id=c.id OR m.request_id=c.turn_request_id)
         WHERE o.call_id=$1 AND o.spoken_message_id IS NULL AND m.presentation='message' AND m.deleted_at IS NULL
         ORDER BY o.source_message_id,m.created_at DESC`, [this.callId, this.roomId]);
      for (const report of reports.rows) {
        if (!this.room.remoteParticipants.has(report.human_id)) continue;
        if (this.queuedReports.has(report.source_message_id)) continue;
        this.queuedReports.add(report.source_message_id);
        this.reportQueue = this.reportQueue.catch(() => {}).then(async () => {
          try {
            while (this.speaking && !this.closed) await this.speechIdle;
            const agent = (await this.service.agents(this.roomId, report.human_id)).find(a => a.id === report.agent_id);
            if (!agent || this.closed) return;
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
              await this.signal({ type: 'speaker', agentId: agent.id }); await this.play(report.text, agent, controller.signal);
            } finally { finishSpeech(); if (this.speaking === controller) { this.speaking = undefined; await this.signal({ type: 'speaker', agentId: null }); } }
          } finally { this.queuedReports.delete(report.source_message_id); }
        });
        void this.reportQueue.catch(error => {
          if (error instanceof Error && error.name === 'AbortError') return;
          return this.signal({ type: 'error',
          message: error instanceof VoiceQuotaError ? error.message : 'The report is in the transcript; voice playback failed',
          ...(error instanceof VoiceQuotaError ? { code: error.code } : {}) });
        });
      }
    } finally { this.refreshPending = false; }
  }

  private async play(text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void,
    onFirstVoicedFrame?: () => void, timing?: (stage: string) => void) {
    text = markdownToSpeech(text);
    if (!text) return;
    let pending = Buffer.alloc(0); let first = true; let firstByte = true; let firstPublished = true;
    // 20ms mono frames. Carry odd byte boundaries between provider chunks.
    const frameBytes = VOICE_SAMPLE_RATE / 50 * 2;
    const speech = await this.service.speech(this.roomId);
    // A settings change applies to the next playback with that provider's own timbre.
    const current = (await this.service.agents(this.roomId)).find(a => a.id === agent.id);
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
        this.touch();
        const voiced = first && samples.some(sample => Math.abs(sample) > 150);
        if (voiced) { first = false; onFirstVoicedFrame?.(); }
        await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
        if (firstPublished) { firstPublished = false; timing?.('first_audio_published'); }
        if (!signal.aborted && !this.closed && voiced) onFirstAudio?.();
      }
      await this.audio.waitForPlayout();
    } finally { spoken.until = performance.now() + 1500; }
  }

  get isClosed() { return this.closed; }

  async park(human: string, sessionId?: string) {
    if (!(await this.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2
      AND left_at IS NULL AND parked_at IS NOT NULL AND ($3::text IS NULL OR session_id=$3)`,
      [this.callId, human, sessionId ?? null])).rowCount) return;
    this.stopInput(human);
  }

  async resume(human: string) {
    const participant = this.room.remoteParticipants.get(human);
    if (!participant) throw new Error('voice transport disconnected');
    await this.heartbeat();
    for (const publication of participant.trackPublications.values()) {
      if (publication.track?.kind === TrackKind.KIND_AUDIO) void this.listen(publication.track, participant)
        .catch(() => this.signal({ type: 'error', message: 'Speech input unavailable; please try again' }, human));
    }
    await this.refresh();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.leaseRenewal);
    this.speaking?.abort(); this.audio.clearQueue();
    this.missingSince.clear();
    this.shutdown.abort();
    for (const turn of this.pendingTurns.values()) turn.controller.abort();
    this.pendingTurns.clear();
    for (const human of this.inputs.keys()) this.stopInput(human);
    await this.room.disconnect(); await this.audio.close();
    await this.service.db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1 AND runtime_owner=$2`,
      [this.callId, this.leaseOwner]);
    this.service.runtimeClosed(this.callId, this);
    // Reuse the existing cross-instance message notification: the surviving
    // background leader immediately claims a released active call after a deploy.
    await this.service.db.query(`UPDATE messages SET card=card WHERE id=(
      SELECT message_id FROM voice_calls WHERE id=$1 AND ended_at IS NULL)`, [this.callId]);
  }
}
