// Actual Chrome fake-device capture, real adapter/hook/upload/composer,
// and a stub HTTP transcription response. No speech provider claim.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { webProofShims } from '../sources/test/browserProof.ts';

const mobile = path.resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'bl-recorder-'));
const uploads = [];
let chrome; let socket;
const server = createServer(async (request, response) => {
  if (request.url === '/v1/phone/transcriptions') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const audio = Buffer.concat(chunks);
    uploads.push({ bytes: audio.length, riff: audio.subarray(0, 4).toString(),
      format: audio.readUInt16LE(20), sampleRate: audio.readUInt32LE(24),
      language: request.headers['x-speech-language'], prompt: request.headers['x-speech-prompt'] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ text: 'Hello desktop.' }));
  } else if (request.url === '/bundle.js') {
    response.setHeader('content-type', 'application/javascript');
    response.end(await readFile(path.join(scratch, 'bundle.js')));
  } else {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><meta charset="utf-8"><div id="root"></div><script>
      window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;
      const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{window.__captureStream=await capture(options);return window.__captureStream;};
      window.__revokedBlobs=0;const revoke=URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL=uri=>{window.__revokedBlobs++;revoke(uri);};
      </script><script src="/bundle.js"></script></html>`);
  }
});
try {
  const shims = { ...webProofShims(mobile),
    '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
    './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
    '@/auth/monolith-session': 'export const monolithSession = { fetch: (url, init) => fetch(url, init) };',
    './runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: location.origin });',
    expo: 'export class NativeModule { addListener() { return { remove() {} }; } } export const registerWebModule = Module => new Module();',
  };
  await build({ entryPoints: [path.join(mobile, 'scripts/composer-recorder-proof.tsx')],
    outfile: path.join(scratch, 'bundle.js'), bundle: true, platform: 'browser', jsx: 'automatic',
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
    plugins: [{ name: 'proof-shims', setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
        if (requested in shims) return { path: requested, namespace: 'shim' };
        if (requested === 'react-native') return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
        if (requested.startsWith('@/')) {
          const candidate = path.join(mobile, 'sources', requested.slice(2));
          return { path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
            .map(extension => candidate + extension).find(file => existsSync(file) && statSync(file).isFile()) };
        }
      });
      api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({ contents: shims[requested], loader: 'tsx', resolveDir: mobile }));
    } }],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox',
    '--disable-dev-shm-usage', '--window-size=1280,840', '--remote-debugging-port=0', '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', `--user-data-dir=${path.join(scratch, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    chrome.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.once('exit', () => { clearTimeout(timer); reject(new Error(log)); });
  });
  socket = new WebSocket(endpoint);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let nextId = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    const item = pending.get(value.id);
    if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result); }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: origin });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const waitFor = async expression => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const diagnostic = await evaluate(`JSON.stringify({text:window.__recorderText,sent:window.__recorderSent,body:document.body.innerText})`);
    throw new Error(`Timed out: ${expression}; uploads=${JSON.stringify(uploads)}; ${diagnostic}`);
  };
  const clickMic = async () => {
    const rect = await evaluate(`(() => { const r=document.querySelector('[data-testid="chat-mic"]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 }, sessionId);
  };
  await waitFor(`Boolean(document.querySelector('[data-testid="chat-mic"]'))`);
  await clickMic();
  await waitFor(`Boolean(document.querySelector('[data-testid="chat-speech-waveform"]'))`);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await clickMic();
  await waitFor(`window.__recorderText === 'Hello desktop.' && window.__recorderSent === 'Hello desktop.'`);
  await waitFor(`window.__captureStream.getTracks().every(track => track.readyState === 'ended') && window.__revokedBlobs > 0`);
  if (!uploads.length || !uploads.every(audio => audio.bytes > 100 && audio.riff === 'RIFF' && audio.sampleRate === 16000 && audio.language === 'en' && decodeURIComponent(audio.prompt).includes('Jellybean'))) throw new Error(JSON.stringify(uploads));
  const result = { result: 'PASS', capture: 'actual Chrome fake-device getUserMedia and Web Audio',
    transcription: 'stub HTTP response; no speech recognition provider',
    text: await evaluate('window.__recorderText'), sent: await evaluate('window.__recorderSent'),
    microphoneReleased: true, blobRevoked: true, uploads };
  console.log(JSON.stringify(result, null, 2));
  const evidence = path.join(mobile, 'evidence/desktop-voice-entry/recorder-capture.json');
  await writeFile(evidence, JSON.stringify(result, null, 2) + '\n');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile(path.join(mobile, 'evidence/desktop-voice-entry/recorder-capture.png'), Buffer.from(screenshot.data, 'base64'));
} finally {
  socket?.close(); chrome?.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
