import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { VOICE_DATA_TOPIC, VOICE_QUOTA_MESSAGE } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({ room: undefined as any, closeAudio: vi.fn(async () => {}),
  configureStop: vi.fn(async (_callId: string, _token: string) => {}),
  stop: undefined as (() => void) | undefined,
  live: undefined as (() => void) | undefined,
  connected: undefined as (() => void) | undefined,
  parkAudio: vi.fn(async (_agent: string) => {}), resumeAudio: vi.fn(async () => {}), idleEnd: vi.fn(async () => {}),
  fetch: vi.fn(), callId: '11111111-1111-4111-8111-111111111111' }));
vi.mock('./client-error-report', async original => ({ ...await original<object>(), reportClientError: vi.fn(async () => {}) }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ subscribeConnected: (listener: () => void) => { fixture.connected = listener; return () => { fixture.connected = undefined; }; }, register: async (_filters: unknown, listener: () => void) => { fixture.live = listener; return () => { fixture.live = undefined; }; } }) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('livekit-client', () => ({ RoomEvent: { DataReceived: 'data', Disconnected: 'left', ActiveSpeakersChanged: 'levels', AudioPlaybackStatusChanged: 'audio-ready' }, Track: {} }));
vi.mock('./voice-transport', () => ({ subscribeVoiceMicrophone: (room: any, onLevel: (level: number) => void) => { room.on('levels', () => onLevel(room.localParticipant.audioLevel ?? 0)); return () => {}; }, voiceFetch: (...args: unknown[]) => fixture.fetch(...args), subscribeVoiceResume: () => () => {}, createVoiceRoom: async (stop: () => void) => {
  fixture.room.startAudio ??= async () => {}; fixture.room.canPlaybackAudio ??= true;
  fixture.stop = stop; return { configureStop: fixture.configureStop, room: fixture.room, closeAudio: fixture.closeAudio };
} }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: (...args: unknown[]) => fixture.fetch(...args) } }));
fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({
  sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
  url: 'ws://proof', token: 'test', agents: [],
})));
import { useVoiceCall } from './use-voice-call';
import { reportClientError } from './client-error-report';

it('Reproduction MOBILE-C: Stop during connect cancels the join without reporting a failure', async () => {
  let rejectConnect!: (error: Error) => void;
  vi.mocked(reportClientError).mockClear();
  fixture.closeAudio.mockClear(); fixture.fetch.mockClear();
  fixture.room = Object.assign(new EventEmitter(), {
    connect: () => new Promise<void>((_resolve, reject) => { rejectConnect = reject; }),
    disconnect: vi.fn(async () => { rejectConnect(new Error('Client initiated disconnect')); }),
    remoteParticipants: new Map(), localParticipant: {},
  });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    await act(async () => { fixture.stop!(); await joining; });
    expect(voice.call).toBeNull();
    expect(voice.error).toBeNull();
    expect(fixture.closeAudio).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/leave'))).toHaveLength(1);
    expect(reportClientError).not.toHaveBeenCalled();
  } finally { await act(async () => renderer.unmount()); }
});

it('notification Stop during RTC connect fences the late join and releases audio', async () => {
  let resolveConnect!: () => void;
  fixture.closeAudio.mockClear(); fixture.fetch.mockClear();
  fixture.room = Object.assign(new EventEmitter(), {
    connect: () => new Promise<void>(resolve => { resolveConnect = resolve; }), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) },
  });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    await act(async () => fixture.stop!());
    await act(async () => { resolveConnect(); await joining; });
    expect(voice.call).toBeNull();
    expect(fixture.closeAudio).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/leave'))).toHaveLength(1);
    console.log('notification Stop during connect => no joined call, audio released, server leave');
  } finally { await act(async () => renderer.unmount()); }
});

it('accepts whole-call end only from the trusted voice bridge', async () => {
  vi.useFakeTimers(); fixture.closeAudio.mockClear();
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    const stop = new TextEncoder().encode(JSON.stringify({ type: 'stop' }));
    await act(async () => fixture.room.emit('data', stop, { identity: 'peer' }, undefined, VOICE_DATA_TOPIC));
    expect(voice.call).not.toBeNull();
    await act(async () => fixture.room.emit('data', stop, { identity: `beeline-voice-${fixture.callId}` }, undefined, VOICE_DATA_TOPIC));
    expect(voice.call).toBeNull();
    expect(fixture.closeAudio).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { await act(async () => renderer.unmount()); vi.useRealTimers(); }
});

