import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { assignVoiceAgents, fluxFactory, AuraSpeech, OpenRouterVoiceBrain, VoiceQuotaError } from './voice-providers.js';
import { voiceConfigFromEnv } from './voice-service.js';
import { namedVoiceTarget } from './voice-room-runtime.js';

describe('voice providers', () => {
  it('configures Aura speech', () => {
    const config = voiceConfigFromEnv({ BEELINE_VOICE_OPENROUTER_API_KEY: 'test', LIVEKIT_URL: 'ws://test',
      LIVEKIT_API_KEY: 'test', LIVEKIT_API_SECRET: 'test', CLOUDFLARE_WORKERS_AI_TOKEN: 'test',
      CLOUDFLARE_ACCOUNT_ID: 'test' });
    expect(config?.speech).toBeInstanceOf(AuraSpeech);
  });

  it('classifies the same Workers AI quota response during Aura playback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ errors: [{ code: 4006 }] }), { status: 429 }));
    const reader = new AuraSpeech('test', 'account', fetcher).synthesize('Hello', 'luna', new AbortController().signal)[Symbol.asyncIterator]();
    await expect(reader.next()).rejects.toBeInstanceOf(VoiceQuotaError);
  });
  it('settles a rejected Flux upgrade with the explicit daily-quota error and closes the socket', async () => {
    class Socket extends EventEmitter { terminate = vi.fn(); close = vi.fn(); }
    const socket = new Socket();
    const opening = fluxFactory('test', 'account', () => socket as unknown as WebSocket)(vi.fn(), vi.fn());
    const failed = expect(opening).rejects.toBeInstanceOf(VoiceQuotaError);
    const response = Object.assign(new EventEmitter(), { statusCode: 429, destroy: vi.fn() });
    socket.emit('unexpected-response', {}, response);
    response.emit('data', JSON.stringify({ errors: [{ code: 4006, message: 'Daily free allocation exhausted' }] }));
    response.emit('end');
    await failed;
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('keeps voices distinct and deterministic, with explicit soul timbre and exact named routing', () => {
    const agents = assignVoiceAgents([
      { id: 'b', name: 'Ruby', handle: 'ruby', soul: 'Voice: luna\nThoughtful and warm.' },
      { id: 'a', name: 'Sol', handle: 'sol', soul: 'Voice: luna\nConcise.' },
    ]);
    expect(agents).toEqual(assignVoiceAgents([...agents].reverse()));
    expect(new Set(agents.map(a => a.voice)).size).toBe(2);
    expect(agents.find(a => a.id === 'a')?.voice).toBe('luna');
    expect(namedVoiceTarget('resolution', agents, 'b')?.id).toBe('b');
    expect(namedVoiceTarget('Sol, please help Ruby', agents, 'b')?.id).toBe('a');
  });

  it('requires a spoken name with multiple humans even after selecting an avatar', () => {
    const agents = assignVoiceAgents([
      { id: 'ruby', name: 'Ruby Rose', handle: 'ruby', soul: '' },
      { id: 'goose', name: 'Goosey', handle: 'goose', soul: '' },
    ]);
    expect(namedVoiceTarget('What do you think?', agents, 'ruby', 2)).toBeUndefined();
    expect(namedVoiceTarget('What do you think?', agents, 'goose', 1)?.id).toBe('goose');
    expect(namedVoiceTarget('Could you help me, GOOSEY?', agents, 'ruby', 2)).toBeUndefined();
    expect(namedVoiceTarget('Hey @GoOsE please', agents, 'ruby', 2)?.id).toBe('goose');
    expect(namedVoiceTarget('Hello RUBY ROSE', agents, 'goose', 2)?.id).toBe('ruby');
    expect(namedVoiceTarget('gooseberries', agents, 'ruby', 2)).toBeUndefined();
  });

  it('speaks as the existing agent with reasoning off and one ordinary order tool', async () => {
    const wire = 'data: {"choices":[{"delta":{"content":"I’ll "}}]}\n\ndata: {"choices":[{"delta":{"content":"work on that.","tool_calls":[{"function":{"name":"order"}}]}}]}\n\ndata: [DONE]\n\n';
    const fetcher = vi.fn(async () => new Response(wire));
    const brain = new OpenRouterVoiceBrain('secret', fetcher as typeof fetch);
    const text = vi.fn();
    const reply = await brain.answer({ id: 'a', name: 'Ruby', handle: 'ruby', soul: 'Warm.', voice: 'luna' },
      [{ role: 'user', content: 'Build it' }], text, new AbortController().signal);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.reasoning).toEqual({ effort: 'none', exclude: true });
    expect(body.messages[0].content).toContain('You are Ruby');
    expect(body.messages[0].content).toContain('Warm.');
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['order']);
    // Lookups the voice layer cannot see go to the real agent with a short spoken line.
    expect(body.messages[0].content).toContain('read, check or look up anything you cannot see here (other Rooms, corners, reports, memory, keys');
    expect(body.messages[0].content).toContain('call order at once and say only a short line such as "Checking."');
    expect(body.tools[0].function.description).toContain('any read or lookup of something outside this conversation');
    expect(reply).toEqual({ text: 'I’ll work on that.', order: true });
    expect(text.mock.calls.flat().join('')).toBe(reply.text);
  });

  it('reserves a later saved choice before automatic voices and stale soul overrides', () => {
    const agents = [
      { id: 'a', name: 'Auto', handle: 'auto', soul: 'Voice: luna' },
      {
        id: 'z',
        name: 'Chosen',
        handle: 'chosen',
        soul: 'Voice: apollo',
        chosenVoice: 'luna',
      },
    ];
    const assigned = assignVoiceAgents(agents, ['luna', 'apollo']);
    expect(assigned.find((a) => a.id === 'z')?.voice).toBe('luna');
    expect(assigned.find((a) => a.id === 'a')?.voice).toBe('apollo');
    expect(assignVoiceAgents([...agents].reverse(), ['luna', 'apollo'])).toEqual(assigned);
  });



  it('uses Flux raw LE PCM and suppresses duplicate/out-of-order events', async () => {
    class Socket extends EventEmitter {
      readyState = WebSocket.OPEN; bufferedAmount = 0;
      send = vi.fn(); close = vi.fn();
    }
    const socket = new Socket(); const accept = vi.fn(); const error = vi.fn();
    const connect = vi.fn(() => socket as unknown as WebSocket);
    const opening = fluxFactory('secret', 'account', connect)(accept, error);
    expect(connect.mock.calls[0]![0]).toContain('sample_rate=16000');
    expect(connect.mock.calls[0]![0]).toContain('@cf/deepgram/flux');
    socket.emit('open'); const stt = await opening;
    stt.send(new Int16Array([1, -2]));
    expect(socket.send).toHaveBeenCalledWith(Buffer.from([1, 0, 254, 255]));
    for (const sequence of [1, 1, 0, 2]) socket.emit('message', Buffer.from(JSON.stringify({ event: 'EndOfTurn', transcript: 'Hello', sequence_id: sequence, turn_index: 0 })));
    socket.emit('message', Buffer.from('not-json'));
    expect(accept).toHaveBeenCalledTimes(2);
    stt.close(); socket.emit('close'); expect(error).not.toHaveBeenCalled();
  });
});

