// Run with node --experimental-strip-types scripts/prove-server-dictation.mjs.
// Playwright can be supplied from a separate installation; no app dependency.
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webProofShims } from '../sources/test/browserProof.ts';
import { createBeelineServer } from '../../server/dist/server.js';
import { SpeechTranscriber } from '../../server/dist/speech-transcription.js';
const { webkit } = await import(process.env.BEELINE_PLAYWRIGHT_MODULE ?? 'playwright');
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(path.join(tmpdir(), 'dictation-webkit-'));
const shims = {
  ...webProofShims(mobile),
  '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
  './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
  '@/auth/monolith-session':
    'export const monolithSession = { fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: "Bearer dictation-proof-phone" } }) };',
  './runtime-config':
    'export const getBuzzRuntimeConfig = () => ({ monolithUrl: location.origin });',
  expo: `export class NativeModule { addListener() { return { remove() {} }; } }
    export const registerWebModule = Module => new Module(); export const useEventListener = () => {};`,
};
if (process.argv.includes('--reproduce')) {
  // Replay the recorded baseline adapter against the same rendered composer.
  shims['./speech-recognition-adapter'] = execFileSync(
    'git',
    [
      'show',
      'a37868e86eaaced940d95b4d0c2d5bf9674ffff0:apps/mobile/sources/buzz/speech-recognition-adapter.web.ts',
    ],
    { cwd: mobile, encoding: 'utf8' },
  );
}
let browser;
const uploads = [];
const providerUploads = [];
const api = createBeelineServer({
  database: { query: async () => ({ rows: [] }) },
  auth: {
    authenticatePhone: async (token) => (token === 'dictation-proof-phone' ? 'proof-viewer' : null),
  },
  phone: {},
  daemon: {},
  live: {},
  mediaMaximumBytes: 1,
  speechTranscriber: new SpeechTranscriber('dictation-proof-provider', async (_url, init) => {
    const form = init.body;
    const audio = form.get('file');
    const bytes = new Uint8Array(await audio.arrayBuffer());
    providerUploads.push({
      bytes: audio.size,
      mime: audio.type,
      model: form.get('model'),
      prompt: form.get('prompt'),
      nonzeroAudio: bytes.subarray(60).some((value) => value !== 0),
    });
    return new Response(JSON.stringify({ text: 'Hello Beeline' }), { status: 200 });
  }),
});
let apiUrl;
const server = createServer(async (request, response) => {
  if (request.url === '/v1/phone/transcriptions') {
    const parts = [];
    for await (const part of request) parts.push(part);
    const audio = Buffer.concat(parts);
    uploads.push({
      bytes: audio.length,
      signature: audio.subarray(0, 4).toString(),
      prompt: decodeURIComponent(request.headers['x-speech-prompt'] ?? ''),
      language: request.headers['x-speech-language'],
    });
    const result = await fetch(apiUrl + '/v1/phone/transcriptions', {
      method: 'POST',
      headers: { ...request.headers, host: new URL(apiUrl).host },
      body: audio,
    });
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(await result.text());
    return;
  }
  if (request.url === '/bundle.js') {
    response.setHeader('content-type', 'application/javascript');
    response.end(await readFile(path.join(directory, 'bundle.js')));
    return;
  }
  response.end(
    '<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="sent"></pre><script src="/bundle.js"></script>',
  );
});
try {
  await build({
    entryPoints: [path.join(mobile, 'scripts/composer-server-dictation-proof.tsx')],
    outfile: path.join(directory, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
    define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.EXPO_OS': '"web"',
      __DEV__: 'true',
      global: 'globalThis',
    },
    plugins: [
      {
        name: 'proof',
        setup(api) {
          api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
            if (requested in shims) return { path: requested, namespace: 'shim' };
            if (requested === 'react-native')
              return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
            if (requested.startsWith('@/')) {
              const candidate = path.join(mobile, 'sources', requested.slice(2));
              return {
                path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                  .map((extension) => candidate + extension)
                  .find((entry) => existsSync(entry) && statSync(entry).isFile()),
              };
            }
          });
          api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
            contents: shims[requested],
            loader: 'tsx',
            resolveDir: mobile,
          }));
        },
      },
    ],
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => console.error(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.addInitScript(() => {
    // Real Web Audio capture; replace only the physical mic.
    window.captureRequests = [];
    window.captureTracks = [];
    window.recordingURLs = new Set();
    const makeURL = URL.createObjectURL.bind(URL);
    const revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const uri = makeURL(blob);
      window.recordingURLs.add(uri);
      return uri;
    };
    URL.revokeObjectURL = (uri) => {
      window.recordingURLs.delete(uri);
      revokeURL(uri);
    };
    const capture = async (constraints) => {
      window.captureRequests.push(constraints);
      const context = new AudioContext();
      window.generatorContext = context;
      await context.resume();
      const tone = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      const gain = context.createGain();
      tone.connect(gain);
      gain.connect(destination);
      tone.start();
      window.quiet = () => {
        gain.gain.value = 0;
      };
      const stream = destination.stream;
      window.captureTracks.push(...stream.getTracks());
      stream.getTracks().forEach((track) => {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          tone.stop();
          void context.close();
        };
      });
      return stream;
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: capture },
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-testid="chat-input"]').waitFor();
  const capability = await page.evaluate(() => ({
    engine: navigator.userAgent,
    speech: typeof SpeechRecognition,
    prefixedSpeech: typeof webkitSpeechRecognition,
    recorder: typeof MediaRecorder,
    audioContext: typeof AudioContext,
    openingCaptures: window.captureRequests.length,
    micVisible: Boolean(document.querySelector('[data-testid="chat-mic"]')),
  }));
  console.log(JSON.stringify(capability, null, 2));
  if (
    capability.openingCaptures !== 0 ||
    capability.speech !== 'undefined' ||
    capability.prefixedSpeech !== 'undefined'
  )
    throw new Error('Invalid no-Web-Speech reproduction environment');
  if (process.argv.includes('--reproduce')) {
    if (capability.micVisible) throw new Error('Expected original missing mic');
    console.log(
      'Reproduction desktop-dictation-webkit: rendered composer has no mic despite recording support',
    );
  } else {
    await page.locator('[data-testid="chat-mic"]').click();
    await page.screenshot({ path: '/var/tmp/beeline-dictation-recording.png' });
    await page.locator('[data-testid="chat-speech-waveform"]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => window.captureRequests.length === 1);
    await page.waitForTimeout(1200);
    // Silence ends dictation and leaves its text editable instead of sending it.
    await page.evaluate(() => window.quiet());
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-input"]').value === 'Hello Beeline',
    );
    await page.locator('[data-testid="chat-input"]').focus();
    await page.locator('[data-testid="chat-input"]').fill('Hello Beeline, edited');
    await page.screenshot({ path: '/var/tmp/beeline-dictation-edited.png' });
    await page.locator('[data-testid="chat-send"]').click();
    await page.waitForFunction(
      () => document.getElementById('sent').textContent === 'Hello Beeline, edited',
    );
    // A second take exercises explicit stop and its dictated send.
    await page.locator('[data-testid="chat-mic"]').click();
    await page.waitForFunction(() => window.captureRequests.length === 2);
    await page.waitForTimeout(800);
    await page.locator('[data-testid="chat-mic"]').click();
    await page.waitForFunction(
      () => document.getElementById('sent').textContent === 'Hello Beeline',
    );
    const details = await page.evaluate(() => ({
      requests: window.captureRequests,
      tracks: window.captureTracks.map((t) => t.readyState),
      remainingRecordingURLs: window.recordingURLs.size,
    }));
    console.log(JSON.stringify({ uploads, providerUploads, ...details }, null, 2));
    if (providerUploads.length !== 2 || providerUploads.some((upload) => !upload.nonzeroAudio))
      throw new Error('Real server transcription path was not exercised');
    if (
      !uploads.length ||
      uploads.some(
        (u) => u.bytes <= 60 || u.signature !== 'RIFF' || !u.prompt.includes('Jellybean'),
      )
    )
      throw new Error('Audio upload or lexicon missing');
    if (details.remainingRecordingURLs !== 0) throw new Error('Recording URL leaked');
    if (details.tracks.some((state) => state !== 'ended'))
      throw new Error('Microphone track still live');
    console.log(
      'RESULT PASS: WebKit captured generated audio, uploaded WAV through the real server, inserted text, edited and sent; explicit stop sent the second take; provider and physical mic mocked',
    );
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  api.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => api.close(resolve)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
