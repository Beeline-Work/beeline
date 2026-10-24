import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { rooms, workspace } from './fixture.mjs';
import { summarize, percentile } from './metrics.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
const output = process.argv[2] ?? '/tmp/transcript-web-results';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
  for (let repeat = 0; repeat < 3; repeat++) {
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('');
    await input.focus();
    await page.waitForTimeout(500);
    for (const character of 'measure') {
      await page.evaluate(() => globalThis.__transcriptSpeed.begin('keystroke'));
      await page.keyboard.type(character);
      await page.waitForTimeout(150);
      const sample = await page.evaluate(() => globalThis.__transcriptSpeed.end());
      results.push({ repeat, ...summarize(sample, refreshHz), raw: sample });
    }
    await input.fill('');
    await page.evaluate(() => globalThis.__transcriptSpeed.begin('scroll'));
    await page.mouse.move(190, 400);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    const sample = await page.evaluate(() => globalThis.__transcriptSpeed.end());
    results.push({ repeat, ...summarize(sample, refreshHz), raw: sample });
  }
  const metrics = (await cdp.send('Performance.getMetrics')).metrics;
  const record = {
    status: 'partial',
    buildSha: null, // The loaded export has no build manifest yet.
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
} finally { await browser.close(); }
