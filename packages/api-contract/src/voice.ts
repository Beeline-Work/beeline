import type { RoomViewIdentity } from './phone-types.js';

export const VOICE_PROVIDERS = ['aura-2', 'kokoro-deepinfra', 'fish-s2.1-pro'] as const;
export type VoiceProvider = typeof VOICE_PROVIDERS[number];
export const DEFAULT_VOICE_PROVIDER: VoiceProvider = 'fish-s2.1-pro';
export const VOICE_QUOTA_MESSAGE = 'Daily voice limit reached. Try again tomorrow.';
export const VOICE_PROVIDER_LABELS: Record<VoiceProvider, string> = {
  'aura-2': 'Aura-2', 'kokoro-deepinfra': 'Kokoro', 'fish-s2.1-pro': 'Fish S2.1 Pro',
};

/** Voice is a Room session; its speakers are existing member identities. */
export type VoiceCall = {
  id: string;
  roomId: string;
  startedAt: number;
  /** High-resolution creation order for live-card updates in the deck. */
  startedAtMs?: number;
  endedAt?: number;
  participants: readonly RoomViewIdentity[];
};

export type VoiceJoin = {
  call: VoiceCall;
  url: string;
  token: string;
  agents: readonly RoomViewIdentity[];
};

export type VoiceSignal =
  | { type: 'target'; agentId: string }
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
  if (typeof call.id !== 'string' || !uuid.test(call.id) || typeof call.roomId !== 'string' || !uuid.test(call.roomId) ||
      !Number.isFinite(call.startedAt) || !Array.isArray(call.participants) ||
      (call.startedAtMs !== undefined && !Number.isFinite(call.startedAtMs)) ||
      (call.endedAt !== undefined && !Number.isFinite(call.endedAt))) return undefined;
  if (!call.participants.every(p => p && typeof p.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(p.pubkey) &&
      typeof p.name === 'string' && (p.kind === 'human' || p.kind === 'agent'))) return undefined;
  return call;
}
