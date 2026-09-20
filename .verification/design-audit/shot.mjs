/**
 * Drive the Buzz web bundle in headless Chrome against the seeded fixture
 * server and photograph one route.
 *
 * Usage: node .verification/design-audit/shot.mjs <route> <out.png> [width] [height] [waitMs]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const [, , route, out, widthArg, heightArg, waitArg] = process.argv;
const width = Number(widthArg ?? 1440);
const height = Number(heightArg ?? 900);
const settle = Number(waitArg ?? 6000);
const session = JSON.parse(readFileSync('/tmp/audit-session.json', 'utf8'));
const WEB = 'http://localhost:8081';

const listTargets = async () => (await fetch('http://127.0.0.1:9222/json/list')).json();

const open = async (url) => {
  const created = await (
    await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  return created;
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.id && this.pending.has(frame.id)) {
        const { resolve, reject } = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const connect = (wsUrl) =>
  new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    ws.on('open', () => resolve(new Cdp(ws)));
  });

const target = await open(`${WEB}/`);
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: width < 600,
});

const seed = `
  sessionStorage.setItem('buzzy.monolith.refresh.v1', ${JSON.stringify(session.refreshToken)});
  sessionStorage.setItem('buzzy.monolith.identity.v1', ${JSON.stringify(session.identityId)});
  'seeded'
`;
await cdp.send('Runtime.evaluate', { expression: seed, awaitPromise: false });

const url = `${WEB}${route}`;
await cdp.send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, settle));

const logs = await cdp.send('Runtime.evaluate', {
  expression: 'location.href',
  returnByValue: true,
});
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify({ route, landedAt: logs.result.value, out, width, height }));
await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
process.exit(0);
