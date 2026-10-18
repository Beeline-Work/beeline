import type { RoomViewIdentity } from './phone-types.js';

export const VOICE_QUOTA_MESSAGE = 'Daily voice limit reached. Try again tomorrow.';

/** Voice is a Room session; its speakers are existing member identities. */
export type VoiceCall = {
  id: string;
  roomId: string;
  startedAt: number;
  /** High-resolution creation order for live-card updates in the deck. */
  startedAtMs?: number;
  endedAt?: number;
  endReason?: 'silence';
  participants: readonly RoomViewIdentity[];
};

export type VoiceBudget = { remainingMs: number; resetAt: number; timeZone: string };

export type VoiceOwner = { callId: string; deviceId: string; sessionId: string; epoch: number };
export function readVoiceOwner(value: unknown): VoiceOwner | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as VoiceOwner;
  if (typeof v.callId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.callId) ||
    typeof v.deviceId !== 'string' || !v.deviceId.length || v.deviceId.length > 200 ||
    typeof v.sessionId !== 'string' || !v.sessionId.length || v.sessionId.length > 200 ||
    !Number.isSafeInteger(v.epoch) || v.epoch < 1) return undefined;
  return { callId: v.callId, deviceId: v.deviceId, sessionId: v.sessionId, epoch: v.epoch };
}
export type VoiceOwnershipState = { state: 'elsewhere' | 'replaced'; owner?: VoiceOwner };
export function readVoiceOwnershipState(value: unknown): VoiceOwnershipState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as VoiceOwnershipState;
  if (v.state !== 'elsewhere' && v.state !== 'replaced') return undefined;
  const owner = v.owner === undefined ? undefined : readVoiceOwner(v.owner);
  if (v.owner !== undefined && !owner) return undefined;
  return { state: v.state, ...(owner ? { owner } : {}) };
}

export type VoiceJoin = {
  deviceId?: string;
  epoch?: number;
  sessionId: string;
  /** Capability for native Stop only, fenced to this participant session. */
  stopToken: string;
  call: VoiceCall;
  url: string;
  token: string;
  agents: readonly RoomViewIdentity[];
};

/** Accept legacy receipts; validate ownership fields together when present. */
export function readVoiceJoin(value: unknown): VoiceJoin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as VoiceJoin;
  const call = readVoiceCall(v.call);
  if (!call || typeof v.sessionId !== 'string' || !v.sessionId.length ||
    typeof v.stopToken !== 'string' || !v.stopToken.length || typeof v.token !== 'string' || !v.token.length ||
    typeof v.url !== 'string' || !/^wss?:\/\//.test(v.url) || !Array.isArray(v.agents) ||
    !readVoiceCall({ ...call, participants: v.agents })) return undefined;
  if ((v.deviceId !== undefined || v.epoch !== undefined) && !readVoiceOwner({
    callId: call.id, deviceId: v.deviceId, sessionId: v.sessionId, epoch: v.epoch })) return undefined;
  return { sessionId: v.sessionId, stopToken: v.stopToken, call, url: v.url, token: v.token,
    agents: v.agents, ...(v.deviceId !== undefined ? {deviceId:v.deviceId,epoch:v.epoch} : {}) };
}

export type VoiceIdleState = { state: 'ended' | 'parked' | 'ready' | 'replaced'; agentName?: string };

export type VoiceSignal =
  | { type: 'budget'; budget: VoiceBudget }
  | { type: 'stop' }
  | { type: 'ending'; deadline: number | null; serverNow: number }
  | { type: 'resume' | 'park'; sessionId: string; epoch?: number }
  | { type: 'speech' }
  /** A tap also sends the next turn to this agent when several humans are in the call. */
  | { type: 'target'; agentId: string; tap?: boolean; sessionId?: string; epoch?: number }
  | { type: 'humans'; count: number }
  /** Several humans are in the call and this turn named no agent, so nobody answers. */
  | { type: 'unaddressed' }
  | { type: 'speaker'; agentId: string | null }
  | { type: 'error'; message: string; code?: 'speech-quota-exhausted' }
  | { type: 'latency'; firstAudioMs: number };

export const VOICE_DATA_TOPIC = 'beeline.voice.v1';
export const VOICE_LONG_PRESS_MS = 450;

export function voiceDuration(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(seconds));
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
}

export function readVoiceCall(value: unknown): VoiceCall | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const call = value as VoiceCall;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof call.id !== 'string' ||
    !uuid.test(call.id) ||
    typeof call.roomId !== 'string' ||
    !uuid.test(call.roomId) ||
    !Number.isFinite(call.startedAt) ||
    !Array.isArray(call.participants) ||
    (call.startedAtMs !== undefined && !Number.isFinite(call.startedAtMs)) ||
    (call.endedAt !== undefined && !Number.isFinite(call.endedAt)) ||
    (call.endReason !== undefined && call.endReason !== 'silence')
  )
    return undefined;
  if (
    !call.participants.every(
      (p) =>
        p &&
        typeof p.pubkey === 'string' &&
        /^[0-9a-f]{64}$/i.test(p.pubkey) &&
        typeof p.name === 'string' &&
        (p.kind === 'human' || p.kind === 'agent'),
    )
  )
    return undefined;
  return call;
}

/** The validated Aura library, with the agent's effective current voice. */
export type AgentVoiceCatalog = {
  currentVoiceId: string;
  canChange: boolean;
  choices: readonly { id: string; name: string }[];
};
export type AgentVoicePreview = { wavBase64: string };
export function readAgentVoiceCatalog(value: unknown): AgentVoiceCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as AgentVoiceCatalog;
  if (
    typeof v.currentVoiceId !== 'string' ||
    typeof v.canChange !== 'boolean' ||
    !Array.isArray(v.choices) ||
    !v.choices.length ||
    v.choices.length > 100 ||
    !v.choices.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        /^[a-z0-9][\w.-]{0,127}$/i.test(c.id) &&
        typeof c.name === 'string' &&
        c.name.length > 0 &&
        c.name.length <= 200,
    ) ||
    !v.choices.some((c) => c.id === v.currentVoiceId) ||
    new Set(v.choices.map((c) => c.id)).size !== v.choices.length
  )
    return null;
  return {
    currentVoiceId: v.currentVoiceId,
    canChange: v.canChange,
    choices: v.choices.map((c) => ({
      id: c.id,
      name: c.name,
    })),
  };
}
export function readAgentVoicePreview(value: unknown): AgentVoicePreview | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { wavBase64?: unknown };
  if (
    typeof v.wavBase64 === 'string' &&
    v.wavBase64.length <= 600000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(v.wavBase64)
  )
    return { wavBase64: v.wavBase64 };
  return null;
}
