/** Dedicated, credential-free Fly edge for game documents. No application APIs. */
import { createServer, get } from 'node:http';
import { pathToFileURL } from 'node:url';

const headers = [
  'content-type',
  'content-security-policy',
  'permissions-policy',
  'referrer-policy',
  'x-content-type-options',
  'cache-control',
];
function readGame(url, host) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { host } }, (result) => {
      const chunks = [];
      let size = 0;
      result.on('data', (chunk) => {
        size += chunk.length;
        if (size > Math.ceil((25 * 1024 * 1024 * 4) / 3) + 64 * 1024)
          request.destroy(new Error('Game too large'));
        else chunks.push(chunk);
      });
      result.on('error', reject);
      result.on('end', () =>
        resolve({
          status: result.statusCode,
          headers: result.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.setTimeout(20_000, () => request.destroy(new Error('Game timeout')));
    request.on('error', reject);
  });
}
export function createGameProxy({
  origin = 'https://beeline-games.fly.dev',
  upstream = 'http://beeline-server.internal:8080',
} = {}) {
  const gameOrigin = new URL(origin);
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', gameOrigin);
    if (request.method !== 'GET' || !/^\/play\/[0-9a-f-]{36}$/.test(url.pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('Not found');
      return;
    }
    try {
      // Neither cookies nor caller headers cross this hop. The backend's game
      // host branch validates the capability and supplies the mandatory CSP.
      const result = await readGame(`${upstream}${url.pathname}${url.search}`, gameOrigin.host);
      const policy = result.headers['content-security-policy'];
      if (!policy?.includes('sandbox allow-scripts') || !policy.includes("default-src 'none'")) {
        throw new Error('Missing game sandbox policy');
      }
      response.writeHead(
        result.status,
        Object.fromEntries(
          headers.flatMap((name) => {
            const value = result.headers[name];
            return value ? [[name, value]] : [];
          }),
        ),
      );
      response.end(result.body);
    } catch {
      if (!response.headersSent)
        response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('Unavailable. Close and reopen it to try again.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createGameProxy({
    origin: process.env.BEELINE_GAME_ORIGIN,
    upstream: process.env.GAME_UPSTREAM,
  }).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}
