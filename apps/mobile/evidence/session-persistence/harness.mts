import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { PgliteDatabase } from '../../../server/src/test-support.ts';
import { migrate } from '../../../server/src/database.ts';
import { TokenAuth } from '../../../server/src/auth.ts';
import { PhoneService } from '../../../server/src/phone-service.ts';
import { DaemonService } from '../../../server/src/daemon-service.ts';
import { LiveHub } from '../../../server/src/live.ts';
import { ReviewAccess } from '../../../server/src/review-access.ts';
import { createBeelineServer } from '../../../server/src/server.ts';

const database = new PgliteDatabase();
await migrate(database);
const origin = 'http://10.0.2.2:45861';
let server: ReturnType<typeof createBeelineServer>;
let generation = 0, dropNextRefresh = false, ota = false, dropped = 0, renewals = 0, signIns = 0;
const secret = 'isolated-session-proof-secret-1234';

async function deploy() {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const live = new LiveHub();
  const auth = new TokenAuth(database, async () => { throw new Error('No GitHub in isolated proof'); });
  const phone = new PhoneService(database, origin);
  const daemon = {} as DaemonService;
  const review = new ReviewAccess({ secret, mint: () => auth.exchangeReviewIdentity() });
  server = createBeelineServer({ database, auth, phone, daemon, live, review, mediaMaximumBytes: 1 });
  await new Promise<void>(resolve => server.listen(45862, '127.0.0.1', resolve));
  console.log(JSON.stringify({ event: 'deployed', generation: ++generation, at: new Date().toISOString() }));
}
await deploy();

const proxy = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/_proof/')) {
    if (path === '/_proof/deploy') await deploy();
    if (path === '/_proof/drop-next-refresh') dropNextRefresh = true;
    if (path === '/_proof/publish-ota') ota = true;
    const sessions = await database.query('SELECT count(*) count FROM phone_sessions');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ generation, dropped, renewals, signIns, ota, sessions: sessions.rows[0]?.count }));
    return;
  }
  if (path === '/updates') {
    console.log(JSON.stringify({ event: 'ota-check', published: ota, at: new Date().toISOString() }));
    if (!ota || !existsSync('.task-proof/ota-manifest.json')) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'cache-control': 'no-store' });
    res.end(readFileSync('.task-proof/ota-manifest.json'));
    return;
  }
  if (path === '/ota.bundle') {
    console.log(JSON.stringify({ event: 'ota-bundle-download', at: new Date().toISOString() }));
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(readFileSync('.task-proof/ota.bundle'));
    return;
  }
  if (path === '/v1/auth/review/exchange') signIns++;
  if (path === '/v1/auth/refresh') renewals++;
  const drop = path === '/v1/auth/refresh' && dropNextRefresh;
  if (drop) { dropNextRefresh = false; dropped++; }
  const forward = httpRequest({ hostname: '127.0.0.1', port: 45862, path: req.url, method: req.method, headers: req.headers }, answer => {
    if (drop) {
      answer.resume();
      answer.on('end', () => console.log(JSON.stringify({ event: 'refresh-reply-dropped', status: answer.statusCode, at: new Date().toISOString() })));
      return;
    }
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  forward.on('error', () => { res.writeHead(503); res.end(); });
  req.pipe(forward);
});
proxy.on('upgrade', (req, socket, head) => {
  const forward = httpRequest({ hostname: '127.0.0.1', port: 45862, path: req.url, headers: req.headers });
  forward.on('upgrade', (response, upstream, upstreamHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n` + Object.entries(response.headers).map(([k,v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  forward.on('error', () => socket.destroy());
  forward.end();
});
proxy.listen(45861, '127.0.0.1', () => console.log('isolated session proof listening on 45861'));
