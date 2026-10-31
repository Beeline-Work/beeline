import { PhoneSocketError } from '@/sync/transport/phone-socket-error';

/** Voice control shares the app socket; audio still uses LiveKit. */
export async function voiceFetch(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  const match = /^\/v1\/phone\/voice\/([^/]+)\/(join|leave|current|state|idle|resume)$/.exec(url.pathname);
  if (!match) throw new Error('Invalid voice request');
  const [, id, action] = match;
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const { sharedLiveConnection } = await import('@/sync/transport/live-connection');
  const connection = sharedLiveConnection();
  const options = { timeoutMs: 20_000, signal: init.signal ?? undefined };
  try {
    const result = action === 'join' ? await connection.request('voiceJoin', { roomId: id!, ...body }, options)
      : action === 'current' ? await connection.request('voiceCurrent', { roomId: id! }, options)
      : action === 'state' ? await connection.request('voiceState', { callId: id!, sessionId: url.searchParams.get('sessionId') ?? undefined }, options)
      : action === 'leave' ? await connection.request('voiceLeave', { callId: id!, ...body }, options)
      : action === 'idle' ? await connection.request('voiceIdle', { callId: id!, ...body }, options)
      : await connection.request('voiceResume', { callId: id!, ...body }, options);
    return new Response(JSON.stringify(result), { status: 200 });
  } catch (error) {
    if (!(error instanceof PhoneSocketError)) throw error;
    return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status });
  }
}
