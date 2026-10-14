import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { VOICE_DATA_TOPIC, VOICE_QUOTA_MESSAGE } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({ room: undefined as any, closeAudio: vi.fn(async () => {}),
  fetch: vi.fn(), callId: '11111111-1111-4111-8111-111111111111' }));
vi.mock('./client-error-report', async original => ({ ...await original<object>(), reportClientError: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('livekit-client', () => ({ RoomEvent: { DataReceived: 'data', Disconnected: 'left' }, Track: {} }));
vi.mock('./voice-transport', () => ({ createVoiceRoom: async () => ({ room: fixture.room, closeAudio: fixture.closeAudio }) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: (...args: unknown[]) => fixture.fetch(...args) } }));
fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({
  call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
  url: 'ws://proof', token: 'test', agents: [],
})));
import { useVoiceCall } from './use-voice-call';

it('shows Room agents during a pending or failed join and clears the error on exit', async () => {
  const agents = [{ pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', face: 'ruby-face' }];
  let rejectJoin!: (error: Error) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectJoin = reject; }));
  fixture.room = { disconnect: vi.fn(async () => {}) };
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true, agents); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    expect(voice.agents).toEqual(agents);
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    expect(voice.connecting).toBe(true);
    expect(voice.agents).toEqual(agents);
    await act(async () => { rejectJoin(new Error('TLS roots missing')); await joining; });
    expect(voice.error).toBe('TLS roots missing');
    expect(voice.agents).toEqual(agents);
    await act(async () => voice.end());
    expect(voice.error).toBeNull();
  } finally { await act(async () => renderer.unmount()); }
});

it.each([
  ['sol', 'sol'],
  ['restricted', 'ruby'],
])('uses the joined roster while RTC connects and validates early target %s', async (selected, expectedTarget) => {
  const agents = [{ pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby' },
    { pubkey: 'sol', kind: 'agent' as const, name: 'Sol' }];
  let resolveConnect!: () => void;
  fixture.room = Object.assign(new EventEmitter(), {
    connect: () => new Promise<void>(resolve => { resolveConnect = resolve; }), disconnect: async () => {},
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: async () => {} },
  });
  fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({
    call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
    url: 'wss://proof', token: 'test', agents,
  })));
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true, [...agents, { pubkey: 'restricted', kind: 'agent', name: 'Restricted' }]); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.aim(selected));
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    expect(voice.connecting).toBe(true);
    expect(voice.agents).toEqual(agents);
    await act(async () => { resolveConnect(); await joining; });
    expect(voice.target).toBe(expectedTarget);
    const [bytes] = fixture.room.localParticipant.publishData.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ type: 'target', agentId: expectedTarget });
    await act(async () => voice.end());
  } finally { await act(async () => renderer.unmount()); }
});

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

it('preserves the connection error even if disconnect and audio cleanup also reject', async () => {
  fixture.closeAudio.mockRejectedValueOnce(new Error('audio cleanup failed'));
  fixture.closeAudio.mockClear();
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => { throw new Error('WebRTC failed before connecting'); },
    disconnect: async () => { throw new Error('disconnect failed'); }, remoteParticipants: new Map(), localParticipant: {} });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => { await expect(voice.join()).resolves.toBeUndefined(); });
    expect(voice.error).toBe('WebRTC failed before connecting');
    expect(fixture.closeAudio).toHaveBeenCalledOnce();
    expect(voice.connecting).toBe(false);
    expect(voice.call).toBeNull();
  } finally { await act(async () => renderer.unmount()); }
});

it('keeps the second human in the joined call across roster rerenders and follows spoken target signals', async () => {
  const agents = [{ pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby' }, { pubkey: 'goose', kind: 'agent' as const, name: 'Goosey' }];
  const call = { id: fixture.callId, roomId: fixture.callId, startedAt: 1,
    participants: [{ pubkey: 'first', kind: 'human', name: 'First' }, { pubkey: 'second', kind: 'human', name: 'Second' }] };
  fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ call, agents, url: 'ws://proof', token: 'test' })));
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe({ roster }: { roster: typeof agents }) { voice = useVoiceCall(fixture.callId, true, roster); return null; }
  await act(async () => { renderer = create(<Probe roster={agents} />); });
  try {
    await act(async () => { await Promise.all([voice.join(), voice.join()]); });
    expect(fixture.room.connect).toHaveBeenCalledOnce();
    expect(voice.call).toEqual(call);
    await act(async () => renderer.update(<Probe roster={[...agents]} />));
    expect(voice.call).toEqual(call);
    expect(fixture.room.disconnect).not.toHaveBeenCalled();
    const bridge = { identity: `beeline-voice-${fixture.callId}` };
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'goose' })), bridge, undefined, VOICE_DATA_TOPIC));
    expect(voice.target).toBe('goose');
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'restricted' })), bridge, undefined, VOICE_DATA_TOPIC));
    expect(voice.target).toBe('goose');
    await act(async () => voice.aim('ruby'));
    expect(voice.target).toBe('ruby');
  } finally { await act(async () => renderer.unmount()); }
});
