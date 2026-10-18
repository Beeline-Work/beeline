// Isolated Room fixture; the TCP proxy drops bytes without FIN/RST.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { WebSocketServer } = require('../../../node_modules/ws');
const source = fs.readFileSync(__dirname + '/adapters/services.js', 'utf8');
const fixture = Function(
  'return ' +
    source
      .slice(
        source.indexOf('export const fixture = ') + 23,
        source.indexOf('\nexport const controls'),
      )
      .replace(/;\s*$/, ''),
)();
const agent = 'a'.repeat(64);
fixture.members.push({
  identity: { pubkey: agent, kind: 'agent', name: 'Proof agent', handle: 'proof' },
  role: 'member',
});
const turn = {
  agentPubkey: agent,
  requestId: 'r1',
  status: 'working',
  createdAt: Date.now() / 1000,
  updatedAt: Date.now() / 1000,
};
fixture.latestAgentTurns = [turn];
const events = [];
const log = (event, detail = {}) => {
  const row = { at: Date.now(), event, ...detail };
  events.push(row);
  console.log(JSON.stringify(row));
};
let reads = 0;
const paths = new Set();
const wss = new WebSocketServer({ port: 8895 });
wss.on('connection', (ws) => {
  log('socket-open');
  ws.on('message', (bytes) => {
    const frame = JSON.parse(String(bytes));
    log('frame', { type: frame.type });
    if (frame.type === 'subscribe')
      for (const roomId of frame.roomIds) ws.send(JSON.stringify({ type: 'subscribed', roomId }));
    if (frame.type === 'ping') ws.send('{"type":"pong"}');
    if (frame.type === 'sync') ws.send('{"type":"sync-ok"}');
  });
});
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/room') {
    reads++;
    log('room-read', { reads });
    res.end(JSON.stringify(fixture));
    return;
  }
  if (req.url === '/drop') {
    for (const path of paths) path.drop = true;
    log('blackhole');
    turn.status = 'complete';
    turn.updatedAt = Date.now() / 1000;
    const message = {
      id: 'f'.repeat(64),
      text: 'R1 final reply reached the server.',
      createdAt: Date.now() / 1000,
      author: fixture.members.at(-1).identity,
      presentation: 'message',
    };
    fixture.messages.push(message);
    for (const ws of wss.clients) {
      ws.send(JSON.stringify({ type: 'message-delta', roomId: fixture.room.id, message }));
      ws.send(JSON.stringify({ type: 'turn-delta', roomId: fixture.room.id, turn }));
    }
    log('final-committed');
  }
  if (req.url === '/send') log('next-send');
  res.end(JSON.stringify({ reads, events, paths: [...paths].map((p) => ({ drop: p.drop })) }));
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(8895, '127.0.0.1');
  const path = { drop: false };
  paths.add(path);
  upstream.on('connect', () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n',
    );
    if (head.length) upstream.write(head);
  });
  socket.on('data', (data) => {
    if (!path.drop) upstream.write(data);
  });
  upstream.on('data', (data) => {
    if (!path.drop) socket.write(data);
  });
  socket.on('close', () => {
    paths.delete(path);
    upstream.destroy();
  });
  upstream.on('close', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
});
server.listen(8896, '0.0.0.0', () => log('ready'));
