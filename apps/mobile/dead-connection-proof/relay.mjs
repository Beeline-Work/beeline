// The phone's network path. `POST /silence` makes every connection open at
// that moment go silently dead in both directions, never closed (a NAT
// mapping lost while the phone slept); new connections pass normally.
// `POST /silence?down` drops only the server's answers on those connections,
// so a request still reaches the server and its reply is lost.
import http from 'node:http';
import net from 'node:net';

const listenPort = Number(process.env.PROOF_RELAY_PORT ?? 8444);
const controlPort = Number(process.env.PROOF_CONTROL_PORT ?? 8445);
const frontPort = Number(process.env.PROOF_FRONT_PORT ?? 8443);
const paths = new Set();
let opened = 0;
const log = (event, detail = {}) => console.log(JSON.stringify({ at: Date.now(), event, ...detail }));

net.createServer((socket) => {
  const path = { id: ++opened, silent: false, deaf: false, socket };
  paths.add(path);
  log('open', { id: path.id, live: paths.size });
  const upstream = net.connect(frontPort, '127.0.0.1');
  socket.on('data', (data) => { if (!path.silent) upstream.write(data); });
  upstream.on('data', (data) => { if (!path.silent && !path.deaf) socket.write(data); });
  const close = (side) => () => {
    if (!paths.delete(path)) return;
    log('close', { id: path.id, side, silent: path.silent, live: paths.size });
    socket.destroy();
    upstream.destroy();
  };
  // A silent path never reports its peer's close: that is the whole defect.
  socket.on('close', close('phone'));
  upstream.on('close', () => { if (!path.silent && !path.deaf) close('server')(); });
  socket.on('error', () => undefined);
  upstream.on('error', () => undefined);
}).listen(listenPort, '0.0.0.0', () => log('relay-ready', { listenPort }));

http.createServer((request, response) => {
  if (request.method === 'POST' && request.url?.startsWith('/silence')) {
    const answersOnly = request.url === '/silence?down';
    const silenced = [];
    for (const path of paths) {
      if (path.silent || path.deaf) continue;
      if (answersOnly) path.deaf = true;
      else path.silent = true;
      silenced.push(path.id);
    }
    log('silence', { silenced, answersOnly });
    response.end(JSON.stringify({ silenced }));
    return;
  }
  response.end(JSON.stringify({
    paths: [...paths].map(({ id, silent, deaf }) => ({ id, silent, deaf })),
  }));
}).listen(controlPort, '127.0.0.1', () => log('control-ready', { controlPort }));