it('shows Room agents during a pending or failed join and clears the error on exit', async () => {
  vi.mocked(reportClientError).mockClear();
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
    expect(reportClientError).toHaveBeenCalledWith('voice-join', expect.objectContaining({ message: 'TLS roots missing' }));
    expect(voice.agents).toEqual(agents);
    await act(async () => voice.end());
    expect(voice.error).toBeNull();
  } finally { await act(async () => renderer.unmount()); }
});

it.each([
  ['sol', 'sol'],
  ['restricted', null],
])('uses the joined roster while RTC connects and validates early target %s', async (selected, expectedTarget) => {
  const agents = [{ pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby' },
    { pubkey: 'sol', kind: 'agent' as const, name: 'Sol' }];
  let resolveConnect!: () => void;
  fixture.room = Object.assign(new EventEmitter(), {
    connect: () => new Promise<void>(resolve => { resolveConnect = resolve; }), disconnect: async () => {},
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: async () => {} },
  });
  fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({
    sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
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
    if (expectedTarget) {
      const [bytes] = fixture.room.localParticipant.publishData.mock.calls[0];
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ type: 'target', agentId: expectedTarget, tap: true });
    } else expect(fixture.room.localParticipant.publishData).not.toHaveBeenCalled();
    await act(async () => voice.end());
  } finally { await act(async () => renderer.unmount()); }
});

it('maps captured mic audio through the fixed curve without remote override', async () => {
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
      await act(async () => fixture.room.emit('levels'));
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
    await act(async () => fixture.room.emit('levels'));
    expect(voice.level).toBeCloseTo(levels[3]);
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

it('err-1: clears a failed reply notice when the next agent speaker signal arrives', async () => {
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { audioLevel: 0, publishData: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    const bridge = { identity: `beeline-voice-${fixture.callId}` };
    const signal = (data: object) => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify(data)), bridge, undefined, VOICE_DATA_TOPIC);
    await act(async () => signal({ type: 'error', message: 'Voice reply unavailable; please try again' }));
    expect(voice.error).toBe('Voice reply unavailable; please try again');
    expect(voice.quotaExhausted).toBe(false);
    await act(async () => signal({ type: 'speaker', agentId: 'ruby' }));
    expect(voice.speaker).toBe('ruby');
    expect(voice.error).toBeNull();

    await act(async () => signal({ type: 'error', code: 'speech-quota-exhausted', message: VOICE_QUOTA_MESSAGE }));
    await act(async () => signal({ type: 'speaker', agentId: 'ruby' }));
    expect(voice.error).toBe(VOICE_QUOTA_MESSAGE);
    expect(voice.quotaExhausted).toBe(true);
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

it('keeps the second human in the joined call across roster rerenders without pinning from spoken target signals', async () => {
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
    expect(voice.target).toBeNull();
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: 'restricted' })), bridge, undefined, VOICE_DATA_TOPIC));
    expect(voice.target).toBeNull();
    await act(async () => voice.aim('ruby'));
    expect(voice.target).toBe('ruby');
    await act(async () => renderer.update(<Probe roster={[...agents]} />));
    expect(voice.target).toBe('ruby');
  } finally { await act(async () => renderer.unmount()); }
});

it('obtains a fresh authorized token after terminal RTC loss without ending the call', async () => {
  fixture.fetch.mockClear(); fixture.closeAudio.mockClear();
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({
      call: voice.call, url: 'ws://proof', token: 'renewed-token', agents: [],
    })));
    await act(async () => fixture.room.emit('left'));
    expect(fixture.room.connect).toHaveBeenLastCalledWith('ws://proof', 'renewed-token');
    const [pinSignal] = fixture.room.localParticipant.publishData.mock.calls.at(-1)!;
    expect(JSON.parse(new TextDecoder().decode(pinSignal))).toEqual({type:'unpin'});
    expect(voice.call?.id).toBe(fixture.callId);
    expect(fixture.closeAudio).not.toHaveBeenCalled();
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/leave'))).toHaveLength(0);
  } finally { await act(async () => renderer.unmount()); }
});

it('notification Stop fences a successor join while native Stop configuration is pending', async () => {
  fixture.fetch.mockClear();
  fixture.configureStop.mockReset().mockResolvedValue(undefined);
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({ sessionId: 'original', stopToken: 'stop',
    call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] }, url: 'ws://proof', token: 'rtc', agents: [] })));
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    let configured!: () => void;
    fixture.configureStop.mockImplementationOnce(() => new Promise<void>(resolve => { configured = resolve; }));
    fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ sessionId: 'successor', stopToken: 'stop-new',
      call: voice.call, url: 'ws://proof', token: 'rtc-new', agents: [] })));
    await act(async () => fixture.room.emit('left'));
    expect(configured).toBeDefined();
    await act(async () => fixture.stop!());
    await act(async () => configured());
    const sessions = fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/leave'))
      .map(([,init]) => JSON.parse(init.body).sessionId);
    expect(sessions).toContain('original');
    expect(sessions).toContain('successor');
    expect(fixture.room.connect).toHaveBeenCalledOnce();
    expect(voice.call).toBeNull();
  } finally { await act(async () => renderer.unmount()); }
});

