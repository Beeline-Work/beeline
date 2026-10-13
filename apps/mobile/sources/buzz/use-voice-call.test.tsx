import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { VOICE_DATA_TOPIC, VOICE_QUOTA_MESSAGE } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({ room: undefined as any, callId: '11111111-1111-4111-8111-111111111111' }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('livekit-client', () => ({ RoomEvent: { DataReceived: 'data', Disconnected: 'left' }, Track: {} }));
vi.mock('./voice-transport', () => ({ createVoiceRoom: async () => ({ room: fixture.room, closeAudio: async () => {} }) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: async () => new Response(JSON.stringify({
  call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
  url: 'ws://proof', token: 'test', agents: [],
})) } }));
import { useVoiceCall } from './use-voice-call';

it('ignores a peer error and mutes the microphone on the trusted bridge quota signal', async () => {
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: async () => {},
    remoteParticipants: new Map(), localParticipant: { audioLevel: 0, publishData: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'error', code: 'speech-quota-exhausted', message: VOICE_QUOTA_MESSAGE }));
    await act(async () => fixture.room.emit('data', bytes, { identity: 'peer' }, undefined, VOICE_DATA_TOPIC));
    expect(voice.quotaExhausted).toBe(false);
    await act(async () => fixture.room.emit('data', bytes, { identity: `beeline-voice-${fixture.callId}` }, undefined, VOICE_DATA_TOPIC));
    expect(voice.quotaExhausted).toBe(true);
    expect(voice.error).toBe(VOICE_QUOTA_MESSAGE);
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(voice.connecting).toBe(false);
    await act(async () => voice.end());
  } finally { await act(async () => renderer.unmount()); }
});
