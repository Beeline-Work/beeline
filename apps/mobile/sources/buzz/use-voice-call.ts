import * as React from 'react';
import { Platform } from 'react-native';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { VOICE_DATA_TOPIC, type VoiceJoin, type VoiceSignal, type VoiceCall, type RoomViewIdentity } from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from './runtime-config';
import { createVoiceRoom } from './voice-transport';
import { errorDiagnostic, reportClientError } from './client-error-report';
import { voiceWaveformLevel } from './waveform-level';

async function voiceRequest<T>(id: string, action: 'join' | 'leave' | 'current'): Promise<T> {
  const response = await monolithSession.fetch(`${getBuzzRuntimeConfig().monolithUrl}/v1/phone/voice/${id}/${action}`,
    { method: action === 'current' ? 'GET' : 'POST' });
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
  const session = React.useRef<{ room: Room; callId: string; closeAudio(): Promise<void> } | null>(null);
  const revision = React.useRef(0);
  const pending = React.useRef(false);
  const speakerRef = React.useRef<string | null>(null);
  const targetRef = React.useRef<string | null>(null);

  const end = React.useCallback(async () => {
    revision.current++; pending.current = false;
    const current = session.current; session.current = null;
    setCall(null); setSpeaker(null); setLevel(0); setConnecting(false); setError(null);
    setJoinedAgents(null); setTarget(null); targetRef.current = null;
    speakerRef.current = null;
    if (!current) return;
    await closeVoiceTransport(current);
    try { await voiceRequest(current.callId, 'leave'); } catch { /* RTC disconnect also removes the participant server-side. */ }
  }, []);
  React.useEffect(() => () => { void end(); }, [roomId, end]);
  React.useEffect(() => { if (!enabled) void end(); }, [enabled, end]);

  const join = React.useCallback(async () => {
    if (!enabled || session.current || pending.current) return;
    pending.current = true; const version = ++revision.current;
    setConnecting(true); setError(null); setQuotaExhausted(false); quotaRef.current = false;
    let transport: Awaited<ReturnType<typeof createVoiceRoom>> | undefined;
    let joined: VoiceJoin | undefined;
    try {
      transport = await createVoiceRoom();
      joined = await voiceRequest<VoiceJoin>(roomId, 'join');
      if (version !== revision.current) { await transport.closeAudio(); await voiceRequest(joined.call.id, 'leave'); return; }
      setJoinedAgents({ roomId, agents: joined.agents });
      const { room } = transport;
      room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (topic !== VOICE_DATA_TOPIC || participant?.identity !== `beeline-voice-${joined!.call.id}`) return;
        try {
          const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
          if (data.type === 'speaker') { speakerRef.current = data.agentId; setSpeaker(data.agentId); }
          if (data.type === 'target') setTarget(data.agentId);
          if (data.type === 'error') {
            setError(data.message);
            if (data.code === 'speech-quota-exhausted') {
              quotaRef.current = true; setQuotaExhausted(true); setLevel(0);
              void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
            }
          }
          if (data.type === 'latency') setFirstAudioMs(data.firstAudioMs);
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
      room.on(RoomEvent.Disconnected, () => { if (session.current?.room === room) void end(); });
      await room.connect(joined.url, joined.token);
      const defaultTarget = joined.agents.find(a => a.pubkey === targetRef.current)?.pubkey ?? joined.agents[0]?.pubkey;
      if (defaultTarget) await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: defaultTarget })),
        { reliable: true, topic: VOICE_DATA_TOPIC });
      await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true,
        autoGainControl: false });
      if (quotaRef.current) await room.localParticipant.setMicrophoneEnabled(false);
      if (version !== revision.current) { await room.disconnect(); await transport.closeAudio(); await voiceRequest(joined.call.id, 'leave'); return; }
      session.current = { ...transport, callId: joined.call.id };
      setCall(joined.call); setTarget(defaultTarget ?? null); targetRef.current = defaultTarget ?? null;
      const timer = setInterval(() => {
        if (session.current?.room !== room) { clearInterval(timer); return; }
        const bridge = `beeline-voice-${joined!.call.id}`;
        const levels = speakerRef.current ? [room.remoteParticipants.get(bridge)?.audioLevel ?? 0]
          : [room.localParticipant.audioLevel, ...[...room.remoteParticipants.values()].filter(p => p.identity !== bridge).map(p => p.audioLevel)];
        setLevel(quotaRef.current ? 0 : voiceWaveformLevel(Math.max(0, ...levels)));
      }, 60);
    } catch (cause) {
      void reportClientError('voice-join', cause);
      await closeVoiceTransport(transport);
      if (joined) await voiceRequest(joined.call.id, 'leave').catch(() => {});
      if (version === revision.current) setError(errorDiagnostic(cause).message);
    } finally {
      if (version === revision.current) { pending.current = false; setConnecting(false); }
    }
  }, [enabled, roomId, end]);
  const aim = React.useCallback((agentId: string) => {
    if (!agents.some(a => a.pubkey === agentId)) return;
    setTarget(agentId); targetRef.current = agentId;
    void session.current?.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId })),
      { reliable: true, topic: VOICE_DATA_TOPIC });
  }, [agents]);
  return { call, agents, target, speaker, level, connecting, error, quotaExhausted, firstAudioMs, join, end, aim };
}

export type VoiceCallState = ReturnType<typeof useVoiceCall>;
