// Minimal Chrome DevTools client: launch headless Chrome, run a step list.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const port = 9466 + Math.floor(Math.random() * 300);
const profile = process.env.CDP_PROFILE ?? '/tmp/rlm88/chrome-profile';
mkdirSync(profile, { recursive: true });
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
export const page = {
  async size(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 }); },
  async scheme(dark) { await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }); },
  async go(url, ms = 2500) { await send('Page.enable'); await send('Page.navigate', { url }); await sleep(ms); },
  async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; },
  async shot(path) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.result.data, 'base64')); },
  sleep,
  async drag(x0, y, x1, y1) {
    const pt = (x, yy) => ({ x, y: yy });
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(x0, y)] });
    for (let i = 1; i <= 12; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(x0 + (x1 - x0) * i / 12, y + (y1 - y) * i / 12)] }); await sleep(16); }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  },
  async close() { ws.close(); chrome.kill(); },
};
