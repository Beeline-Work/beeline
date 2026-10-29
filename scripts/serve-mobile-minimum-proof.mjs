import { createServer } from 'node:http';
import { request } from 'node:https';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { MOBILE_MINIMUM_SCHEMA } from '../apps/server/dist/mobile-minimum.js';

// Disposable local policy; every other app read uses the unchanged live service.
const database = new PgliteDatabase();
await database.query(MOBILE_MINIMUM_SCHEMA);
const policy = createBeelineServer({ database, auth: {}, phone: {}, daemon: {}, live: new LiveHub(), mediaMaximumBytes: 1,
  releaseNotify: { secret: 'local-proof-only', subscribeHelperRelease: () => () => {} },
});
await new Promise(resolve => policy.listen(8789, '127.0.0.1', resolve));
createServer((incoming, outgoing) => {
  if (incoming.url === '/v1/public/mobile-minimum') {
    fetch('http://127.0.0.1:8789/v1/public/mobile-minimum').then(async response => {
      outgoing.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(await response.text());
    }).catch(() => { outgoing.writeHead(503); outgoing.end('{}'); });
    return;
  }
  const upstream = request(`https://server.usebeeline.app${incoming.url}`, {
    method: incoming.method, headers: { ...incoming.headers, host: 'server.usebeeline.app' },
  }, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
  upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
}).listen(8788, '0.0.0.0', () => console.log('Local policy proxy: 8788; policy control: 127.0.0.1:8789'));