describe('call provider deadlines', () => {
  const agent = { id: 'a', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' };
  it.each(['brain', 'speech'] as const)('%s aborts a fetch stalled before headers and accepts the next request', async kind => {
    vi.useFakeTimers();
    try {
      let requestSignal!: AbortSignal;
      const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
        requestSignal = init!.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }).mockImplementation(async () => new Response(kind === 'brain'
        ? 'data: {"choices":[{"delta":{"content":"Ready."}}]}\n\n' : new Uint8Array([200, 1])));
      const brain = new OpenRouterVoiceBrain('test', fetcher);
      const speech = new AuraSpeech('test', 'account', fetcher);
      const next = () => kind === 'brain' ? brain.answer(agent, [], vi.fn(), new AbortController().signal)
        : speech.synthesize('Ready.', 'luna', new AbortController().signal)[Symbol.asyncIterator]().next();
      const failed = expect(next()).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(kind === 'brain' ? 8000 : 5000);
      await failed;
      expect(requestSignal.aborted).toBe(true);
      await expect(next()).resolves.toBeDefined();
    } finally { vi.useRealTimers(); }
  });

  it.each(['brain', 'speech'] as const)('%s enforces the total stream budget after the first result', async kind => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(kind === 'brain' ? new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n') : new Uint8Array([1, 2]));
      }, cancel });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      const onText = vi.fn();
      let work: Promise<unknown>;
      if (kind === 'brain') work = new OpenRouterVoiceBrain('test', fetcher).answer(agent, [], onText, new AbortController().signal);
      else {
        const iterator = new AuraSpeech('test', 'account', fetcher).synthesize('Hello', 'luna', new AbortController().signal)[Symbol.asyncIterator]();
        await iterator.next(); work = iterator.next();
      }
      const failed = expect(work).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(kind === 'brain' ? 8000 : 5000);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(kind === 'brain' ? 12000 : 25000);
      await failed;
      expect(cancel).toHaveBeenCalledOnce();
      if (kind === 'brain') expect(onText.mock.calls).toEqual([['Hi']]);
    } finally { vi.useRealTimers(); }
  });
});

