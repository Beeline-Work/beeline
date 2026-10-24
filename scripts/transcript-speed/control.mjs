/** Loopback-only transport for explicitly instrumented fixture builds. */
import { createServer } from 'node:http';
export function startControl(port = 19886) {
  const pending = [];
  const results = new Map();
  const started = new Set();
  let clientSeen = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/next') {
      clientSeen = Date.now();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pending.shift() ?? null)); return;
    }
    if (req.method === 'POST' && ['/started', '/result'].includes(url.pathname)) {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8e6) { res.writeHead(413).end(); return; } }
      try {
        const value = JSON.parse(body);
        if (url.pathname === '/started') started.add(value.id);
        else results.set(value.id, value);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1');
  const wait = async (predicate, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Instrumented app did not answer the local capture channel');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  return {
    async ready() { await wait(() => clientSeen > 0); },
    async capture(name, durationMs, action) {
      const id = `${Date.now()}-${name}`;
      pending.push({ id, name, durationMs });
      await wait(() => started.has(id));
      await action();
      await wait(() => results.has(id), durationMs + 10000);
      const result = results.get(id); results.delete(id); started.delete(id);
      if (result.error) throw new Error(result.error);
      return result.sample;
    },
    close() { server.close(); },
  };
}
