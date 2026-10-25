/** Separate visual samples; screenshots never run inside timing windows. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { rooms, workspace } from './fixture.mjs';
import { corner } from './fixture.mjs';
import { fixtureStimulus } from './stimulus.mjs';
import { androidArtifact } from './android-artifact.mjs';
const [platform, output] = process.argv.slice(2);
if (!['web', 'android'].includes(platform) || !output) throw new Error('Usage: list-visual-audit.mjs web|android output');
await mkdir(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [];
if (platform === 'web') {
  const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
  const stimulus = await fixtureStimulus();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 844 } });
    const origin = process.env.TRANSCRIPT_WEB_ORIGIN ?? 'http://127.0.0.1:19882';
    await page.goto(`${origin}/review/transcript-fixture-local-only-36bbb7b4`);
    await page.waitForURL('**/beeline/channels**');
    await page.goto(`${origin}/beeline/chat/${rooms[0]}?communityId=${workspace}`);
    await page.getByText('Fixture 0999: agent answer', { exact: false }).first().waitFor();
    await pause(2000);
    const build = await page.evaluate(() => globalThis.__transcriptBuild);
    if (process.env.TRANSCRIPT_EXPECT_ENGINE && build?.listEngine !== process.env.TRANSCRIPT_EXPECT_ENGINE)
      throw new Error('Visual audit engine differs from expected build');
    const box = await page.getByTestId('chat-messages').boundingBox();
    if (!box) throw new Error('Missing transcript viewport');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 8; index++) {
      await page.mouse.wheel(0, -1800);
      await page.screenshot({ path: `${output}/fast-scroll-${index}.png` });
      samples.push(await page.evaluate(() => {
        const viewport = document.querySelector('[data-testid="chat-messages"]').getBoundingClientRect();
        const rows = [...document.querySelectorAll('[data-benchmark-row]')].map(row => {
          const rect = row.getBoundingClientRect();
          return { id: row.dataset.benchmarkRow, top: rect.top, bottom: rect.bottom };
        }).filter(row => row.bottom > viewport.top && row.top < viewport.bottom);
        return { atMs: performance.now(), viewport: { top: viewport.top, bottom: viewport.bottom }, rows };
      }));
    }
    const visiblePath = [];
    const requireInViewport = async locator => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const row = await locator.first().boundingBox();
        const viewport = await page.getByTestId('chat-messages').boundingBox();
        if (row && viewport && row.x < viewport.x + viewport.width && row.x + row.width > viewport.x &&
            row.y < viewport.y + viewport.height && row.y + row.height > viewport.y) return;
        await pause(100);
      }
      throw new Error('Message exists outside the actual transcript viewport or is absent');
    };
    for (const scenario of ['incoming', 'settled-send', 'concurrent-streams']) {
      try {
        const room = scenario === 'concurrent-streams' ? corner : rooms[0];
        await page.goto(`${origin}/beeline/chat/${room}?communityId=${workspace}`);
        await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        await pause(2000);
        const jump = page.getByRole('button', { name: /Jump to newest message$/ });
        if (await jump.count()) { await jump.click(); await pause(500); }
        if (scenario === 'incoming') {
          const message = await stimulus.incoming();
          await requireInViewport(page.getByText(message.text, { exact: true }));
        } else if (scenario === 'settled-send') {
          const text = `Visible-audit-${Date.now()}`;
          await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
          await page.getByRole('button', { name: 'Send message', exact: true }).click();
          let settled = false;
          for (let attempt = 0; attempt < 80; attempt++) {
            if (await stimulus.settled(text)) { settled = true; break; }
            await pause(100);
          }
          if (!settled) throw new Error('Visible send did not settle');
          await requireInViewport(page.getByText(text, { exact: true }));
        } else await stimulus.stream(async () => {
          await requireInViewport(page.getByText('Stream 0:', { exact: false }));
          await requireInViewport(page.getByText('Stream 1:', { exact: false }));
          await page.screenshot({ path: `${output}/two-live-streams.png` });
        });
        await page.screenshot({ path: `${output}/${scenario}.png` });
        visiblePath.push({ scenario, passed: true });
      } catch (error) {
        await page.screenshot({ path: `${output}/${scenario}-failed.png` });
        visiblePath.push({ scenario, passed: false, error: String(error) });
      }
    }
    await writeFile(`${output}/samples.json`, JSON.stringify({ platform, build, samples, visiblePath,
      method: 'Eight immediate post-wheel screenshots and visible row rectangles; discrete samples do not exclude transient blanking between screenshots.' }, null, 2));
    if (visiblePath.some(result => !result.passed)) process.exitCode = 1;
  } finally { await browser.close(); await stimulus.close(); }
} else {
  const device = process.env.LATENCY_RIG_DEVICE;
  if (!/^(emulator-\d+|127\.0\.0\.1:\d+)$/.test(device ?? '')) throw new Error('Select the owned fixture emulator');
  const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8' });
  if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error('Emulator required');
  const artifact = androidArtifact(adb);
  adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `beeline://beeline/chat/${rooms[0]}?communityId=${workspace}`, 'app.usebeeline/.MainActivity');
  await pause(2500);
  for (let index = 0; index < 8; index++) {
    adb('shell', 'input', 'swipe', '500', '700', '500', '1850', '90');
    await writeFile(`${output}/fast-scroll-${index}.png`, execFileSync('adb', ['-s', device, 'exec-out', 'screencap', '-p']));
    samples.push({ index, screenshot: `fast-scroll-${index}.png` });
  }
  await writeFile(`${output}/samples.json`, JSON.stringify({ platform, device, ...artifact, engine: process.env.TRANSCRIPT_EXPECT_ENGINE, samples,
    method: 'Eight screenshots immediately after a 90ms swipe, during any remaining momentum; discrete samples do not exclude transient blanking between screenshots.' }, null, 2));
}
