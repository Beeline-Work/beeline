// Narrow real-browser stand-in for an authenticated old-release web tab.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assetGuard from '../../../infra/web-assets/worker.mjs';

const mobile = resolve(import.meta.dirname, '..');
const original = execFileSync('git', ['show', '3c6163fe7:apps/mobile/sources/buzz/web-chunk-recovery.web.ts'], { encoding: 'utf8' });
async function bundle(fixed) {
  const result = await build({
    stdin: { contents: `
      import { installWebChunkRecovery } from './sources/buzz/web-chunk-recovery.web';
      import { TextDraft } from './sources/buzz/text-draft-store';
      import { fetchThenEvalAsync } from 'expo/src/async-require/fetchThenEval.web';
      installWebChunkRecovery();
      // A tab that recovered during an earlier deployment retains this marker.
      if (!sessionStorage.visits) sessionStorage.setItem('beeline.web-chunk-reload.v1', '1');
      const visits = +(sessionStorage.visits || 0) + 1;
      sessionStorage.visits = visits;
      const storage = {
        getItem: async k => localStorage.getItem(k),
        setItem: async (k,v) => localStorage.setItem(k,v),
        removeItem: async k => localStorage.removeItem(k),
      };
      const draft = new TextDraft('composer', storage, '');
      await draft.hydrate();
      const composer = document.createElement('textarea');
      composer.setAttribute('aria-label', 'Message');
      composer.value = draft.value;
      composer.oninput = () => draft.set(composer.value);
      document.body.appendChild(composer);
      if (visits === 1) {
        composer.value = 'Draft survives stale chunk';
        composer.dispatchEvent(new Event('input'));
      }
      window.addEventListener('error', e => { if (e.filename) sessionStorage.raw = JSON.stringify({filename:e.filename,message:e.message}); });
      await fetchThenEvalAsync('/_expo/static/js/web/native-crash-reporting-' + (visits === 1 ? '1e3fd66d1e775311094f09c2d035fff0' : 'new') + '.js');
      {
        setTimeout(() => {
          document.body.textContent = JSON.stringify({visits, restored: composer.value, feature: window.feature || 'broken', raw: JSON.parse(sessionStorage.raw || 'null')});
          if (visits === 2) {
            // The current release also has a bad chunk: it must not loop.
            const bad = document.createElement('script');
            bad.src = '/_expo/static/js/web/still-missing.js';
            document.head.appendChild(bad);
          }
        }, 50);
      }
    `, resolveDir: mobile },
    plugins: fixed ? [] : [{ name: 'baseline', setup(b) { b.onLoad({filter: /web-chunk-recovery\.web\.ts$/}, () => ({contents:original,loader:'ts',resolveDir:resolve(mobile,'sources/buzz')})); } }],
    define: { __DEV__: 'false' },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  return result.outputFiles[0].text;
}
const bundles = { baseline: await bundle(false), fixed: await bundle(true), guarded: await bundle(true) };
const visits = { baseline: 0, fixed: 0, guarded: 0 };
const reads = { baseline: 0, fixed: 0, guarded: 0 };
const server = createServer((req, res) => {
  const mode = req.headers.referer?.includes('/guarded') ? 'guarded' : req.headers.referer?.includes('/fixed') ? 'fixed' : 'baseline';
  if (req.url === '/baseline' || req.url === '/fixed' || req.url === '/guarded') {
    const key = req.url.slice(1);
    if (req.headers['sec-fetch-dest'] === 'document') visits[key]++;
    reads[key]++;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<body>Loading<script defer src="/_expo/static/js/web/index-${reads[key] > 1 ? 'new' : 'old'}.js"></script><script type="module">${bundles[key]}</script></body>`);
  } else if (req.url.includes('/index-')) {
    res.setHeader('Content-Type', 'application/javascript'); res.end('/* export boot identifier */');
  } else if (mode !== 'baseline' && visits[mode] > 1 && req.url.includes('native-crash-reporting-new')) {
    res.setHeader('Content-Type', 'application/javascript');
    res.end('window.feature = "working";');
  } else {
    // Match the production SPA fallback exactly: successful HTTP HTML for missing JS.
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body>App shell</body></html>');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const guardedFailures = [];
const edge = createServer(async (req, res) => {
  try {
    const response = await assetGuard.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers,
    }));
    if (req.url.includes('native-crash-reporting-1e3fd')) {
      guardedFailures.push({ status: response.status, type: response.headers.get('content-type') });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(r => edge.listen(0, '127.0.0.1', r));
try {
  for (const mode of ['baseline', 'fixed', 'guarded']) {
    const profile = await mkdtemp(join(tmpdir(), 'beeline-chunk-proof-'));
    try {
      const output = await new Promise((resolveOutput, reject) => {
        const port = (mode === 'guarded' ? edge : server).address().port;
        const child = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=4000', `http://127.0.0.1:${port}/${mode}`], { timeout: 15000 });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)));
      });
      const expected = mode !== 'baseline'
        ? '"visits":2,"restored":"Draft survives stale chunk","feature":"working"'
        : '"visits":1,"restored":"Draft survives stale chunk","feature":"broken"';
      if (!output.includes(expected) || (mode !== 'guarded' && !output.includes('Unexpected token')) || visits[mode] !== (mode !== 'baseline' ? 2 : 1)) throw new Error(`${mode} failed: ${output}`);
      if (mode === 'guarded' && (guardedFailures.length !== 1 || guardedFailures[0].status !== 404 || !guardedFailures[0].type.startsWith('text/plain'))) throw new Error(`Missing asset was not a plain 404: ${JSON.stringify(guardedFailures)}`);
      console.log(`BEELINE-MOBILE-9 / STALE-CHUNK-HTML-1 ${mode}: ${output.match(/<body>(.*?)<\/body>/s)?.[1]}; HTTP page loads=${visits[mode]}; missing assets=${JSON.stringify(guardedFailures)}`);
    } finally { await rm(profile, { recursive: true, force: true }); }
  }
} finally { edge.close(); server.close(); }