it('call-feedback-1: follows the mic when a stale speaker signal outlives bridge audio', async () => {
  vi.useFakeTimers();
  const bridge = `beeline-voice-${fixture.callId}`;
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: async () => {},
    remoteParticipants: new Map([[bridge, { identity: bridge, audioLevel: 0 }]]),
    localParticipant: { audioLevel: 0.1, publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'speaker', agentId: 'ruby' })),
      { identity: bridge }, undefined, VOICE_DATA_TOPIC));
    await act(async () => fixture.room.emit('levels'));
    const quietMic = voice.level;
    expect(quietMic).toBeGreaterThan(0);
    fixture.room.localParticipant.audioLevel = 0.5;
    await act(async () => fixture.room.emit('levels'));
    expect(voice.level).toBeGreaterThan(quietMic);
    fixture.room.remoteParticipants.get(bridge).audioLevel = 0.01;
    await act(async () => fixture.room.emit('levels'));
    expect(voice.level).toBeGreaterThan(quietMic);
    expect(voice.call).not.toBeNull();
  } finally { await act(async () => renderer.unmount()); vi.clearAllTimers(); vi.useRealTimers(); }
});

it.each(['Network request failed', 'fetch failed'] as const)('retries join transport failure: %s', async message => {
  vi.useFakeTimers();
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({ sessionId: 'proof-session',
    call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] }, url: 'ws://proof', token: 'test', agents: [] })));
  fixture.fetch.mockRejectedValueOnce(new TypeError(message));
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    expect(voice.error).toBeNull();
    expect(voice.connecting).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await joining; });
    expect(voice.call?.id).toBe(fixture.callId);
    expect(voice.error).toBeNull();
  } finally { await act(async () => renderer.unmount()); vi.clearAllTimers(); vi.useRealTimers(); }
});

it.each([1,2])('call-wide-end-3: %s-human silence never parks the mic or removes a participant locally', async count => {
  vi.useFakeTimers(); fixture.fetch.mockClear();
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({type:'humans',count})),
      {identity:`beeline-voice-${fixture.callId}`}, undefined, VOICE_DATA_TOPIC));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(voice.call).not.toBeNull(); expect(voice.humans).toBe(count);
    expect(fixture.fetch.mock.calls.some(([url]) => /idle|leave/.test(String(url)))).toBe(false);
    expect(fixture.room.localParticipant.setMicrophoneEnabled.mock.calls.map(([enabled]: boolean[]) => enabled)).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await act(async () => renderer.unmount()); vi.useRealTimers(); }
});

it('call-wide-end-3: a terminal disconnect cannot restart an ended call', async () => {
  fixture.fetch.mockClear();
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    fixture.fetch.mockImplementationOnce(async (_url,init) => {
      expect(JSON.parse(init.body).expectedCallId).toBe(fixture.callId);
      return new Response(JSON.stringify({error:'voice session ended'}),{status:409});
    });
    await act(async () => fixture.room.emit('left'));
    expect(voice.call).toBeNull(); expect(fixture.room.connect).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer.unmount()); }
});

it('renders only a trusted server deadline, counts down without ending locally, and clears on cancellation', async () => {
  vi.useFakeTimers();
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({ sessionId: 'countdown-session',
    call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] }, url: 'ws://proof', token: 'test', agents: [] })));
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  const signal = (deadline: number | null, trusted = true) => fixture.room.emit('data',
    new TextEncoder().encode(JSON.stringify({ type: 'ending', deadline, serverNow: 1000 })),
    { identity: trusted ? `beeline-voice-${fixture.callId}` : 'peer' }, undefined, VOICE_DATA_TOPIC);
  try {
    await act(async () => voice.join());
    await act(async () => signal(16_000, false)); expect(voice.endingWarning).toBeUndefined();
    await act(async () => signal(16_000)); expect(voice.endingWarning).toBe('Ending in 15s');
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(voice.endingWarning).toBe('Ending in 10s');
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(voice.call).not.toBeNull();
    await act(async () => signal(null)); expect(voice.endingWarning).toBeUndefined();
  } finally { await act(async () => renderer.unmount()); vi.useRealTimers(); }
});

