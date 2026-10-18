import * as React from 'react';
import { Platform } from 'react-native';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { VOICE_DATA_TOPIC, readAgentVoicePreview, type VoiceBudget, type VoiceJoin, type VoiceSignal, type VoiceCall, type RoomViewIdentity } from '@beeline/api-contract/phone';
import { getBuzzRuntimeConfig } from './runtime-config';
import { createVoiceRoom, subscribeVoiceResume, voiceFetch } from './voice-transport';
import { errorDiagnostic, reportClientError } from './client-error-report';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { voiceWaveformLevel } from './waveform-level';

function dailyLimitMessage(resetAt: number): string {
  return `Daily voice limit reached. Resets at ${new Date(resetAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

async function voiceRequest<T>(id: string, action: 'join' | 'leave' | 'current' | 'state' | 'warning', sessionId?: string, expectedCallId?: string): Promise<T> {
  const response = await voiceFetch(`${getBuzzRuntimeConfig().monolithUrl}/v1/phone/voice/${id}/${action}${action === 'state' && sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    { method: action === 'current' || action === 'state' ? 'GET' : 'POST',
      ...((sessionId || expectedCallId) && action !== 'state' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, expectedCallId }) } : {}) });
  const value = await response.json() as T & { error?: string; code?: string; budget?: VoiceBudget };
  if (!response.ok) throw new Error(value.code === 'voice-daily-limit' && value.budget
    ? dailyLimitMessage(value.budget.resetAt) : value.error ?? 'Conversation mode could not connect');
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
  const [endingDeadline, setEndingDeadline] = React.useState<number | null>(null);
  const [endingSeconds, setEndingSeconds] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (endingDeadline === null) { setEndingSeconds(null); return; }
    const update = () => setEndingSeconds(Math.max(0, Math.ceil((endingDeadline - Date.now()) / 1000)));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [endingDeadline]);
  const [call, setCall] = React.useState<VoiceCall | null>(null);
  const [joinedAgents, setJoinedAgents] = React.useState<{ roomId: string; agents: readonly RoomViewIdentity[] } | null>(null);
  const agents = joinedAgents?.roomId === roomId ? joinedAgents.agents : roomAgents;
  const [target, setTarget] = React.useState<string | null>(null);
  const [speaker, setSpeaker] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState(0);
  const [muted, setMuted] = React.useState(false);
  const mutedRef = React.useRef(false);
  const mutePending = React.useRef(false);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [quotaExhausted, setQuotaExhausted] = React.useState(false);
  const quotaRef = React.useRef(false);
  const [budgetWarning, setBudgetWarning] = React.useState<string | null>(null);
  const [warningAudio, setWarningAudio] = React.useState<string | null>(null);
  const [firstAudioMs, setFirstAudioMs] = React.useState<number | null>(null);
  const [humans, setHumans] = React.useState(1);
  /** Counts group turns that did not name or tap an agent. */
  const [unaddressed, setUnaddressed] = React.useState(0);
  const session = React.useRef<{ room: Room; callId: string; sessionId: string; closeAudio(): Promise<void> } | null>(null);
  const revision = React.useRef(0);
  const pending = React.useRef(false);
  const speakerRef = React.useRef<string | null>(null);
  const targetRef = React.useRef<string | null>(null);
  const mode = React.useRef<'active' | 'ended'>('ended');
  const liveCleanup = React.useRef<(() => void) | null>(null);
  const joiningCleanup = React.useRef<(() => Promise<void>) | null>(null);

  const retryWaiters = React.useRef(new Set<() => void>());

  const end = React.useCallback(async () => {
    revision.current++;
    for (const cancel of retryWaiters.current) cancel();
    mode.current = 'ended';
    setBudgetWarning(null); setWarningAudio(null);
    liveCleanup.current?.(); liveCleanup.current = null;
    const current = session.current; session.current = null;
    const cancelJoin = joiningCleanup.current; joiningCleanup.current = null;
    mutedRef.current = false; setMuted(false);
    setEndingDeadline(null); setCall(null); setSpeaker(null); setLevel(0); setConnecting(false); setError(null);
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
    const release = () => closing ??= closeVoiceTransport(transport);
    const current = () => version === revision.current;
    let budgetSpoken = false;
    const request = async <T,>(id: string, action: Parameters<typeof voiceRequest>[1], sessionId?: string, expectedCallId?: string): Promise<T> => {
      // Android can resume before DNS is ready. Retry only transport failures,
      // within this call's lifetime, for at most fifteen seconds of backoff.
      for (let attempt = 0; ; attempt++) {
        if (!current()) throw new Error('Conversation mode ended');
        try { return await voiceRequest<T>(id, action, sessionId, expectedCallId); }
        catch (cause) {
          if (!current()) throw cause;
          if (!/UnknownHostException|fetch failed|Network request failed|Failed to fetch/i.test(errorDiagnostic(cause).message)) throw cause;
          if (attempt === 4) throw new Error('Lost connection to Beeline. Check your network.');
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); retryWaiters.current.delete(finish); resolve(); };
            const timer = setTimeout(finish, 1_000 * 2 ** attempt);
            retryWaiters.current.add(finish);
          });
        }
      }
    };
    try {
      transport = await createVoiceRoom(() => { void end(); }, roomId);
      joiningCleanup.current = release;
      if (version !== revision.current) { await release(); return; }
      joined = await request<VoiceJoin>(roomId, 'join');
      if (version !== revision.current) { await release(); await voiceRequest(joined.call.id, 'leave', joined.sessionId); return; }
      await transport.configureStop(joined.call.id, joined.stopToken);
      if (version !== revision.current) { await release(); await voiceRequest(joined.call.id, 'leave', joined.sessionId); return; }
      setJoinedAgents({ roomId, agents: joined.agents });
      const { room } = transport;
      let humanCount = joined.call.participants.filter(p => p.kind === 'human').length;
      setHumans(humanCount);
      mode.current = 'active';
      room.on(RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
        if (version !== revision.current || topic !== VOICE_DATA_TOPIC || participant?.identity !== `beeline-voice-${joined!.call.id}`) return;
        try {
          const data = JSON.parse(new TextDecoder().decode(bytes)) as VoiceSignal;
          if (data.type === 'budget') {
            const budget: VoiceBudget = data.budget;
            if (!budget || !Number.isFinite(budget.remainingMs) || budget.remainingMs < 0 ||
              !Number.isFinite(budget.resetAt) || budget.timeZone !== 'UTC') return;
            if (budget.remainingMs === 0) {
              // Fence reconnection before the server removes this RTC participant.
              const message = dailyLimitMessage(budget.resetAt);
              const endedVersion = revision.current + 1;
              void end().then(() => { if (revision.current === endedVersion) setError(message); });
              return;
            }
            setBudgetWarning(budget.remainingMs >= 60_000
              ? `${Math.ceil(budget.remainingMs / 60_000)} min left today`
              : `${Math.ceil(budget.remainingMs / 1000)}s left today`);
            if (budgetSpoken) return;
            budgetSpoken = true;
            void voiceRequest<unknown>(joined!.call.id, 'warning').then(value => {
              const audio = readAgentVoicePreview(value);
              if (current() && audio) setWarningAudio(`data:audio/wav;base64,${audio.wavBase64}`);
            }).catch(cause => { if (current()) void reportClientError('conversation', cause); });
            return;
          }
          if (data.type === 'stop') { void end(); return; }
          if (data.type === 'ending') {
            if (data.deadline === null) setEndingDeadline(null);
            else if (Number.isFinite(data.deadline) && Number.isFinite(data.serverNow))
              setEndingDeadline(Date.now() + Math.max(0, data.deadline - data.serverNow));
          }
          if (data.type === 'speaker') {
            speakerRef.current = data.agentId; setSpeaker(data.agentId);
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
          if (data.type === 'humans') {
            humanCount = data.count; setHumans(data.count);
          }
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
          const fresh = await request<VoiceJoin>(roomId, 'join', undefined, joined!.call.id);
          if (version !== revision.current) { await voiceRequest(fresh.call.id, 'leave', fresh.sessionId).catch(() => {}); return; }
          if (fresh.call.id !== joined!.call.id) { await voiceRequest(fresh.call.id, 'leave', fresh.sessionId); await end(); return; }
          joined = fresh;
          humanCount = fresh.call.participants.filter(p => p.kind === 'human').length; setHumans(humanCount);
          await transport!.configureStop(fresh.call.id, fresh.stopToken);
          if (version !== revision.current) { await voiceRequest(fresh.call.id, 'leave', fresh.sessionId).catch(() => {}); return; }
          if (session.current?.room === room) { session.current.callId = fresh.call.id; session.current.sessionId = fresh.sessionId; }
          setCall(fresh.call);
          await room.connect(fresh.url, fresh.token);
          if (version !== revision.current) { await release(); await voiceRequest(fresh.call.id, 'leave', fresh.sessionId).catch(() => {}); return; }
          const agentId = targetRef.current;
          if (agentId) await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId })),
            { reliable: true, topic: VOICE_DATA_TOPIC });
          await room.localParticipant.setMicrophoneEnabled(!quotaRef.current && !mutedRef.current, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
          if (version !== revision.current) await release();
        })().catch(cause => {
          if (version !== revision.current) return;
          void reportClientError('voice-join', cause);
          void end();
          setError(errorDiagnostic(cause).message);
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
        const active = joined!;
        void request<{ state: string }>(active.call.id, 'state', active.sessionId).then(state => {
          if (current() && joined === active && state.state === 'ended') {
            void end();
          }
        }).catch(() => {});
      };
      const dispose = await live.register([{ '#h': [roomId] }], reconcile);
      if (!current()) { dispose(); return; }
      const disconnectListener = live.subscribeConnected(reconcile);
      liveCleanup.current = () => { dispose(); disconnectListener(); };
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
  const toggleMute = React.useCallback(async () => {
    const current = session.current;
    if (!current || mutePending.current || quotaRef.current) return;
    mutePending.current = true;
    const next = !mutedRef.current;
    try {
      await current.room.localParticipant.setMicrophoneEnabled(!next);
      if (session.current === current) { mutedRef.current = next; setMuted(next); }
    } catch (cause) { void reportClientError('voice-join', cause); }
    finally { mutePending.current = false; }
  }, []);
  return { budgetWarning, warningAudio, clearWarningAudio: () => setWarningAudio(null), muted, toggleMute, endingWarning: endingSeconds === null ? undefined : `Ending in ${endingSeconds}s`, call, agents, target, speaker, level, connecting, error, quotaExhausted, firstAudioMs, humans, unaddressed, join, end, aim };
}

export type VoiceCallState = ReturnType<typeof useVoiceCall>;
