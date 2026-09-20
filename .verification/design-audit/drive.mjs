/**
 * One long-lived browser tab, signed in through the product's own review route,
 * driven over CDP: navigate a route, wait for it to settle, photograph it.
 *
 * Used by sweep.mjs. Kept separate so a single surface can be re-shot without
 * re-running the whole walk.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

export const WEB = process.env.AUDIT_WEB ?? 'http://localhost:8081';
export const OUT = '.verification/design-audit/shots';
export const session = JSON.parse(readFileSync('/tmp/audit-session.json', 'utf8'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.logs = [];
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.id && this.pending.has(f.id)) {
        const p = this.pending.get(f.id);
        this.pending.delete(f.id);
        f.error ? p.reject(new Error(JSON.stringify(f.error))) : p.resolve(f.result);
      } else if (f.method === 'Runtime.exceptionThrown') {
        const d = f.params.exceptionDetails;
        const frames = (d.stackTrace?.callFrames ?? [])
          .slice(0, 12)
          .map((c) => `  at ${c.functionName || '?'} ${c.url}:${c.lineNumber}`)
          .join('\n');
        this.errors.push(`${d.exception?.description ?? d.text}\n${frames}`);
      } else if (f.method === 'Runtime.consoleAPICalled' && f.params.type === 'error') {
        this.errors.push(f.params.args.map((a) => a.description ?? a.value).join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.value;
  }
  async viewport(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile,
    });
  }
  async shot(file) {
    mkdirSync(OUT, { recursive: true });
    const s = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(s.data, 'base64'));
    return file;
  }
  async close() {
    await fetch(`http://127.0.0.1:9222/json/close/${this.targetId}`);
  }
}

export async function openTab(url = WEB + '/') {
  const target = await (
    await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });
  await new Promise((r) => ws.on('open', r));
  const cdp = new Cdp(ws, target.id);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

/** Sign the tab in the way a store reviewer's device does, then wait for the deck. */
export async function signIn(cdp) {
  await cdp.send('Page.navigate', { url: `${WEB}/review/${session.reviewSecret}` });
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const path = await cdp.eval('location.pathname');
    if (path && !path.startsWith('/review')) return path;
  }
  throw new Error('review sign-in never left /review');
}
