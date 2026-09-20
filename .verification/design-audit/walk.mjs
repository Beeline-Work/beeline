/**
 * Drive the desktop build the way a person drives it — by clicking — because
 * the shell boots to the Room deck no matter what path the URL carries, so a
 * URL sweep photographs the same screen fourteen times.
 *
 * Usage: node .verification/design-audit/walk.mjs [probe]
 *   probe  print every clickable target's accessible name and box, then stop
 */
import { writeFileSync } from 'node:fs';
import { openTab, signIn, sleep, WEB, OUT } from './drive.mjs';

const PROBE = `(() => {
  const out = [];
  for (const e of document.querySelectorAll('[role], [data-testid], a, button, input')) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    out.push({
      label: (e.getAttribute('aria-label') || e.getAttribute('data-testid') || (e.innerText || '').trim().slice(0, 40)),
      role: e.getAttribute('role') || e.tagName,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return JSON.stringify(out);
})()`;

const cdp = await openTab();
await cdp.viewport(1440, 900, false);
await sleep(8000);
await signIn(cdp);
await sleep(8000);
await cdp.send('Page.navigate', { url: WEB + '/beeline/channels' });
await sleep(9000);

export async function click(cdp, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
}

async function targets() {
  return JSON.parse(await cdp.eval(PROBE));
}

/** Click the first target whose accessible name matches, and say so. */
async function tap(needle, { exact = false } = {}) {
  const all = await targets();
  const hit = all.find((t) =>
    exact ? t.label === needle : t.label.toLowerCase().includes(needle.toLowerCase()),
  );
  if (!hit) {
    console.log(`  MISS ${needle}`);
    return false;
  }
  await click(cdp, hit.x, hit.y);
  await sleep(4000);
  return true;
}

if (process.argv[2] === 'probe') {
  console.log(JSON.stringify(await targets(), null, 1));
  process.exit(0);
}

const shots = [];
async function record(name) {
  const file = `${OUT}/desktop-${name}.png`;
  await cdp.shot(file);
  const text = await cdp.eval('document.body.innerText.slice(0, 2500)');
  shots.push({ name, file, text, errors: [...cdp.errors].slice(0, 3) });
  cdp.errors.length = 0;
  console.log(`shot desktop-${name}`);
}

const STEPS = [
  ['deck', []],
  ['room', [['#ship-the-slab']]],
  ['corners-list', [['corners']]],
  ['corner', [['audit-every-surface']]],
  ['room-2', [['#ship-the-slab']]],
  ['overflow', [['More']]],
  ['members', [['Members']]],
  ['settings', [['Settings']]],
];

for (const [name, taps] of STEPS) {
  for (const [needle] of taps) await tap(needle);
  await record(name);
}

writeFileSync(`${OUT}/../walk-desktop.json`, JSON.stringify(shots, null, 2));
await cdp.close();
process.exit(0);
