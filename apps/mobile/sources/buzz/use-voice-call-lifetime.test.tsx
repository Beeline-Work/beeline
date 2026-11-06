import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { RoomEvent } from 'livekit-client';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  request: vi.fn(), closeAudio: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: {} }));
vi.mock('./voice-transport', () => ({
  subscribeVoiceMicrophone: () => () => {}, subscribeVoiceResume: () => () => {},
  createVoiceRoom: async () => ({
    configureStop: async () => {}, closeAudio: fixture.closeAudio,
    room: { on: (event: string, listener: (...args: any[]) => void) => fixture.listeners.set(event, listener),
      canPlaybackAudio: true, connect: async () => {}, startAudio: async () => {}, disconnect: fixture.disconnect,
      localParticipant: { setMicrophoneEnabled: async () => {}, publishData: async () => {} } },
  }),
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: fixture.request }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async () => () => {}, subscribeConnected: () => () => {},
}) }));
vi.mock('./client-error-report', () => ({ reportClientError: async () => {} }));
import { useVoiceCall } from './use-voice-call';

it('settles an RTC disconnect without joining the call a second time', async () => {
  fixture.request.mockImplementation(async name => name === 'voiceJoin' ? {
    call: { id: 'call', participants: [] }, sessionId: 'session', stopToken: 'stop',
    agents: [], url: 'wss://voice.invalid', token: 'fixture',
  } : { left: true });
  let state!: ReturnType<typeof useVoiceCall>;
  function Screen() { state = useVoiceCall('room', true); return null; }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Screen />); });
  try {
    await act(async () => { await state.join(); });
    expect(state.call?.id).toBe('call');
    await act(async () => { fixture.listeners.get(RoomEvent.Disconnected)!(); });
    expect(state.call).toBeNull();
    expect(fixture.request.mock.calls.filter(([name]) => name === 'voiceJoin')).toHaveLength(1);
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(fixture.closeAudio).toHaveBeenCalledOnce();
  } finally { await act(async () => tree.unmount()); }
});