it('mute stays muted through RTC recovery and unmute restores the microphone', async () => {
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    await act(async () => voice.toggleMute());
    expect(voice.muted).toBe(true);
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await act(async () => fixture.room.emit('left'));
    expect(voice.muted).toBe(true);
    expect(fixture.room.localParticipant.setMicrophoneEnabled.mock.calls.at(-1)[0]).toBe(false);
    await act(async () => voice.toggleMute());
    expect(voice.muted).toBe(false);
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  } finally { await act(async () => renderer.unmount()); }
});



it('shows the workspace warning and retains the owner-midnight message when calls are exhausted', async () => {
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    const resetAt = Date.UTC(2026, 9, 18);
    const packet = (remainingMs: number) => new TextEncoder().encode(JSON.stringify({ type: 'budget',
      budget: { remainingMs, resetAt, timeZone: 'UTC' } }));
    await act(async () => fixture.room.emit('data', packet(120000), { identity: 'peer' }, undefined, VOICE_DATA_TOPIC));
    expect(voice.budgetWarning).toBeNull();
    await act(async () => fixture.room.emit('data', packet(120000), { identity: `beeline-voice-${fixture.callId}` }, undefined, VOICE_DATA_TOPIC));
    expect(voice.budgetWarning).toBe('2 min left today');
    await act(async () => fixture.room.emit('data', packet(59000), { identity: `beeline-voice-${fixture.callId}` }, undefined, VOICE_DATA_TOPIC));
    expect(voice.budgetWarning).toBe('59s left today');
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/warning'))).toHaveLength(0);
    await act(async () => fixture.room.emit('data', packet(0), { identity: `beeline-voice-${fixture.callId}` }, undefined, VOICE_DATA_TOPIC));
    expect(voice.call).toBeNull();
    expect(voice.error).toBe('Calls resume at 12:00 AM');
    expect(fixture.room.disconnect).toHaveBeenCalledOnce();
    fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'voice-daily-limit',
      budget: { remainingMs: 0, resetAt, timeZone: 'UTC' } }), { status: 429 }));
    await act(async () => voice.join());
    expect(voice.call).toBeNull();
    expect(voice.error).toBe('Calls resume at 12:00 AM');
  } finally { await act(async () => renderer.unmount()); }
});


it('VOICE-ROUTER-1: joining stays visible until mic publication and audio playback are ready', async () => {
  let publish!: () => void;
  fixture.room = Object.assign(new EventEmitter(), { canPlaybackAudio: false, startAudio: async () => {},
    connect: async () => {}, disconnect: async () => {}, remoteParticipants: new Map(),
    localParticipant: { publishData: async () => {}, setMicrophoneEnabled: () => new Promise<void>(resolve => { publish = resolve; }) } });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    expect(voice.connecting).toBe(true);
    await act(async () => { publish(); await joining; });
    expect(voice.connecting).toBe(true);
    await act(async () => { fixture.room.canPlaybackAudio = true; fixture.room.emit('audio-ready'); });
    expect(voice.connecting).toBe(false);
    await act(async () => voice.end());
  } finally { await act(async () => renderer.unmount()); }
});

it('Reproduction R3: join unpinned, pin, move, unpin, and ignore remote routing updates', async () => {
  const agents = [{ pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby' },
    { pubkey: 'sol', kind: 'agent' as const, name: 'Sol' }];
  const publishData = vi.fn(async () => {});
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: async () => {},
    remoteParticipants: new Map(), localParticipant: { publishData, setMicrophoneEnabled: async () => {} } });
  fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({
    sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
    url: 'wss://proof', token: 'test', agents,
  })));
  let voice!: ReturnType<typeof useVoiceCall>; let otherVoice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true, agents); otherVoice = useVoiceCall('other-participant', true, agents); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    expect(voice.target).toBeNull();
    expect(publishData).not.toHaveBeenCalled();
    await act(async () => voice.aim('ruby'));
    expect(voice.target).toBe('ruby');
    expect(otherVoice.target).toBeNull();
    await act(async () => otherVoice.aim('sol'));
    expect(otherVoice.target).toBe('sol');
    expect(voice.target).toBe('ruby');
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({type:'target',agentId:'sol'})),
      {identity:`beeline-voice-${fixture.callId}`}, undefined, VOICE_DATA_TOPIC));
    expect(voice.target).toBe('ruby');
    await act(async () => voice.aim('sol'));
    expect(voice.target).toBe('sol');
    await act(async () => voice.aim('sol'));
    expect(voice.target).toBeNull();
    const signals = publishData.mock.calls.map(args => JSON.parse(new TextDecoder().decode((args as unknown[])[0] as Uint8Array)));
    expect(signals).toEqual([{type:'target',agentId:'ruby',tap:true}, {type:'target',agentId:'sol',tap:true}, {type:'unpin'}]);
  } finally { await act(async () => renderer.unmount()); }
});