it.each(['brain', 'speech'] as const)('CALL-ERROR-1: %s times out after headers without a first result and cancels the body', async kind => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const signal = new AbortController();
    const text = vi.fn();
    const work = kind === 'brain' ? new OpenRouterVoiceBrain('test', fetcher).answer(
      { id: 'a', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' }, [], text, signal.signal)
      : new AuraSpeech('test', 'account', fetcher).synthesize('Hello', 'luna', signal.signal)[Symbol.asyncIterator]().next();
    const failed = expect(work).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(kind === 'brain' ? 8000 : 5000);
    await failed; expect(cancel).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('CALL-ERROR-1: late brain headers cannot emit text after timeout', async () => {
  vi.useFakeTimers();
  try {
    let late!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { late = resolve; }));
    const onText = vi.fn();
    const failed = expect(new OpenRouterVoiceBrain('test', fetcher).answer(
      { id: 'a', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' }, [], onText, new AbortController().signal)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8000); await failed;
    late(new Response('data: {"choices":[{"delta":{"content":"Stale reply"}}]}\n\n'));
    await vi.advanceTimersByTimeAsync(1);
    expect(onText).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it.each([
  'Short report.',
  'One whole sentence. '.repeat(300),
  'word '.repeat(1000),
  'é'.repeat(2100),
  '😀'.repeat(2100),
  'x'.repeat(4001),
])('chunks Aura text losslessly within the character budget (%#)', async text => {
  const requests: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const part = JSON.parse(init!.body as string).text as string;
    requests.push(part);
    return new Response(new Uint8Array([1, 2]));
  });
  for await (const _ of new AuraSpeech('test', 'account', fetcher).synthesize(text, 'luna', new AbortController().signal)) {}
  expect(requests.join('')).toBe(text);
  expect(requests.every(part => part.length <= 1800 && new TextDecoder().decode(new TextEncoder().encode(part)) === part)).toBe(true);
  if (text.length <= 1800) expect(requests).toEqual([text]);
  if (text.includes(' ')) expect(requests.slice(0, -1).every(part => part.endsWith(' '))).toBe(true);
  if (text.includes('. ')) expect(requests.slice(0, -1).every(part => part.endsWith('. '))).toBe(true);
});

it('does not start a new Aura request when aborted between chunks or before playback', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2])));
  const speech = new AuraSpeech('test', 'account', fetcher);
  const iterator = speech.synthesize('Ready. '.repeat(600), 'luna', controller.signal)[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  await expect(speech.synthesize('Hi.', 'luna', controller.signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('cancels an active later Aura request and retains its first-byte deadline', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(new Uint8Array([1, 2])))
      .mockImplementation(async () => new Response(new ReadableStream({ cancel })));
    const iterator = new AuraSpeech('test', 'account', fetcher).synthesize('Ready. '.repeat(600), 'luna', new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    const failed = expect(iterator.next()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('aborts the body of a later Aura request without starting another chunk', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(new Uint8Array([1, 2])))
    .mockImplementation(async () => new Response(new ReadableStream({ cancel })));
  const iterator = new AuraSpeech('test', 'account', fetcher).synthesize('Ready. '.repeat(900), 'luna', controller.signal)[Symbol.asyncIterator]();
  await iterator.next();
  const failed = expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  controller.abort();
  await failed;
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps long-report playback pacing outside the provider deadline', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2])));
    const iterator = new AuraSpeech('test', 'account', fetcher).synthesize('Ready. '.repeat(600), 'luna', new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    // Simulate RTC backpressure while the caller plays the current chunk.
    await vi.advanceTimersByTimeAsync(31000);
    const audio: Uint8Array[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      audio.push(next.value);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(audio).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('enforces the total provider budget when a later long-report chunk stalls after its first byte', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(new Uint8Array([1, 2])))
      .mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); }, cancel })));
    const iterator = new AuraSpeech('test', 'account', fetcher).synthesize('Ready. '.repeat(600), 'luna', new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    const failed = expect(iterator.next()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25000);
    await failed;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
