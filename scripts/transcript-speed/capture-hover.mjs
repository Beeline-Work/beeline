/** Real pointer hover trials, with a separate Chrome diagnostic trace. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { rooms, workspace, fixtureFingerprint } from './fixture.mjs';
import { summarize, percentile } from './metrics.mjs';

const output = process.argv[2];
const root = process.env.TRANSCRIPT_WEB_DIRECTORY;
if (!output || !root) throw new Error('Supply output directory and TRANSCRIPT_WEB_DIRECTORY');
const origin = process.env.TRANSCRIPT_WEB_ORIGIN ?? 'http://127.0.0.1:20082';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Local fixture origin required');
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const { SourceMapConsumer } = require('source-map');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(`${origin}/review/transcript-fixture-local-only-36bbb7b4`);
    await page.waitForURL('**/beeline/channels**');
    await page.goto(`${origin}/beeline/chat/${rooms[0]}?communityId=${workspace}`);
    await page.getByText('Fixture 0999: agent answer', { exact: false }).first().waitFor();
    await page.waitForTimeout(3000);
    const points = await page.locator('[data-testid^="copy-message-"]').evaluateAll(rows => rows.map(row => {
      const box = row.getBoundingClientRect();
      const top = Math.max(100, box.top), bottom = Math.min(innerHeight - 160, box.bottom);
      return bottom - top > 10 ? { x: box.x + box.width / 2, y: (top + bottom) / 2, id: row.dataset.testid } : null;
    }).filter(Boolean));
    if (!points.length) throw new Error(`Need a visible row for hover at width ${width}`);
    // A long answer can fill the narrow viewport. Leave the transcript between
    // entries so one visible row still exercises real enter/leave transitions.
    points.push({ x: 10, y: 80, id: 'outside-transcript' });
    await page.evaluate(() => {
      globalThis.__hoverPaint = [];
      addEventListener('pointermove', event => {
        if (!event.isTrusted) return;
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => globalThis.__hoverPaint.push(performance.now() - start)));
      }, true);
    });
    const moves = async () => {
      for (let turn = 0; turn < 30; turn++) {
        const point = points[turn % points.length];
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(75);
      }
      await page.waitForTimeout(100);
    };
    await page.screenshot({ path: `${output}/hover-${width}.png` });
    for (let repeat = 0; repeat < 3; repeat++) {
      await page.evaluate(() => { globalThis.__hoverPaint = []; globalThis.__transcriptSpeed.begin('hover'); });
      await moves();
      const raw = await page.evaluate(() => globalThis.__transcriptSpeed.end());
      const paint = await page.evaluate(() => globalThis.__hoverPaint);
      results.push({ width, repeat, ...summarize(raw, 60), pointerToTwoRafP95Ms: percentile(paint, .95), pointerToTwoRafMaxMs: percentile(paint, 1), pointerEvents: paint.length, points, raw });
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
    await cdp.send('Profiler.start');
    await moves();
    const { profile } = await cdp.send('Profiler.stop');
    const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await finished;
    const chunks = [];
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream });
      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    await writeFile(`${output}/hover-${width}-trace.json`, Buffer.concat(chunks));
    const maps = new Map(), hashes = new Map();
    for (const node of profile.nodes) {
      const frame = node.callFrame;
      if (!frame.url.startsWith(`${origin}/_expo/`)) continue;
      const relative = new URL(frame.url).pathname.slice(1);
      if (!maps.has(relative)) {
        const bundle = await readFile(path.join(root, relative));
        hashes.set(relative, createHash('sha256').update(bundle).digest('hex'));
        maps.set(relative, new SourceMapConsumer(JSON.parse(await readFile(path.join(root, `${relative}.map`), 'utf8'))));
      }
      node.original = maps.get(relative).originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
    }
    await writeFile(`${output}/hover-${width}-profile.json`, JSON.stringify(profile));
    await writeFile(`${output}/hover-${width}-bundle-hashes.json`, JSON.stringify(Object.fromEntries(hashes), null, 2));
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])));
    const inclusive = new Map(), product = new Map();
    for (const id of profile.samples ?? []) {
      let nearest = false;
      const seen = new Set();
      for (let node = nodes.get(id); node; node = nodes.get(parents.get(node.id))) {
        const position = node.original;
        if (!position?.source) continue;
        const label = `${position.name || node.callFrame.functionName} (${position.source}:${position.line})`;
        if (!seen.has(label)) { inclusive.set(label, (inclusive.get(label) ?? 0) + 1); seen.add(label); }
        if (!nearest && position.source.startsWith('/sources/')) {
          product.set(label, (product.get(label) ?? 0) + 1); nearest = true;
        }
      }
    }
    const rank = counts => [...counts].sort((a, b) => b[1] - a[1]).map(([frame, samples]) => ({ frame, samples }));
    await writeFile(`${output}/hover-${width}-summary.json`, JSON.stringify({ width, samples: profile.samples.length,
      inclusiveStacks: rank(inclusive), nearestProductStacks: rank(product) }, null, 2));
    await page.close();
  }
  await writeFile(`${output}/capture.json`, JSON.stringify({ fixtureFingerprint, platform: 'chromium', browser: browser.version(),
    note: 'Three unprofiled real pointer trials per width. Chrome traces and sampled CPU profiles are separate diagnostic runs. Pointer to second rAF is a rendering upper bound, not scanout. Narrow web may not mount desktop action controls.', results }, null, 2));
} finally { await browser.close(); }
