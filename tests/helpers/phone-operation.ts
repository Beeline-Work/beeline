import WebSocket from 'ws';

/** Exercise the real socket while older feature fixtures retain their Response assertions. */
export const phoneFetch: typeof fetch = async (input, init) => {
  if (init?.method !== 'POST') return fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  let operation = url.pathname.match(/^\/v1\/phone\/operations\/([^/]+)$/)?.[1];
  const voice = url.pathname.match(/^\/v1\/phone\/voice\/([^/]+)\/(join|leave|idle|resume)$/);
  const mark = url.pathname.match(/^\/v1\/phone\/rooms\/([^/]+)\/(read|unread)$/);
  const observation = url.pathname.match(/^\/v1\/phone\/observations\/(client-error|page-load)$/);
  const profile = init?.method === 'POST' && url.pathname.match(/^\/v1\/phone\/workspaces\/([^/]+)\/agents\/([^/]+)\/(voices|voice-preview)$/);
  if (!operation && !voice && !mark && !observation && !profile) return fetch(input, init);
  const args = { ...Object.fromEntries(url.searchParams), ...JSON.parse(String(init?.body || '{}')) };
  if (voice) {
    operation = `voice${voice[2]![0]!.toUpperCase()}${voice[2]!.slice(1)}`;
    args[voice[2] === 'join' ? 'roomId' : 'callId'] = voice[1];
  }
  if (mark) { operation = mark[2] === 'read' ? 'markRead' : 'markUnread'; args.roomId = mark[1]; }
  if (observation) operation = observation[1] === 'client-error' ? 'reportClientError' : 'reportPageLoad';
  if (profile) {
    operation = profile[3] === 'voices' ? 'saveAgentVoice' : 'previewAgentVoice';
    args.workspaceId = profile[1]; args.agentId = profile[2];
  }
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
  return new Promise<Response>((resolve, reject) => {
    const socket = new WebSocket(`${url.origin.replace(/^http/, 'ws')}/v1/phone/live`, token ? [`bearer.${token}`] : []);
    socket.on('unexpected-response', async (_, response) => {
      let body = '';
      for await (const chunk of response) body += chunk;
      socket.terminate();
      resolve(new Response(body, { status: response.statusCode }));
    });
    socket.on('error', reject);
    socket.once('close', () => reject(new Error('Phone fixture socket closed before reply')));
    socket.on('open', () => socket.send(JSON.stringify({ t: 'req', id: 'fixture', op: operation, args })));
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.t !== 'res' || frame.id !== 'fixture') return;
      socket.terminate();
      if (frame.ok) resolve(frame.result == null ? new Response(null, { status: 204 }) : Response.json(frame.result));
      else {
        const code = frame.error.code;
        const status = code === 'unauthorized' ? 401 : code === 'access_denied' ? 403
          : code === 'not_found' || code === 'unknown_phone_operation' ? 404
          : code === 'conflict' ? 409 : code === 'query_too_broad' ? 422
          : code === 'too_many_requests' || code === 'voice-daily-limit' ? 429
          : frame.error.retryable ? 503 : 400;
        resolve(Response.json({ error: frame.error.message, ...(code === 'voice-daily-limit' ? { code } : {}) }, { status }));
      }
    });
  });
};
