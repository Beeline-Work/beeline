import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({ room: undefined as any, live: undefined as (() => void) | undefined,
  fetch: vi.fn(), callId: '11111111-1111-4111-8111-111111111111', awake: new Set<string>(), changes: [] as string[],
  appState: new Set<(state: string) => void>() }));
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async (tag: string) => { fixture.awake.add(tag); fixture.changes.push(`on:${tag}`); },
  deactivateKeepAwake: async (tag: string) => { fixture.awake.delete(tag); fixture.changes.push(`off:${tag}`); },
}));
vi.mock('./client-error-report', async original => ({ ...await original<object>(), reportClientError: vi.fn(async () => {}) }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ subscribeConnected: () => () => {},
  register: async (_filters: unknown, listener: () => void) => { fixture.live = listener; return () => { fixture.live = undefined; }; } }) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { addEventListener: (_type: string, listener: (state: string) => void) => {
  fixture.appState.add(listener); return { remove: () => fixture.appState.delete(listener) };
} } }));
vi.mock('livekit-client', () => ({ RoomEvent: { DataReceived: 'data', Disconnected: 'left', ActiveSpeakersChanged: 'levels', AudioPlaybackStatusChanged: 'audio-ready' }, Track: {} }));
vi.mock('./voice-transport', () => ({ subscribeVoiceMicrophone: (room: any, onLevel: (level: number) => void) => { room.on('levels', () => onLevel(room.localParticipant.audioLevel ?? 0)); return () => {}; }, voiceFetch: (...args: unknown[]) => fixture.fetch(...args), subscribeVoiceResume: () => () => {},
  createVoiceRoom: async () => { fixture.room.startAudio ??= async () => {}; fixture.room.canPlaybackAudio ??= true; return ({ configureStop: async () => {}, room: fixture.room, closeAudio: async () => {} }); } }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
import { useVoiceCall } from './use-voice-call';

const joinResponse = () => new Response(JSON.stringify({
  sessionId: 'proof-session', call: { id: fixture.callId, roomId: fixture.callId, startedAt: 1, participants: [] },
  url: 'ws://proof', token: 'test', agents: [] }));

beforeEach(() => {
  fixture.awake.clear(); fixture.changes.length = 0;
  fixture.fetch.mockReset(); fixture.fetch.mockImplementation(async () => joinResponse());
  fixture.room = Object.assign(new EventEmitter(), { connect: async () => {}, disconnect: async () => {},
    remoteParticipants: new Map(), localParticipant: { publishData: async () => {}, setMicrophoneEnabled: async () => {} } });
});

/** Lets queued keep-awake changes settle. */
const leaveCalls = () => fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/leave')).length;
async function appState(state: string) { await act(async () => { for (const listener of [...fixture.appState]) listener(state); }); }

async function settle() { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); }
const screenOn = () => fixture.awake.has('conversation-mode');

async function mount(element?: (probe: React.ReactElement) => React.ReactElement) {
  const handle = { voice: undefined as unknown as ReturnType<typeof useVoiceCall>, renderer: undefined as any };
  function Probe() { handle.voice = useVoiceCall(fixture.callId, true); return null; }
  await act(async () => { handle.renderer = create(element ? element(<Probe />) : <Probe />); });
  await settle();
  return handle;
}

async function joined() {
  const handle = await mount();
  expect(screenOn()).toBe(false);
  await act(async () => handle.voice.join());
  await settle();
  expect(handle.voice.call).not.toBeNull();
  expect(screenOn()).toBe(true);
  return handle;
}

it('keeps the screen awake only while a Conversation mode call is active', async () => {
  let resolveConnect!: () => void;
  fixture.room.connect = () => new Promise<void>(resolve => { resolveConnect = resolve; });
  const { voice, renderer } = await mount();
  try {
    expect(screenOn()).toBe(false);
    let joining!: Promise<void>;
    await act(async () => { joining = voice.join(); });
    await settle();
    expect(screenOn()).toBe(false);
    await act(async () => { resolveConnect(); await joining; });
    await settle();
    expect(screenOn()).toBe(true);
    expect(fixture.changes).toEqual(['on:conversation-mode']);
  } finally { await act(async () => renderer.unmount()); }
});

it('never holds the screen when the join fails', async () => {
  fixture.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'no' }), { status: 500 }));
  const handle = await mount();
  try {
    await act(async () => handle.voice.join());
    await settle();
    expect(handle.voice.error).toBe('Couldn’t reach Beeline');
    expect(fixture.changes).toEqual([]);
  } finally { await act(async () => handle.renderer.unmount()); }
});

