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
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('livekit-client', () => ({ RoomEvent: { DataReceived: 'data', Disconnected: 'left', ActiveSpeakersChanged: 'levels' }, Track: {} }));
vi.mock('./voice-transport', () => ({ voiceFetch: (...args: unknown[]) => fixture.fetch(...args), subscribeVoiceResume: () => () => {}, createVoiceRoom: async (stop: () => void, _roomId: string, idle: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelSilence = async () => { clearTimeout(timer); timer = undefined; };
  fixture.stop = stop; return { configureStop: fixture.configureStop, armSilence: async () => { await cancelSilence(); timer = setTimeout(idle, 20_000); }, cancelSilence, room: fixture.room, closeAudio: async () => { await cancelSilence(); await fixture.closeAudio(); }, parkAudio: fixture.parkAudio, resumeAudio: fixture.resumeAudio, idleEnd: fixture.idleEnd };
} }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: (...args: unknown[]) => fixture.fetch(...args) } }));
fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({
  sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
  url: 'ws://proof', token: 'test', agents: [],
})));
import { useVoiceCall } from './use-voice-call';

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

it('accepts spoken Stop only from the trusted voice bridge and clears the lifetime timer', async () => {
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
    expect(voice.call?.id).toBe(fixture.callId);
    expect(fixture.closeAudio).not.toHaveBeenCalled();
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/leave'))).toHaveLength(0);
  } finally { await act(async () => renderer.unmount()); }
});

it.each(['ended', 'parked'] as const)('20 seconds of silence chooses %s and uses no recurring timer', async state => {
  vi.useFakeTimers(); fixture.fetch.mockClear(); fixture.parkAudio.mockClear(); fixture.idleEnd.mockClear();
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  fixture.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/idle') || url.includes('/state') ? { state, agentName: 'Ruby' }
      : { sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] }, url: 'ws://proof', token: 'test', agents: [] }
  )));
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    await act(async () => vi.advanceTimersByTimeAsync(19_999));
    expect(fixture.room.disconnect).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    if (state === 'ended') {
      expect(fixture.idleEnd).toHaveBeenCalledOnce(); expect(voice.call).toBeNull();
    } else {
      expect(fixture.parkAudio).toHaveBeenCalledWith('Ruby'); expect(voice.call).not.toBeNull();
      const reads = fixture.fetch.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(3_600_000));
      expect(fixture.fetch).toHaveBeenCalledTimes(reads);
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally { await act(async () => renderer.unmount()); vi.useRealTimers(); }
});

it('waits parked until a committed socket event, speaks the report, then reopens the mic', async () => {
  vi.useFakeTimers(); fixture.fetch.mockClear(); fixture.parkAudio.mockClear(); fixture.resumeAudio.mockClear();
  let ready = false;
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  fixture.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/idle') || url.includes('/state') ? { state: ready ? 'ready' : 'parked', agentName: 'Ruby' }
      : { sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] }, url: 'ws://proof', token: 'fresh', agents: [] }
  )));
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(fixture.parkAudio).toHaveBeenCalledOnce();
    ready = true;
    await act(async () => fixture.connected!());
    expect(fixture.resumeAudio).toHaveBeenCalledOnce();
    const controls = fixture.room.localParticipant.publishData.mock.calls.map(([bytes]: [Uint8Array]) => JSON.parse(new TextDecoder().decode(bytes)));
    expect(controls).toContainEqual({ type: 'park', sessionId: 'proof-session' });
    expect(controls).toContainEqual({ type: 'resume', sessionId: 'proof-session' });
    expect(fixture.room.connect).toHaveBeenCalledTimes(1);
    expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/join'))).toHaveLength(1);
    expect(fixture.fetch.mock.calls.some(([url]) => String(url).endsWith('/resume'))).toBe(true);
    expect(fixture.room.disconnect).not.toHaveBeenCalled();
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    const bridge = { identity: `beeline-voice-${fixture.callId}` };
    const signal = (agentId: string | null) => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({type:'speaker',agentId})), bridge, undefined, VOICE_DATA_TOPIC);
    await act(async () => signal('ruby'));
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await act(async () => signal(null));
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true, expect.any(Object));
    expect(vi.getTimerCount()).toBe(1);
  } finally { await act(async () => renderer.unmount()); vi.useRealTimers(); }
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
    expect(voice.level).toBeLessThan(quietMic);
    expect(voice.call).not.toBeNull();
  } finally { await act(async () => renderer.unmount()); vi.clearAllTimers(); vi.useRealTimers(); }
});

it.each(['recover', 'lasting', 'stop', 'other'] as const)('R1: parked resume network failure: %s', async outcome => {
  vi.useFakeTimers(); fixture.fetch.mockClear(); fixture.resumeAudio.mockClear();
  let failure: string | null = null;
  let ready = false;
  fixture.room = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    remoteParticipants: new Map(), localParticipant: { publishData: vi.fn(async () => {}), setMicrophoneEnabled: vi.fn(async () => {}) } });
  fixture.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/state') && failure) throw new Error(failure);
    return new Response(JSON.stringify(url.endsWith('/idle') || url.includes('/state')
      ? { state: ready ? 'ready' : 'parked', agentName: 'Ruby' }
      : { sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] }, url: 'ws://proof', token: 'test', agents: [] }));
  });
  let voice!: ReturnType<typeof useVoiceCall>; let renderer: any;
  function Probe() { voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { renderer = create(<Probe />); });
  try {
    await act(async () => voice.join());
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    failure = outcome === 'other' ? 'Permission denied' : 'fetch failed: java.net.UnknownHostException: Unable to resolve host "server.usebeeline.app": No address associated with hostname';
    ready = true;
    await act(async () => fixture.connected!());
    if (outcome === 'other') { expect(voice.error).toBe('Permission denied'); return; }
    expect(voice.error).toBeNull();
    expect(voice.call).not.toBeNull();
    if (outcome === 'recover') {
      failure = null;
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(fixture.resumeAudio).toHaveBeenCalledOnce();
      expect(voice.error).toBeNull();
      expect(voice.call).not.toBeNull();
      expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/join'))).toHaveLength(1);
    } else if (outcome === 'lasting') {
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(voice.error).toBe('Lost connection to Beeline. Check your network.');
      expect(vi.getTimerCount()).toBe(0);
    } else {
      await act(async () => voice.end());
      const requests = fixture.fetch.mock.calls.length;
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(fixture.fetch).toHaveBeenCalledTimes(requests);
      expect(voice.error).toBeNull();
      expect(voice.call).toBeNull();
    }
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
