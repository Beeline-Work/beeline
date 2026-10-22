// Desktop driver: headless Chrome (--remote-debugging-port=19224) showing the Expo web app at device scale 1.
// Usage: node browser.mjs size | open <url> | click <aria-label or exact text> | eval <js> | shot <file> | texts
import { writeFileSync } from 'node:fs';
const pages = await (await fetch('http://127.0.0.1:19224/json/list')).json();
const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const [action, arg] = process.argv.slice(2);
if (action === 'size') await call('Emulation.setDeviceMetricsOverride', { width: 1279, height: 936, deviceScaleFactor: 1, mobile: false });
if (action === 'open') { await call('Page.navigate', { url: arg }); await new Promise((r) => setTimeout(r, 4000)); }
if (action === 'eval') console.log(JSON.stringify(await evaluate(arg)));
if (action === 'click') {
  const point = await evaluate(`(() => { const want = ${JSON.stringify(arg)};
    const all = [...document.querySelectorAll('[aria-label],[role=button],[role=tab],a,button,div,span')];
    const hit = all.find((el) => el.getAttribute('aria-label') === want) ?? all.find((el) => el.textContent?.trim() === want && el.children.length === 0);
    if (!hit) return null; const r = hit.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!point) { console.error('not found: ' + arg); process.exit(1); }
  for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1500));
}
if (action === 'texts') console.log(await evaluate(`[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(Boolean).slice(0,120).join(' | ')`));
if (action === 'shot') { const r = await call('Page.captureScreenshot', { format: 'png' }); writeFileSync(arg, Buffer.from(r.result.data, 'base64')); }
ws.close();