it.each([
  ['user hang-up', async (handle: Awaited<ReturnType<typeof joined>>) => { await act(async () => handle.voice.end()); }],
  ['remote end', async () => {
    await act(async () => fixture.room.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'stop' })),
      { identity: `beeline-voice-${fixture.callId}` }, undefined, VOICE_DATA_TOPIC));
  }],
  ['server call state ended', async () => {
    fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({ state: 'ended' })));
    await act(async () => fixture.live!());
  }],
  ['connection failure', async () => {
    fixture.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'gone' }), { status: 500 }));
    await act(async () => fixture.room.emit('left'));
  }],
  ['app backgrounding', async () => { await appState('background'); }],
  ['component unmount', async (handle: Awaited<ReturnType<typeof joined>>) => { await act(async () => handle.renderer.unmount()); }],
])('releases the screen after %s', async (_name, stop) => {
  const handle = await joined();
  try {
    await stop(handle);
    await settle();
    expect(screenOn()).toBe(false);
    expect(fixture.changes).toEqual(['on:conversation-mode', 'off:conversation-mode']);
  } finally { await act(async () => handle.renderer.unmount()); }
});

it('releases the screen when an error boundary replaces the call screen', async () => {
  let crash!: () => void;
  function Crash() { const [broken, setBroken] = React.useState(false); crash = () => setBroken(true); if (broken) throw new Error('render failed'); return null; }
  class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? null : this.props.children; }
  }
  const handle = await mount(probe => <Boundary>{probe}<Crash /></Boundary>);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => handle.voice.join());
    await settle();
    expect(screenOn()).toBe(true);
    await act(async () => crash());
    await settle();
    expect(screenOn()).toBe(false);
  } finally { log.mockRestore(); await act(async () => handle.renderer.unmount()); }
});

it('holds the screen again for a call started right after the previous one ended', async () => {
  const handle = await joined();
  try {
    await act(async () => { void handle.voice.end(); await handle.voice.join(); });
    await settle();
    expect(handle.voice.call).not.toBeNull();
    expect(screenOn()).toBe(true);
    await act(async () => handle.voice.end());
    await settle();
    expect(screenOn()).toBe(false);
  } finally { await act(async () => handle.renderer.unmount()); }
});

it('ends the call through the normal hang-up path when the app goes to the background', async () => {
  const handle = await joined();
  try {
    expect(leaveCalls()).toBe(0);
    await appState('background');
    await settle();
    expect(handle.voice.call).toBeNull();
    expect(leaveCalls()).toBe(1);
    expect(screenOn()).toBe(false);
    expect(fixture.appState.size).toBe(0);
  } finally { await act(async () => handle.renderer.unmount()); }
});

it('keeps the call through a brief inactive state that returns to active', async () => {
  const handle = await joined();
  try {
    await appState('inactive');
    await appState('active');
    await settle();
    expect(handle.voice.call).not.toBeNull();
    expect(leaveCalls()).toBe(0);
    expect(screenOn()).toBe(true);
  } finally { await act(async () => handle.renderer.unmount()); }
});

it('cancels a join that is still connecting when the app goes to the background', async () => {
  let resolveConnect!: () => void;
  fixture.room.connect = () => new Promise<void>(resolve => { resolveConnect = resolve; });
  const handle = await mount();
  try {
    let joining!: Promise<void>;
    await act(async () => { joining = handle.voice.join(); });
    await settle();
    expect(handle.voice.connecting).toBe(true);
    await appState('background');
    await act(async () => { resolveConnect(); await joining; });
    await settle();
    expect(handle.voice.call).toBeNull();
    expect(leaveCalls()).toBe(1);
    expect(fixture.changes).toEqual([]);
  } finally { await act(async () => handle.renderer.unmount()); }
});

it('ignores app state before any call starts', async () => {
  const handle = await mount();
  try {
    expect(fixture.appState.size).toBe(0);
    await appState('background');
    expect(leaveCalls()).toBe(0);
  } finally { await act(async () => handle.renderer.unmount()); }
});
