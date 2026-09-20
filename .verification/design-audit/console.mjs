/** Navigate one route and dump console output + exception stacks. */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const [, , route = '/', waitArg = '20000'] = process.argv;
const session = JSON.parse(readFileSync('/tmp/audit-session.json', 'utf8'));
const WEB = 'http://localhost:8081';

const target = await (
  await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(WEB + '/')}`, { method: 'PUT' })
).json();

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.id && pending.has(f.id)) {
    const { resolve } = pending.get(f.id);
    pending.delete(f.id);
    resolve(f.result);
  } else if (f.method === 'Runtime.consoleAPICalled' || f.method === 'Runtime.exceptionThrown') {
    events.push(f);
  }
});
const send = (method, params = {}) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve) => pending.set(n, { resolve }));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Runtime.evaluate', {
  expression: `sessionStorage.setItem('buzzy.monolith.refresh.v1', ${JSON.stringify(session.refreshToken)});sessionStorage.setItem('buzzy.monolith.identity.v1', ${JSON.stringify(session.identityId)});1`,
});
await send('Page.navigate', { url: WEB + route });
await new Promise((r) => setTimeout(r, Number(waitArg)));

for (const e of events) {
  if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params.exceptionDetails;
    console.log('EXCEPTION:', d.exception?.description ?? d.text);
  } else {
    const text = e.params.args
      .map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties ?? ''))
      .join(' ');
    console.log(`[${e.params.type}]`, text.slice(0, 2000));
  }
}
await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
process.exit(0);
