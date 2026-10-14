import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { VoiceService } from './voice-service.js';

const state = vi.hoisted(() => ({ room: undefined as any, streams: [] as ReadableStream<any>[] }));
vi.mock('@livekit/rtc-node', () => ({
  Room: class extends EventEmitter {
    remoteParticipants = new Map();
    localParticipant = { publishTrack: vi.fn(), publishData: vi.fn() };
    constructor() { super(); state.room = this; }
    async connect() {} async disconnect() {}
  },
  RoomEvent: { TrackSubscribed: 'track', TrackUnsubscribed: 'untrack', ParticipantDisconnected: 'left',
    DataReceived: 'data', Disconnected: 'closed' },
  AudioStream: class { constructor() { return state.streams.shift()!; } },
  AudioSource: class { clearQueue() {} async close() {} },
  LocalAudioTrack: { createAudioTrack: vi.fn() }, TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 }, TrackKind: { KIND_AUDIO: 1 }, AudioFrame: class {},
}));
import { VoiceRoomRuntime } from './voice-room-runtime.js';
import { VoiceQuotaError } from './voice-providers.js';

it('cancels microphone input and sends a targeted quota signal when Flux rejects the handshake', async () => {
  const cancel = vi.fn();
  state.streams = [new ReadableStream({ cancel })];
  const service = { owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
    stt: vi.fn(async () => { throw new VoiceQuotaError(); }) }, access: vi.fn(async () => {}),
    agents: vi.fn(async () => []), db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) },
    runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    state.room.emit('track', { kind: 1 }, {}, { identity: 'human' });
    await vi.waitFor(() => expect(state.room.localParticipant.publishData).toHaveBeenCalled());
    const [bytes, options] = state.room.localParticipant.publishData.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ code: 'speech-quota-exhausted', message: expect.stringContaining('Daily voice limit') });
    expect(options.destinationIdentities).toEqual(['human']);
    expect(cancel).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('buffers first microphone frames during authorization and ignores stale STT failures after a track replacement', async () => {
  let authorize!: () => void;
  const access = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { authorize = resolve; }))
    .mockResolvedValue(undefined);
  const callbacks: Array<() => void> = [];
  const inputs: Array<{ send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const service = {
    owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret',
      stt: vi.fn(async (_event, failure) => {
        callbacks.push(failure); const input = { send: vi.fn(), close: vi.fn() }; inputs.push(input); return input;
      }) },
    access, agents: vi.fn(async () => []),
    db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn(),
  } as unknown as VoiceService;
  let first!: ReadableStreamDefaultController<any>, second!: ReadableStreamDefaultController<any>;
  state.streams = [new ReadableStream({ start(c) { first = c; } }), new ReadableStream({ start(c) { second = c; } })];
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  try {
    const human = { identity: 'human' };
    state.room.emit('track', { kind: 1 }, {}, human);
    first.enqueue({ data: new Int16Array([123, 456]) });
    expect(inputs).toHaveLength(0);
    authorize();
    await vi.waitFor(() => expect(inputs[0]?.send).toHaveBeenCalledWith(new Int16Array([123, 456])));
    state.room.emit('track', { kind: 1 }, {}, human);
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    callbacks[0]!();
    second.enqueue({ data: new Int16Array([789]) });
    await vi.waitFor(() => expect(inputs[1]?.send).toHaveBeenCalledWith(new Int16Array([789])));
    expect(inputs[1]?.close).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('Reproduction voice-name-1: switches transcript, reply and voice together and retains the target', async () => {
  const agents = [
    { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'ruby-voice' },
    { id: 'candy', name: 'Candy', handle: 'candy', soul: '', voice: 'candy-voice' },
  ];
  const recordHuman = vi.fn(async () => 'source');
  const answer = vi.fn(async () => ({ text: '' }));
  const service = { owner: 'owner', config: { url: 'ws://local', apiKey: 'devkey', apiSecret: 'secret', brain: { answer } },
    agents: vi.fn(async () => agents), recordHuman, recordAnswer: vi.fn(async () => {}),
    db: { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) }, runtimeClosed: vi.fn() } as unknown as VoiceService;
  const runtime = await VoiceRoomRuntime.connect(service, 'call', 'room');
  // Exercise the turn boundary with transport/provider doubles, including actual playback selection.
  const play = vi.spyOn(runtime as any, 'play').mockResolvedValue(undefined);
  answer.mockImplementation(async (_agent?: any, _history?: any, delta?: any) => {
    delta?.('Here is my answer.'); return { text: 'Here is my answer.' };
  });
  try {
    for (const [text, expected] of [
      ['Ruby, hello', 'ruby'], ['hey Candie what do you think?', 'candy'],
      ['What does Ruby think?', 'candy'], ['Unknown, help', 'candy'], ['Ruby, come back', 'ruby'],
    ]) {
      await runtime.utterance('human', text!);
      expect(recordHuman.mock.lastCall?.[3]).toMatchObject({ id: expected, handle: expected });
      expect(answer.mock.lastCall?.[0]).toMatchObject({ id: expected });
      expect(play.mock.lastCall?.[1]).toMatchObject({ id: expected, voice: `${expected}-voice` });
      const signals = state.room.localParticipant.publishData.mock.calls.map(([bytes]: any[]) => JSON.parse(new TextDecoder().decode(bytes)));
      expect(signals.filter((s: any) => s.type === 'target').at(-1)).toEqual({ type: 'target', agentId: expected });
      console.log(`${text} => transcript/reply/voice/UI target ${expected}`);
    }
  } finally { await runtime.close(); }
});
