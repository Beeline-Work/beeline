// node apps/mobile/scripts/transcript-scrubber-proof.mjs
// Requires the mobile dependencies and Chrome (CHROME_BIN may select its path).
// Drags the shipped scrubber with browser input, then checks every date glyph
// against the actual bubble bounds. Screenshots/results go to .scratch.
import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(mobile, '../../.scratch/transcript-scrubber-proof');
await mkdir(output, { recursive: true });
const themeShim = `
import { beelineThemes } from '${mobile}/sources/buzz/groknight';
import { APP_UI_SIZE_SCALE } from '${mobile}/sources/ui-size';
const query = new URLSearchParams(location.search);
const scale = APP_UI_SIZE_SCALE[query.get('size') || 'medium'] * Number(query.get('fontScale') || 1);
const base = beelineThemes.obsidian;
const type = Object.fromEntries(Object.entries(base.type).map(([name, style]) => [name, {
  ...style, fontSize: style.fontSize * scale, lineHeight: style.lineHeight * scale,
}]));
export const StyleSheet = { create: factory => factory({ buzz: { ...base, type } }) };
`;
await build({
  entryPoints: [path.join(mobile, 'scripts/transcript-scrubber-proof.jsx')],
  bundle: true, outfile: path.join(output, 'bundle.js'), jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, platform: 'browser',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  plugins: [{ name: 'scrubber-proof-platform', setup(api) {
    api.onResolve({ filter: /^react-native$/ }, () => ({
      path: path.join(mobile, 'node_modules/react-native-web/dist/index.js'),
    }));
    api.onResolve({ filter: /^react-native-unistyles$|^expo-haptics$/ }, args => ({
      path: args.path, namespace: 'proof',
    }));
    api.onLoad({ filter: /.*/, namespace: 'proof' }, args => ({
      contents: args.path === 'expo-haptics'
        ? 'export const impactAsync = async () => {}; export const ImpactFeedbackStyle = { Light: 1 };'
        : themeShim,
      loader: 'ts', resolveDir: mobile,
    }));
    api.onResolve({ filter: /^@\// }, args => {
      const base = path.join(mobile, 'sources', args.path.slice(2));
      return { path: ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
        .map(ext => base + ext).find(candidate => existsSync(candidate)) ?? base };
    });
  } }],
});
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/bundle.js' || pathname === '/font.ttf') {
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'font/ttf');
    createReadStream(pathname === '/bundle.js' ? path.join(output, 'bundle.js')
      : path.join(mobile, 'sources/assets/fonts/IBMPlexMono-SemiBold.ttf')).pipe(response);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><style>
      @font-face{font-family:IBMPlexMono-SemiBold;src:url('/font.ttf')}
      html,body{margin:0;background:#14091A}#root{height:100vh}
      </style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp('/tmp/bbc-scrubber-chrome-');
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
let browserErrors = '';
chrome.stderr.on('data', chunk => { browserErrors += chunk.toString(); });
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Browser proof timed out');
}
try {
  const debugPort = await waitFor(async () => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(browserErrors);
    try { return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return null; }
  });
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const promise = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message));
    else promise.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1,
  });
  const results = [];
  await send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  for (const [width, size, fontScale] of [
    [320, 'small', 1], [320, 'medium', 1], [320, 'large', 1],
    [320, 'large', 2], [393, 'large', 2], [900, 'large', 2],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${address}/?size=${size}&fontScale=${fontScale}` });
    await waitFor(() => evaluate(`!!document.querySelector('[data-testid="transcript-scrubber-grab"]')`));
    await evaluate('document.fonts.ready');
    const grab = await evaluate(`(() => {
      const r = document.querySelector('[data-testid="transcript-scrubber-grab"]').getBoundingClientRect();
      return { x: r.right - 5, y: r.top + r.height / 2, width: r.width };
    })()`);
    await mouse('mousePressed', grab.x, grab.y, 1);
    await mouse('mouseMoved', grab.x, grab.y - 100, 1);
    await waitFor(() => evaluate(`!!document.querySelector('[data-testid="transcript-scrubber-bubble"]')`));
    await evaluate('document.fonts.ready');
    const observed = await evaluate(`(() => {
      const bubble = document.querySelector('[data-testid="transcript-scrubber-bubble"]');
      const text = bubble.firstElementChild;
      const bounds = bubble.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(text);
      const glyphs = [...range.getClientRects()].filter(r => r.width > 0);
      const style = getComputedStyle(text);
      return { date: text.textContent, lines: new Set(glyphs.map(r => Math.round(r.top))).size,
        contained: glyphs.every(r => r.left >= bounds.left && r.right <= bounds.right &&
          r.top >= bounds.top && r.bottom <= bounds.bottom),
        onScreen: bounds.left >= 0 && bounds.right <= innerWidth,
        bubbleWidth: bounds.width, bubbleHeight: bounds.height,
        fontSize: style.fontSize, fontFamily: style.fontFamily, letterSpacing: style.letterSpacing,
        fontLoaded: document.fonts.check('10px IBMPlexMono-SemiBold'),
        offset: Number(document.body.dataset.scrubOffset) };
    })()`);
    const name = `${width}-${size}-${fontScale}`;
    const capture = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(capture.data, 'base64'));
    await mouse('mouseReleased', grab.x, grab.y - 100);
    const target = await evaluate(`(() => {
      const list = document.querySelector('[data-testid="transcript-list"]');
      const button = [...list.querySelectorAll('button')].find(b => {
        const r = b.getBoundingClientRect(); return r.top > 100 && r.bottom < 550;
      });
      const r = button.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + 30, index: button.dataset.testid.split('-')[1] };
    })()`);
    await mouse('mousePressed', target.x, target.y, 1);
    await mouse('mouseReleased', target.x, target.y);
    observed.listTouchable = await evaluate(`document.body.dataset.messageClicked === '${target.index}'`);
    observed.grabWidth = grab.width;
    results.push({ width, size, fontScale, ...observed });
    console.log(JSON.stringify(results.at(-1)));
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  assert(results.every(r => r.lines === 1 && r.contained && r.onScreen && r.offset > 1500 &&
    r.listTouchable && r.grabWidth === 44 && r.fontLoaded && r.date === 'SAT 24 AUG'),
    'Date must fit on one line while dragging; list and thumb must remain touchable');
  console.log('Reproduction scrubber-1: full dates visible at all six text-size/viewport combinations.');
} finally {
  socket?.close();
  chrome.kill();
  await new Promise(resolve => chrome.exitCode === null && chrome.signalCode === null
    ? chrome.once('exit', resolve) : resolve());
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
