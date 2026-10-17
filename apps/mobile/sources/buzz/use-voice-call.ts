import * as React from 'react';
import { Platform } from 'react-native';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { VOICE_DATA_TOPIC, type VoiceJoin, type VoiceIdleState, type VoiceSignal, type VoiceCall, type RoomViewIdentity } from '@beeline/api-contract/phone';
import { getBuzzRuntimeConfig } from './runtime-config';
import { createVoiceRoom, subscribeVoiceResume, voiceFetch } from './voice-transport';
import { errorDiagnostic, reportClientError } from './client-error-report';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { voiceWaveformLevel } from './waveform-level';

async function voiceRequest<T>(id: string, action: 'join' | 'leave' | 'current' | 'idle' | 'state' | 'resume', sessionId?: string): Promise<T> {
  const response = await voiceFetch(`${getBuzzRuntimeConfig().monolithUrl}/v1/phone/voice/${id}/${action}${action === 'state' && sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    { method: action === 'current' || action === 'state' ? 'GET' : 'POST',
      ...(sessionId && action !== 'state' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) } : {}) });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'Conversation mode could not connect');
  return value;
}

async function closeVoiceTransport(transport: { room: Room; closeAudio(): Promise<void> } | undefined | null) {
  if (!transport) return;
  // Stop RTC before releasing its native audio session; each cleanup is best effort.
  for (const close of [() => transport.room.disconnect(), () => transport.closeAudio()]) {
    try { await close(); } catch (cause) { void reportClientError('voice-cleanup', cause); }
  }
}

const NO_AGENTS: readonly RoomViewIdentity[] = [];

export function useVoiceCall(roomId: string, enabled: boolean, roomAgents: readonly RoomViewIdentity[] = NO_AGENTS) {
  const [call, setCall] = React.useState<VoiceCall | null>(null);
  const [joinedAgents, setJoinedAgents] = React.useState<{ roomId: string; agents: readonly RoomViewIdentity[] } | null>(null);
  const agents = joinedAgents?.roomId === roomId ? joinedAgents.agents : roomAgents;
  const [target, setTarget] = React.useState<string | null>(null);
  const [speaker, setSpeaker] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState(0);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [quotaExhausted, setQuotaExhausted] = React.useState(false);
  const quotaRef = React.useRef(false);
  const [firstAudioMs, setFirstAudioMs] = React.useState<number | null>(null);
  const [humans, setHumans] = React.useState(1);
  /** Counts turns dropped because no agent was named, so the tip line can flash. */
  const [unaddressed, setUnaddressed] = React.useState(0);
  const session = React.useRef<{ room: Room; callId: string; sessionId: string; closeAudio(): Promise<void> } | null>(null);
  const revision = React.useRef(0);
  const pending = React.useRef(false);
  const speakerRef = React.useRef<string | null>(null);
  const targetRef = React.useRef<string | null>(null);
  const cancelSilence = React.useRef<(() => Promise<void>) | undefined>(undefined);
  const mode = React.useRef<'active' | 'parking' | 'parked' | 'resuming' | 'ended'>('ended');
  const liveCleanup = React.useRef<(() => void) | null>(null);
  const joiningCleanup = React.useRef<(() => Promise<void>) | null>(null);

  const end = React.useCallback(async () => {
    revision.current++;
    const cancelDeadline = cancelSilence.current; cancelSilence.current = undefined;
    if (cancelDeadline) void cancelDeadline().catch(() => {});
    mode.current = 'ended';
    liveCleanup.current?.(); liveCleanup.current = null;
    const current = session.current; session.current = null;
    const cancelJoin = joiningCleanup.current; joiningCleanup.current = null;
    setCall(null); setSpeaker(null); setLevel(0); setConnecting(false); setError(null);
    setJoinedAgents(null); setTarget(null); targetRef.current = null; setHumans(1);
    speakerRef.current = null;
    if (cancelJoin) await cancelJoin();
    if (!current) return;
    await closeVoiceTransport(current);
    try { await voiceRequest(current.callId, 'leave', current.sessionId); } catch { /* RTC disconnect also removes the participant server-side. */ }
  }, []);
  React.useEffect(() => () => { void end(); }, [roomId, end]);
  React.useEffect(() => { if (!enabled) void end(); }, [enabled, end]);

  const join = React.useCallback(async () => {
    if (session.current || pending.current) return;
    if (!enabled) { setError('You cannot join Conversation mode in this Room.'); return; }
    pending.current = true; const version = ++revision.current;
    setConnecting(true); setError(null); setQuotaExhausted(false); quotaRef.current = false;
    let transport: Awaited<ReturnType<typeof createVoiceRoom>> | undefined;
    let joined: VoiceJoin | undefined;
    let closing: Promise<void> | undefined;
    let expireDeadline: () => Promise<void> = async () => {};
    const release = () => closing ??= closeVoiceTransport(transport);
    try {
      transport = await createVoiceRoom(() => { void end(); }, roomId, () => { void expireDeadline(); });
      joiningCleanup.current = release;
      if (version !== revision.current) { await release(); return; }
      joined = await voiceRequest<VoiceJoin>(roomId, 'join');
      if (version !== revision.current) { await release(); await voiceRequest(joined.call.id, 'leave', joined.sessionId); return; }
      await transport.configureStop(joined.call.id, joined.stopToken);
      if (version !== revision.current) { await release(); await voiceRequest(joined.call.id, 'leave', joined.sessionId); return; }
      setJoinedAgents({ roomId, agents: joined.agents });
      const { room } = transport;
      mode.current = 'active';
      const current = () => version === revision.current;
      cancelSilence.current = transport.cancelSilence;
      const armSilence = () => {
        if (!current() || mode.current !== 'active' || speakerRef.current) return;
        void transport!.armSilence().catch(cause => { if (current()) { void end(); setError(errorDiagnostic(cause).message); } });
      };
      const finishIdle = async () => {
        if (!current()) return;
        await transport!.idleEnd();
        if (current()) await end();
      };
      let checking = false; let checkAgain = false;
      const checkReply = async (): Promise<void> => {
        if (!current() || mode.current !== 'parked') return;
        if (checking) { checkAgain = true; return; }
        checking = true;
        try {
          do {
            checkAgain = false;
            const state = await voiceRequest<VoiceIdleState>(joined!.call.id, 'state', joined!.sessionId);
            if (!current() || mode.current !== 'parked') return;
            if (state.state === 'ended') { await finishIdle(); return; }
            if (state.state === 'ready') {
              mode.current = 'resuming';
              await transport!.resumeAudio();
              await voiceRequest(joined!.call.id, 'resume', joined!.sessionId);
              if (!current()) return;
              await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'resume', sessionId: joined!.sessionId })),
                { reliable: true, topic: VOICE_DATA_TOPIC });
              return;
            }
          } while (checkAgain && current() && mode.current === 'parked');
        } catch (cause) {
          if (current()) {
            if (mode.current === 'resuming') {
              if (current()) await transport!.parkAudio('agent').catch(() => {});
              if (current()) mode.current = 'parked';
            }
            if (current()) setError(errorDiagnostic(cause).message);
          }
        } finally { checking = false; }
      };
      const expireSilence = async () => {
        if (!current() || mode.current !== 'active' || speakerRef.current) return;
        mode.current = 'parking'; setLevel(0);
        try {
          await transport!.cancelSilence();
          await room.localParticipant.setMicrophoneEnabled(false);
          const state = await voiceRequest<VoiceIdleState>(joined!.call.id, 'idle', joined!.sessionId);
          if (!current()) return;
          if (state.state === 'ended') { await finishIdle(); return; }
          await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'park', sessionId: joined!.sessionId })),
            { reliable: true, topic: VOICE_DATA_TOPIC });
          await transport!.parkAudio(state.agentName ?? 'agent');
          if (!current()) return;
          mode.current = 'parked';
          await checkReply();
        } catch (cause) {
          if (current()) { await end(); setError(errorDiagnostic(cause).message); }
        }
      };
      expireDeadline = expireSilence;
      room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (version !== revision.current || topic !== VOICE_DATA_TOPIC || participant?.identity !== `beeline-voice-${joined!.call.id}`) return;
        try {
          const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
          if (data.type === 'stop') { void end(); return; }
          if (data.type === 'speech') armSilence();
          if (data.type === 'speaker') {
            speakerRef.current = data.agentId; setSpeaker(data.agentId);
            void transport!.cancelSilence().catch(() => { if (current()) void end(); });
            if (!data.agentId && mode.current === 'resuming') {
              void room.localParticipant.setMicrophoneEnabled(!quotaRef.current, { echoCancellation: true, noiseSuppression: true, autoGainControl: false })
                .then(() => { if (current()) { mode.current = 'active'; armSilence(); } }).catch(() => { void end(); });
            } else if (!data.agentId) armSilence();
          }
          if (data.type === 'target' && joined!.agents.some(agent => agent.pubkey === data.agentId)) {
            targetRef.current = data.agentId; setTarget(data.agentId);
          }
          if (data.type === 'error') {
            setError(data.message);
            if (data.code === 'speech-quota-exhausted') {
              quotaRef.current = true; setQuotaExhausted(true); setLevel(0);
              void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
            }
          }
          if (data.type === 'latency') setFirstAudioMs(data.firstAudioMs);
          if (data.type === 'humans') setHumans(data.count);
          if (data.type === 'unaddressed') setUnaddressed(count => count + 1);
        } catch {}
      });
      if (Platform.OS === 'web') {
        room.on(RoomEvent.TrackSubscribed, track => {
          if (track.kind !== Track.Kind.Audio) return;
          const element = track.attach(); element.dataset.beelineVoiceAudio = joined!.call.id;
          element.style.display = 'none'; document.body.appendChild(element);
        });
        room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(el => el.remove()));
      }
      let recovering = false;
      room.on(RoomEvent.Disconnected, () => {
        if (version !== revision.current || mode.current !== 'active' || session.current?.room !== room || recovering) return;
        recovering = true;
        void (async () => {
          // A full reconnect after token expiry needs a freshly authorized token.
          const fresh = await voiceRequest<VoiceJoin>(roomId, 'join');
          if (version !== revision.current) { await voiceRequest(fresh.call.id, 'leave', fresh.sessionId).catch(() => {}); return; }
          joined = fresh;
          await transport!.configureStop(fresh.call.id, fresh.stopToken);
          if (version !== revision.current) { await voiceRequest(fresh.call.id, 'leave', fresh.sessionId).catch(() => {}); return; }
          if (session.current?.room === room) { session.current.callId = fresh.call.id; session.current.sessionId = fresh.sessionId; }
          setCall(fresh.call);
          await room.connect(fresh.url, fresh.token);
          if (version !== revision.current) { await release(); await voiceRequest(fresh.call.id, 'leave', fresh.sessionId).catch(() => {}); return; }
          const agentId = targetRef.current;
          if (agentId) await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId })),
            { reliable: true, topic: VOICE_DATA_TOPIC });
          await room.localParticipant.setMicrophoneEnabled(!quotaRef.current, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
          if (version !== revision.current) await release();
        })().catch(cause => {
          if (version !== revision.current) return;
          void reportClientError('voice-join', cause);
          void end();
        }).finally(() => { recovering = false; });
      });
      await room.connect(joined.url, joined.token);
      if (version !== revision.current) { await release(); await voiceRequest(joined.call.id, 'leave', joined.sessionId); return; }
      const defaultTarget = joined.agents.find(a => a.pubkey === targetRef.current)?.pubkey ?? joined.agents[0]?.pubkey;
      if (defaultTarget) await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: defaultTarget })),
        { reliable: true, topic: VOICE_DATA_TOPIC });
      await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true,
        autoGainControl: false });
      if (quotaRef.current) await room.localParticipant.setMicrophoneEnabled(false);
      if (version !== revision.current) { await release(); await voiceRequest(joined.call.id, 'leave', joined.sessionId); return; }
      joiningCleanup.current = null;
      session.current = { ...transport, callId: joined.call.id, sessionId: joined.sessionId };
      setCall(joined.call); setTarget(defaultTarget ?? null); targetRef.current = defaultTarget ?? null;
      const updateLevel = () => {
        if (!current() || mode.current !== 'active') return;
        const bridge = `beeline-voice-${joined!.call.id}`;
        const bridgeLevel = room.remoteParticipants.get(bridge)?.audioLevel ?? 0;
        // A speaker signal can outlive playback; silent bridge audio must not hide the mic.
        const levels = speakerRef.current && bridgeLevel > 0 ? [bridgeLevel]
          : [room.localParticipant.audioLevel, ...[...room.remoteParticipants.values()].filter(p => p.identity !== bridge).map(p => p.audioLevel)];
        setLevel(quotaRef.current ? 0 : voiceWaveformLevel(Math.max(0, ...levels)));
      };
      room.on(RoomEvent.ActiveSpeakersChanged, updateLevel);
      const live = sharedLiveConnection();
      const reconcile = () => {
        if (mode.current === 'parked') void checkReply();
      };
      const dispose = await live.register([{ '#h': [roomId] }], reconcile);
      if (!current()) { dispose(); return; }
      const disconnectListener = live.subscribeConnected(reconcile);
      liveCleanup.current = () => { dispose(); disconnectListener(); };
      armSilence();
    } catch (cause) {
      void reportClientError('voice-join', cause);
      await release();
      if (joined) await voiceRequest(joined.call.id, 'leave', joined.sessionId).catch(() => {});
      if (version === revision.current) setError(errorDiagnostic(cause).message);
    } finally {
      if (joiningCleanup.current === release) joiningCleanup.current = null;
      pending.current = false;
      if (version === revision.current) setConnecting(false);
    }
  }, [enabled, roomId, end]);
  React.useEffect(() => {
    if (!enabled) return;
    return subscribeVoiceResume(roomId, () => { void join(); });
  }, [enabled, roomId, join]);
  const aim = React.useCallback((agentId: string) => {
    if (!agents.some(a => a.pubkey === agentId)) return;
    setTarget(agentId); targetRef.current = agentId;
    void session.current?.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId, tap: true })),
      { reliable: true, topic: VOICE_DATA_TOPIC });
  }, [agents]);
  return { call, agents, target, speaker, level, connecting, error, quotaExhausted, firstAudioMs, humans, unaddressed, join, end, aim };
}

export type VoiceCallState = ReturnType<typeof useVoiceCall>;
