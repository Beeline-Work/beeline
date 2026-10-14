import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { assignVoiceAgents, fluxFactory, DeepInfraKokoroSpeech, KokoroSpeech, FishSpeech, AuraSpeech, OpenRouterVoiceBrain, VoiceQuotaError } from './voice-providers.js';
import { voiceConfigFromEnv } from './voice-service.js';
import { namedVoiceTarget } from './voice-room-runtime.js';

describe('voice providers', () => {
  it('keeps Fish and Kokoro dormant even with their credentials configured', () => {
    const config = voiceConfigFromEnv({ BEELINE_VOICE_OPENROUTER_API_KEY: 'test', LIVEKIT_URL: 'ws://test',
      LIVEKIT_API_KEY: 'test', LIVEKIT_API_SECRET: 'test', CLOUDFLARE_WORKERS_AI_TOKEN: 'test',
      CLOUDFLARE_ACCOUNT_ID: 'test', FISH_AUDIO_API_KEY: 'test' });
    expect(config?.speech).toBeInstanceOf(AuraSpeech);
    expect(Object.keys(config?.providers ?? {})).toEqual(['aura-2']);
  });
  it('retains the dormant Kokoro adapter with its pinned provider for future reactivation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2])));
    const iterator = new DeepInfraKokoroSpeech('test', fetcher).synthesize('Hello', 'af_heart', new AbortController().signal);
    for await (const _bytes of iterator) { /* Mocked adapter only, never a live call. */ }
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
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
  it('selects licensed library voices and streams Fish PCM before the response ends', async () => {
    const ids = ['1'.repeat(32), '2'.repeat(32)];
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([7, 8])); finish = () => controller.close();
    } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ _id: ids[1] }, { _id: ids[0] }, { _id: ids[0] }, { _id: 'invalid' }],
    }))).mockResolvedValueOnce(new Response(body));
    const speech = new FishSpeech('test-key', fetcher);
    await Promise.all([speech.prepare(), speech.prepare()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('licensed=true');
    expect(speech.voices).toEqual(ids);
    const iterator = speech.synthesize('(excited) Hello', ids[0]!, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array([7, 8]));
    const request = fetcher.mock.calls[1]![1]!;
    expect(request.headers).toMatchObject({ model: 's2.1-pro-free', authorization: 'Bearer test-key' });
    expect(JSON.parse(request.body as string)).toMatchObject({ format: 'pcm', sample_rate: 24000,
      reference_id: ids[0], text:'[excited] Hello', latency: 'low' });
    finish(); expect((await iterator.next()).done).toBe(true);
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
    expect(namedVoiceTarget('Could you help me, GOOSEY?', agents, 'ruby', 2)?.id).toBe('goose');
    expect(namedVoiceTarget('Over to @GoOsE please', agents, 'ruby', 2)?.id).toBe('goose');
    expect(namedVoiceTarget('Hello RUBY ROSE', agents, 'goose', 2)?.id).toBe('ruby');
    expect(namedVoiceTarget('gooseberries', agents, 'ruby', 2)).toBeUndefined();
  });

  it('speaks as the existing agent with reasoning off and one ordinary order tool', async () => {
    const wire = 'data: {"choices":[{"delta":{"content":"I’ll "}}]}\n\ndata: {"choices":[{"delta":{"content":"work on that.","tool_calls":[{"function":{"name":"order"}}]}}]}\n\ndata: [DONE]\n\n';
    const fetcher = vi.fn(async () => new Response(wire));
    const brain = new OpenRouterVoiceBrain('secret', fetcher as typeof fetch);
    const text = vi.fn();
    const reply = await brain.answer({ id: 'a', name: 'Ruby', handle: 'ruby', soul: 'Warm.', voice: 'af_heart' },
      [{ role: 'user', content: 'Build it' }], text, new AbortController().signal);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.reasoning).toEqual({ effort: 'none', exclude: true });
    expect(body.messages[0].content).toContain('You are Ruby');
    expect(body.messages[0].content).toContain('Warm.');
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['order']);
    expect(reply).toEqual({ text: 'I’ll work on that.', order: true });
    expect(text.mock.calls.flat().join('')).toBe(reply.text);
  });

  it('reserves a later saved choice before automatic voices and stale soul overrides', () => {
    const agents = [
      { id: 'a', name: 'Auto', handle: 'auto', soul: 'Voice: af_heart' },
      {
        id: 'z',
        name: 'Chosen',
        handle: 'chosen',
        soul: 'Voice: bf_emma',
        chosenVoice: 'af_heart',
      },
    ];
    const assigned = assignVoiceAgents(agents, ['af_heart', 'bf_emma']);
    expect(assigned.find((a) => a.id === 'z')?.voice).toBe('af_heart');
    expect(assigned.find((a) => a.id === 'a')?.voice).toBe('bf_emma');
    expect(assignVoiceAgents([...agents].reverse(), ['af_heart', 'bf_emma'])).toEqual(assigned);
  });
  it('streams Fish emotion cues to speech without another generation or waiting for completion', async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"[excited] Great news, "}}]}\n\n',
          ),
        );
        finish = () => {
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        };
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const brain = new OpenRouterVoiceBrain('key', fetcher);
    const delta = vi.fn();
    const reply = brain.answer(
      {
        id: 'a',
        name: 'A',
        handle: 'a',
        soul: 'Warm',
        voice: '1'.repeat(32),
        voiceProvider: 'fish-s2.1-pro',
      },
      [],
      delta,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(delta).toHaveBeenCalledWith('[excited] Great news, '));
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request.messages[0].content).toContain('[empathetic]');
    expect(fetcher).toHaveBeenCalledOnce();
    finish();
    expect((await reply).text).toBe('[excited] Great news,');
  });
  it('streams Kokoro PCM without waiting for the rest of the body', async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2])); finish = () => controller.close();
    } });
    const fetcher = vi.fn(async () => new Response(body));
    const speech = new KokoroSpeech('secret', fetcher as typeof fetch);
    const reader = speech.synthesize('Hello', 'af_heart', new AbortController().signal)[Symbol.asyncIterator]();
    expect((await reader.next()).value).toEqual(new Uint8Array([1, 2]));
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ model: 'hexgrad/kokoro-82m', voice: 'af_heart', response_format: 'pcm' });
    finish(); expect((await reader.next()).done).toBe(true);
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
