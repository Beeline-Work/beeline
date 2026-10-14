import type { RoomViewIdentity } from './phone-types.js';

// Retain legacy wire types for stored settings; only Aura 2 is selectable.
export type VoiceProvider = 'aura-2' | 'kokoro-deepinfra' | 'fish-s2.1-pro';
export const VOICE_PROVIDERS: readonly VoiceProvider[] = ['aura-2'];
export const DEFAULT_VOICE_PROVIDER: VoiceProvider = 'aura-2';
export const VOICE_QUOTA_MESSAGE = 'Daily voice limit reached. Try again tomorrow.';
export const VOICE_PROVIDER_LABELS: Record<VoiceProvider, string> = {
  'aura-2': 'Aura 2',
  'kokoro-deepinfra': 'Kokoro',
  'fish-s2.1-pro': 'Fish S2.1 Pro',
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
  if (
    typeof call.id !== 'string' ||
    !uuid.test(call.id) ||
    typeof call.roomId !== 'string' ||
    !uuid.test(call.roomId) ||
    !Number.isFinite(call.startedAt) ||
    !Array.isArray(call.participants) ||
    (call.startedAtMs !== undefined && !Number.isFinite(call.startedAtMs)) ||
    (call.endedAt !== undefined && !Number.isFinite(call.endedAt))
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

/** A Workspace provider's validated library, with the agent's effective current voice. */
export type AgentVoiceCatalog = {
  provider: VoiceProvider;
  currentVoiceId: string;
  canChange: boolean;
  choices: readonly { id: string; name: string; sampleUrl?: string }[];
};
export type AgentVoicePreview = { url: string } | { wavBase64: string };
export function readAgentVoiceCatalog(value: unknown): AgentVoiceCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as AgentVoiceCatalog;
  if (
    !VOICE_PROVIDERS.includes(v.provider) ||
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
        c.name.length <= 200 &&
        (c.sampleUrl === undefined || /^https:\/\/platform\.r2\.fish\.audio\//.test(c.sampleUrl)),
    ) ||
    !v.choices.some((c) => c.id === v.currentVoiceId) ||
    new Set(v.choices.map((c) => c.id)).size !== v.choices.length
  )
    return null;
  return {
    provider: v.provider,
    currentVoiceId: v.currentVoiceId,
    canChange: v.canChange,
    choices: v.choices.map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.sampleUrl ? { sampleUrl: c.sampleUrl } : {}),
    })),
  };
}
export function readAgentVoicePreview(value: unknown): AgentVoicePreview | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { url?: unknown; wavBase64?: unknown };
  if (typeof v.url === 'string' && /^https:\/\/platform\.r2\.fish\.audio\//.test(v.url))
    return { url: v.url };
  if (
    typeof v.wavBase64 === 'string' &&
    v.wavBase64.length <= 600000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(v.wavBase64)
  )
    return { wavBase64: v.wavBase64 };
  return null;
}
