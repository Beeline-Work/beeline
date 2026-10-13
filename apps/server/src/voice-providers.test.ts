import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { assignVoiceAgents, fluxFactory, KokoroSpeech, FishSpeech, AuraSpeech, OpenRouterVoiceBrain, VoiceQuotaError } from './voice-providers.js';
import { namedVoiceTarget } from './voice-room-runtime.js';

describe('voice providers', () => {
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
    const iterator = speech.synthesize('Hello', ids[0]!, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(new Uint8Array([7, 8]));
    const request = fetcher.mock.calls[1]![1]!;
    expect(request.headers).toMatchObject({ model: 's2.1-pro-free', authorization: 'Bearer test-key' });
    expect(JSON.parse(request.body as string)).toMatchObject({ format: 'pcm', sample_rate: 24000,
      reference_id: ids[0], latency: 'low' });
    finish(); expect((await iterator.next()).done).toBe(true);
  });
  it('keeps voices distinct and deterministic, with explicit soul timbre and exact named routing', () => {
    const agents = assignVoiceAgents([
      { id: 'b', name: 'Ruby', handle: 'ruby', soul: 'Voice: bf_emma\nThoughtful and warm.' },
      { id: 'a', name: 'Sol', handle: 'sol', soul: 'Voice: bf_emma\nConcise.' },
    ]);
    expect(agents).toEqual(assignVoiceAgents([...agents].reverse()));
    expect(new Set(agents.map(a => a.voice)).size).toBe(2);
    expect(namedVoiceTarget('resolution', agents, 'b')?.id).toBe('b');
    expect(namedVoiceTarget('Sol, please help Ruby', agents, 'b')?.id).toBe('a');
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
