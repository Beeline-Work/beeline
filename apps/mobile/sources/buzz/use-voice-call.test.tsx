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

it('maps local and bridge audio levels through the same fixed volume curve', async () => {
  vi.useFakeTimers();
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: async () => {},
    remoteParticipants: new Map(), localParticipant: { audioLevel: 0, publishData: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true,
      expect.objectContaining({ autoGainControl: false }));
    const levels: number[] = [];
    for (const amplitude of [0, 0.01, 0.1, 10 ** (-5 / 20)]) {
      fixture.room.localParticipant.audioLevel = amplitude;
      await act(async () => vi.advanceTimersByTime(60));
      levels.push(voice.level);
    }
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeGreaterThan(0);
    expect(levels[1]).toBeLessThan(levels[2]);
    expect(levels[2]).toBeLessThan(levels[3]);
    expect(levels[3]).toBe(1);
    const bridge = `beeline-voice-${fixture.callId}`;
    fixture.room.remoteParticipants.set(bridge, { audioLevel: 0.1 });
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'speaker', agentId: 'agent' })),
      { identity: bridge }, undefined, VOICE_DATA_TOPIC));
    await act(async () => vi.advanceTimersByTime(60));
    expect(voice.level).toBeCloseTo(levels[2]);
    await act(async () => voice.end());
  } finally {
    await act(async () => renderer.unmount());
    vi.clearAllTimers(); vi.useRealTimers();
  }
});

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
