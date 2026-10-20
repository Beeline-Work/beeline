// Narrow real-browser stand-in for an authenticated old-release web tab.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const mobile = resolve(import.meta.dirname, '..');
async function bundle(fixed) {
  const result = await build({
    stdin: { contents: `
      import { installWebChunkRecovery } from './sources/buzz/web-chunk-recovery.web';
      import { TextDraft } from './sources/buzz/text-draft-store';
      ${fixed ? 'installWebChunkRecovery();' : ''}
      const visits = +(sessionStorage.visits || 0) + 1;
      sessionStorage.visits = visits;
      const storage = {
        getItem: async k => localStorage.getItem(k),
        setItem: async (k,v) => localStorage.setItem(k,v),
        removeItem: async k => localStorage.removeItem(k),
      };
      const draft = new TextDraft('composer', storage, '');
      await draft.hydrate();
      if (visits === 1) draft.set('Draft survives stale chunk');
      const script = document.createElement('script');
      script.src = '/_expo/static/js/web/room-page-observation-deadbeef0000.js';
      script.onload = () => {
        setTimeout(() => {
          document.body.textContent = JSON.stringify({visits, restored: draft.value, feature: window.feature || 'broken'});
          if (visits === 2) {
            // The current release also has a bad chunk: it must not loop.
            const bad = document.createElement('script');
            bad.src = '/_expo/static/js/web/still-missing.js';
            document.head.appendChild(bad);
          }
        }, 50);
      };
      document.head.appendChild(script);
    `, resolveDir: mobile },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  return result.outputFiles[0].text;
}
const bundles = { baseline: await bundle(false), fixed: await bundle(true) };
const visits = { baseline: 0, fixed: 0 };
const server = createServer((req, res) => {
  const mode = req.headers.referer?.includes('/fixed') ? 'fixed' : 'baseline';
  if (req.url === '/baseline' || req.url === '/fixed') {
    const key = req.url.slice(1);
    visits[key]++;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<body>Loading<script type="module">${bundles[key]}</script></body>`);
  } else if (mode === 'fixed' && visits.fixed > 1 && req.url.includes('room-page-observation')) {
    res.setHeader('Content-Type', 'application/javascript');
    res.end('window.feature = "working";');
  } else {
    // Match the production SPA fallback exactly: successful HTTP HTML for missing JS.
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body>App shell</body></html>');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  for (const mode of ['baseline', 'fixed']) {
    const profile = await mkdtemp(join(tmpdir(), 'beeline-chunk-proof-'));
    try {
      const output = await new Promise((resolveOutput, reject) => {
        const child = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=4000', `http://127.0.0.1:${server.address().port}/${mode}`], { timeout: 15000 });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)));
      });
      const expected = mode === 'fixed'
        ? '"visits":2,"restored":"Draft survives stale chunk","feature":"working"'
        : '"visits":1,"restored":"Draft survives stale chunk","feature":"broken"';
      if (!output.includes(expected) || visits[mode] !== (mode === 'fixed' ? 2 : 1)) throw new Error(`${mode} failed: ${output}`);
      console.log(`STALE-CHUNK-1 ${mode}: ${expected}; HTTP page loads=${visits[mode]}`);
    } finally { await rm(profile, { recursive: true, force: true }); }
  }
} finally { server.close(); }
