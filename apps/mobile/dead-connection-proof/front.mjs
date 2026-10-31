// Production-shaped front for the local monolith: TLS with HTTP/2 (and
// HTTP/1.1 for the WebSocket upgrade), the way Fly serves the phone.
// Ahead of it, relay.mjs can silence every open connection without closing it.
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const local = new URL('./.local/', import.meta.url);
const port = Number(process.env.PROOF_FRONT_PORT ?? 8443);
const backendPort = Number(process.env.PROOF_BACKEND_PORT ?? 8080);
const backendHost = `127.0.0.1:${backendPort}`;
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'http2-settings', 'te']);

const server = http2.createSecureServer({
  cert: readFileSync(new URL('server.pem', local)),
  key: readFileSync(new URL('server.key', local)),
  allowHTTP1: true,
});

server.on('request', (request, response) => {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers))
    if (!name.startsWith(':') && !hopByHop.has(name)) headers[name] = value;
  headers.host = backendHost;
  const upstream = http.request({ host: '127.0.0.1', port: backendPort, method: request.method, path: request.url, headers }, (answer) => {
    const out = {};
    for (const [name, value] of Object.entries(answer.headers)) if (!hopByHop.has(name)) out[name] = value;
    response.writeHead(answer.statusCode ?? 502, out);
    answer.pipe(response);
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error.message }));
  });
  request.pipe(upstream);
  console.log(JSON.stringify({ at: Date.now(), event: 'request', http: request.httpVersion, method: request.method, path: request.url }));
});

// The phone's WebSocket always arrives over HTTP/1.1; hand the raw bytes on.
server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(backendPort, '127.0.0.1', () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      lines.push(`${name}: ${name.toLowerCase() === 'host' ? backendHost : request.rawHeaders[index + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', close);
  socket.on('error', close);
  console.log(JSON.stringify({ at: Date.now(), event: 'upgrade', path: request.url }));
});

server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ at: Date.now(), event: 'front-ready', port })));
