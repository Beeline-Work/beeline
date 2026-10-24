import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { rooms, workspace, corner, fixtureFingerprint } from './fixture.mjs';
import { fixtureStimulus } from './stimulus.mjs';
import { summarize, percentile } from './metrics.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
const output = process.argv[2] ?? '/tmp/transcript-web-results';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
const results = [];
const stimulus = await fixtureStimulus();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    globalThis.__keyPaintEvents = [];
    globalThis.__keyPaintBounds = [];
    addEventListener('keydown', event => {
      if (!event.isTrusted || event.key.length !== 1) return;
      const startTime = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => globalThis.__keyPaintBounds.push({ startTime, duration: performance.now() - startTime })));
    }, true);
    globalThis.__eventTimingSupported = PerformanceObserver.supportedEntryTypes.includes('event');
    if (globalThis.__eventTimingSupported) new PerformanceObserver(list => {
      for (const event of list.getEntries()) if (event.name === 'keydown')
        globalThis.__keyPaintEvents.push({ startTime: event.startTime, duration: event.duration, processingStart: event.processingStart });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  });
  await page.goto('http://127.0.0.1:19882/review/transcript-fixture-local-only-36bbb7b4');
  await page.waitForURL('**/beeline/channels**');
  await page.goto(`http://127.0.0.1:19882/beeline/chat/${rooms[0]}?communityId=${workspace}`);
  await page.getByText('Fixture 0999: agent answer', { exact: false }).first().waitFor();
  await page.waitForTimeout(3000);
  const refreshHz = await page.evaluate(async () => {
    const times = [];
    for (let i = 0; i < 61; i++) times.push(await new Promise(requestAnimationFrame));
    const deltas = times.slice(1).map((value, i) => value - times[i]).sort((a, b) => a - b);
    return 1000 / deltas[Math.floor(deltas.length / 2)];
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const open = async room => {
    await page.goto(`http://127.0.0.1:19882/beeline/chat/${room}?communityId=${workspace}`);
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.waitForTimeout(1500);
  };
  const capture = async (name, repeat, action) => {
    await page.evaluate(name => globalThis.__transcriptSpeed.begin(name), name);
    await action();
    await page.waitForTimeout(500);
    const raw = await page.evaluate(() => globalThis.__transcriptSpeed.end());
    results.push({ repeat, ...summarize(raw, refreshHz), raw });
    await writeFile(`${output}/capture.json`, JSON.stringify({ status: 'running', samples: results }, null, 2));
    console.log(name, repeat);
  };
  for (let repeat = 0; repeat < 3; repeat++) {
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('');
    await input.focus();
    await page.waitForTimeout(500);
    for (const character of 'measure') {
      const eventStart = await page.evaluate(() => performance.now());
      await page.evaluate(() => globalThis.__transcriptSpeed.begin('keystroke'));
      await page.keyboard.type(character);
      await page.waitForTimeout(150);
      const sample = await page.evaluate(() => globalThis.__transcriptSpeed.end());
      results.push({ repeat, ...summarize(sample, refreshHz), raw: sample,
        keyPaintEvents: await page.evaluate(start => globalThis.__keyPaintEvents.filter(event => event.startTime >= start), eventStart),
        keyPaintUpperBounds: await page.evaluate(start => globalThis.__keyPaintBounds.filter(event => event.startTime >= start), eventStart),
        keyPaintMethod: 'Chrome Event Timing keydown-to-next-paint, 8ms quantization; unreported events censored below 16ms' });
    }
    await input.fill('');
    const scrollBefore = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight > e.clientHeight).map(e => e.scrollTop));
    await page.evaluate(() => globalThis.__transcriptSpeed.begin('scroll'));
    await page.mouse.move(190, 400);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    const sample = await page.evaluate(() => globalThis.__transcriptSpeed.end());
    results.push({ repeat, ...summarize(sample, refreshHz), raw: sample });
    const scrollAfter = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(e => e.scrollHeight > e.clientHeight).map(e => e.scrollTop));
    results.at(-1).scrollChanged = JSON.stringify(scrollBefore) !== JSON.stringify(scrollAfter);
    await capture('fling', repeat, async () => {
      await page.mouse.move(190, 400);
      for (const delta of [-2400, -1600, -900, -400, -100]) {
        await page.mouse.wheel(0, delta); await page.waitForTimeout(30);
      }
      await page.waitForTimeout(1200);
    });
    const oldest = () => page.evaluate(() => Math.min(...Array.from(document.body.innerText.matchAll(/Fixture (\d{4})/g), m => Number(m[1]))));
    const oldestBefore = await oldest();
    await capture('history-prepend', repeat, async () => {
      // RN Web wheel events do not establish native drag intent. Use the
      // visible scrubber, whose public gesture explicitly requests history.
      await page.mouse.wheel(0, 400); await page.waitForTimeout(100);
      const grab = await page.getByTestId('transcript-scrubber-grab').boundingBox();
      const rail = await page.getByTestId('transcript-scrubber').boundingBox();
      if (!grab || !rail) throw new Error('Visible history scrubber missing');
      await page.mouse.move(grab.x + grab.width / 2, Math.max(rail.y + 2, grab.y + grab.height / 2));
      await page.mouse.down();
      await page.mouse.move(grab.x + grab.width / 2, rail.y - 40, { steps: 12 });
      for (let i = 0; i < 60 && await oldest() >= oldestBefore; i++) await page.waitForTimeout(100);
      await page.mouse.up();
    });
    results.at(-1).history = { oldestBefore, oldestAfter: await oldest() };
    if (!(results.at(-1).history.oldestAfter < oldestBefore)) throw new Error('Web history gesture did not reveal an older fixture row');
    await open(rooms[0]);
    let incoming;
    await capture('incoming', repeat, async () => {
      incoming = await stimulus.incoming();
      await page.getByText(incoming.text, { exact: true }).waitFor();
    });
    results.at(-1).visible = await page.getByText(incoming.text, { exact: true }).isVisible();
    await open(corner);
    await capture('concurrent-streams', repeat, async () => {
      const streaming = stimulus.stream();
      await page.getByText('Stream 0:', { exact: false }).first().waitFor();
      await page.getByText('Stream 1:', { exact: false }).first().waitFor();
      await streaming;
    });
    await open(rooms[0]);
    const sent = `Web-settlement-${repeat}-${Date.now()}`;
    await input.fill(sent);
    await capture('optimistic-send', repeat, async () => {
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByText(sent, { exact: true }).waitFor();
    });
    results.at(-1).serverSettled = await stimulus.settled(sent);
  }
  for (let repeat = 0; repeat < 3; repeat++) {
  const memoryBeforeSwitches = (await cdp.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
  await capture('warm-room-switches', repeat, async () => {
    for (let i = 0; i < 20; i++) {
      const desktopRow = page.getByTestId(`desktop-room-${rooms[i % 2]}`);
      if (await desktopRow.count()) await desktopRow.click();
      else {
        await page.getByRole('button', { name: 'Back to Rooms', exact: true }).click();
        await page.getByTestId(`room-${rooms[i % 2]}`).click();
      }
      await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
      await page.waitForTimeout(1000);
    }
  });
  const metrics = (await cdp.send('Performance.getMetrics')).metrics;
  results.at(-1).memory = { switches: 20, beforeBytes: memoryBeforeSwitches,
    afterBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value };
  }
  const metrics = (await cdp.send('Performance.getMetrics')).metrics;
  const record = {
    status: 'partial',
    fixtureFingerprint,
    buildSha: results.find(sample => sample.raw.build)?.raw.build.checkoutSha ?? null,
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
    runtime: await browser.version(), platform: 'narrow-web', viewport: { width: 390, height: 844 },
    device: `${os.hostname()} ${os.cpus()[0]?.model}`, refreshHz,
    refreshMethod: 'median requestAnimationFrame interval, headless virtual display',
    profilingOverhead: 'unmeasured; build-only layout-effect commit counters and rAF sampler',
    uiFrames: null, blankArea: null, keystrokeToPaint: null,
    memoryAfterCapture: metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null,
    samples: results,
    typingRowCommitsP50: percentile(results.filter(sample => sample.scenario === 'keystroke').map(sample => sample.rowCommits), .5),
  };
  await writeFile(`${output}/capture.json`, JSON.stringify(record, null, 2));
  await page.screenshot({ path: `${output}/screen.png` });
  console.log(JSON.stringify({ output, samples: results.length, typingRowCommitsP50: record.typingRowCommitsP50 }));
} finally { await browser.close(); await stimulus.close(); }
