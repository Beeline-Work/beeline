import { stripVoiceEmotion } from './voice-emotion.js';
import { AccessToken } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';
import { VOICE_DATA_TOPIC, type VoiceSignal } from '@beeline/api-contract/phone';
import type { VoiceService } from './voice-service.js';
import { VOICE_SAMPLE_RATE, VoiceQuotaError, type VoiceAgent, type VoiceStt, type FluxEvent } from './voice-providers.js';

import { namedVoiceTarget } from './voice-target.js';
export { namedVoiceTarget } from './voice-target.js';

const speechWords = (text: string) => stripVoiceEmotion(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Flux VAD alone can fire on noise. Wait for confident recognized words. */
export function confirmedVoiceSpeech(event: FluxEvent): boolean {
  if (!speechWords(event.transcript).length) return false;
  if (!event.words?.length) return event.event === 'EndOfTurn';
  const words = event.words.filter(word => Number.isFinite(word.confidence) && word.confidence >= 0.8);
  return words.length > 0 && words.length >= event.words.length * 0.75 &&
    words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end)) &&
    words[words.length - 1]!.end - words[0]!.start >= 0.12;
}

/** A recognized fragment of our own recent output must not start another answer. */
export function voicePlaybackEcho(transcript: string, playback: string): boolean {
  const words = speechWords(transcript), spoken = speechWords(playback);
  if (!words.length) return false;
  if (words.length === 1) return spoken.length === 1 && words[0] === spoken[0];
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
  private speaking?: AbortController;
  private speechIdle = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private refreshPending = false;
  private reportQueue = Promise.resolve();
  private readonly queuedReports = new Set<string>();
  private readonly history = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();
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
      const timer = setTimeout(() => {
        if (!this.closed && !this.room.remoteParticipants.has(participant.identity))
          void this.service.leave(this.callId, participant.identity, true).catch(() => {});
      }, 1000);
      timer.unref();
    });
    this.room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
      if (!participant || topic !== VOICE_DATA_TOPIC || bytes.length > 2048) return;
      void (async () => {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
        if (data.type !== 'target') return;
        await this.service.access(this.roomId, participant.identity);
        const allowed = await this.service.agents(this.roomId, participant.identity);
        if (allowed.some(a => a.id === data.agentId)) this.targets.set(participant.identity, data.agentId);
      })().catch(() => {});
    });
    this.room.on(RoomEvent.Disconnected, () => { if (!this.closed) void this.close(); });
    await this.room.connect(this.service.config.url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('beeline-agent-speech', this.audio), options);
    this.timer = setInterval(() => { void this.heartbeat().catch(() => this.close()); }, 5_000);
    this.timer.unref();
    await this.refresh();
  }

  private async signal(signal: VoiceSignal, human?: string) {
    if (!this.closed) await this.room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(signal)),
      { reliable: true, topic: VOICE_DATA_TOPIC, ...(human ? { destinationIdentities: [human] } : {}) });
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
    let stt: VoiceStt;
    try {
      await this.service.access(this.roomId, human);
      if (!(await this.service.db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND identity_id=$2 AND left_at IS NULL`,
        [this.callId, human])).rowCount) { this.stopInput(human); return; }
      const hints = (await this.service.agents(this.roomId, human)).flatMap(agent => [agent.name, agent.handle]);
      stt = await this.service.config.stt(event => {
      if (this.inputVersions.get(human) !== version ||
          event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      if (!confirmedVoiceSpeech(event)) return;
      const recent = this.recentSpeech.filter(spoken => spoken.until > performance.now());
      if (voicePlaybackEcho(event.transcript, recent.map(spoken => spoken.text).join(' ')) ||
          recent.some(spoken => voicePlaybackEcho(event.transcript, spoken.text))) return;
      // Partial recognized names can aim the strip immediately; only EndOfTurn dispatches.
      if (event.event !== 'EndOfTurn') void this.aimSpokenName(human, event.transcript, version);
      this.speaking?.abort(); this.audio.clearQueue();
      if (event.event !== 'EndOfTurn' || !event.transcript.trim() ||
          event.turn_index <= (this.turnIndices.get(human) ?? -1)) return;
      this.turnIndices.set(human, event.turn_index);
      void this.utterance(human, event.transcript, performance.now()).catch(error => {
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
      while (!this.closed) {
        const frame = await reader.read();
        if (frame.done) break;
        stt.send(frame.value.data);
      }
    } finally { if (this.inputs.get(human)?.stt === stt) this.stopInput(human); }
  }
  private stopInput(human: string) {
    this.inputVersions.set(human, (this.inputVersions.get(human) ?? 0) + 1);
    const input = this.inputs.get(human);
    if (!input) return;
    this.inputs.delete(human); input.stt?.close(); void input.reader.cancel().catch(() => {});
  }
  private async heartbeat() {
    const kept = await this.service.db.query(`UPDATE voice_calls SET runtime_until=now()+interval '20 seconds'
      WHERE id=$1 AND runtime_owner=$2 AND ended_at IS NULL`, [this.callId, this.leaseOwner]);
    if (!kept.rowCount) { await this.close(); return; }
    // Token refresh does not re-grant Beeline membership: remove a retired/removed member.
    for (const participant of this.room.remoteParticipants.values()) {
      try { await this.service.access(this.roomId, participant.identity); }
      catch { await this.service.leave(this.callId, participant.identity, true); }
    }
    const missing = await this.service.db.query<{ identity_id: string }>(
      `SELECT identity_id FROM voice_participants WHERE call_id=$1 AND left_at IS NULL
        AND joined_at<now()-interval '30 seconds' AND NOT identity_id=ANY($2::text[])`,
      [this.callId, [...this.room.remoteParticipants.keys()]]);
    for (const participant of missing.rows) await this.service.leave(this.callId, participant.identity_id, true);
    await this.refresh();
  }
  private async aimSpokenName(human: string, text: string, version: number) {
    const agent = namedVoiceTarget(text, await this.service.agents(this.roomId, human), undefined, 2);
    if (!agent || this.closed || this.inputVersions.get(human) !== version) return;
    this.targets.set(human, agent.id);
    await this.signal({ type: 'target', agentId: agent.id }, human);
  }

  async utterance(human: string, text: string, startedAt = performance.now()) {
    const agents = await this.service.agents(this.roomId, human);
    const humans = await this.service.humanCount(this.callId);
    const agent = namedVoiceTarget(text, agents, this.targets.get(human), humans);
    if (!agent || this.closed) return;
    this.targets.set(human, agent.id);
    await this.signal({ type: 'target', agentId: agent.id }, human);
    const sourceId = await this.service.recordHuman(this.callId, this.roomId, human, agent, text, this.leaseOwner);
    this.speaking?.abort(); this.audio.clearQueue();
    const controller = new AbortController(); this.speaking = controller;
    let finishSpeech!: () => void;
    this.speechIdle = new Promise<void>(resolve => { finishSpeech = resolve; });
    const key = `${human}:${agent.id}`;
    let history = this.history.get(key)?.map(message => ({ ...message }));
    let pending = ''; let receivedText = ''; let persisted = false; let firstAudio = false; let speechQueue = Promise.resolve();
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
          await this.play(phrase, agent, controller.signal, () => {
            if (!firstAudio) { firstAudio = true; void this.signal({ type: 'latency', firstAudioMs: performance.now() - startedAt }); }
          });
        });
        // The generation continues while playback works; attach immediately to prevent unhandled aborts.
        void speechQueue.catch(() => {});
      };
      const reply = await this.service.config.brain.answer(agent, history, delta => {
        receivedText += delta;
        pending += delta;
        // Start synthesis on the first clause rather than waiting for the whole reply.
        let match: RegExpExecArray | null;
        while ((match = /[.!?,;:]\s+/.exec(pending))) {
          flush(pending.slice(0, match.index + 1)); pending = pending.slice(match.index + match[0].length);
        }
      }, controller.signal);
      if (reply.order) await this.service.dispatch(this.callId, sourceId, agent.id);
      const answer = reply.text || (reply.order ? "I’ll work on that and tell you when I’m done." : '');
      // The final receipt may include a suffix absent from streamed deltas.
      if (!reply.text || !receivedText.trim()) pending = answer;
      else if (answer.startsWith(receivedText)) pending += answer.slice(receivedText.length);
      await this.service.recordAnswer(this.roomId, agent.id, answer);
      persisted = true;
      history.push({ role: 'assistant', content: answer });
      this.history.set(key, history.slice(-16));
      flush(pending); await speechQueue;
    } finally {
      if (this.speaking === controller) {
        this.speaking = undefined; finishSpeech();
        await this.signal({ type: 'speaker', agentId: null });
      } else finishSpeech();
      // A barge-in may interrupt generation after a clause was already heard.
      if (!persisted && receivedText.trim()) await this.service.recordAnswer(this.roomId, agent.id, receivedText.trim());
    }
  }

  /** Match actual command provenance, never agent thought/draft events. No work deadline. */
  async refresh() {
    if (this.closed || this.refreshPending) return;
    this.refreshPending = true;
    try {
      const reports = await this.service.db.query<{ source_message_id: string; id: string; text: string; agent_id: string; human_id: string }>(
        `SELECT DISTINCT ON (o.source_message_id) o.source_message_id,m.id,m.text,o.agent_id,source.author_id human_id
         FROM voice_orders o JOIN messages source ON source.id=o.source_message_id
         JOIN agent_commands c ON c.source_message_id=o.source_message_id AND c.agent_id=o.agent_id
         JOIN messages m ON m.author_id=o.agent_id AND m.room_id=$2
           AND (m.id=c.result_message_id OR m.request_id=c.id OR m.request_id=c.turn_request_id)
         WHERE o.call_id=$1 AND o.spoken_message_id IS NULL AND m.presentation='message' AND m.deleted_at IS NULL
         ORDER BY o.source_message_id,m.created_at DESC`, [this.callId, this.roomId]);
      for (const report of reports.rows) {
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

  private async play(text: string, agent: VoiceAgent, signal: AbortSignal, onFirstAudio?: () => void) {
    let pending = Buffer.alloc(0); let first = true;
    // 20ms mono frames. Carry odd byte boundaries between provider chunks.
    const frameBytes = VOICE_SAMPLE_RATE / 50 * 2;
    const speech = await this.service.speech(this.roomId);
    // A settings change applies to the next playback with that provider's own timbre.
    const current = (await this.service.agents(this.roomId)).find(a => a.id === agent.id);
    const voice = current?.voice ?? agent.voice;
    if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
    const spoken = { text: stripVoiceEmotion(text), until: Infinity };
    this.recentSpeech.push(spoken);
    if (this.recentSpeech.length > 12) this.recentSpeech.shift();
    try {
      for await (const bytes of speech.synthesize(spoken.text, voice, signal)) {
        if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= frameBytes) {
          if (signal.aborted || this.closed) throw new DOMException('Interrupted', 'AbortError');
          const samples = new Int16Array(frameBytes / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
          pending = pending.subarray(frameBytes);
          await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
          if (first && samples.some(sample => Math.abs(sample) > 150)) { first = false; onFirstAudio?.(); }
        }
      }
      if (pending.length > 1) {
        const samples = new Int16Array(Math.floor(pending.length / 2));
        for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
        await this.audio.captureFrame(new AudioFrame(samples, VOICE_SAMPLE_RATE, 1, samples.length));
        if (first && samples.some(sample => Math.abs(sample) > 150)) onFirstAudio?.();
      }
      await this.audio.waitForPlayout();
    } finally { spoken.until = performance.now() + 1500; }
  }

  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.speaking?.abort(); this.audio.clearQueue();
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
