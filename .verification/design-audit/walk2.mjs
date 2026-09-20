/**
 * Second pass: the surfaces the first walk never reached, driven by clicking,
 * because the desktop shell boots to the Room deck whatever the URL says.
 *
 * Usage: node .verification/design-audit/walk2.mjs
 */
import { writeFileSync } from 'node:fs';
import { openTab, signIn, sleep, WEB, OUT } from './drive.mjs';

const PROBE = `(() => {
  const out = [];
  for (const e of document.querySelectorAll('[role], [data-testid], a, button, input')) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    out.push({
      label: (e.getAttribute('aria-label') || e.getAttribute('data-testid') || (e.innerText || '').trim().slice(0, 44)),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
    });
  }
  return JSON.stringify(out);
})()`;

const cdp = await openTab();
await cdp.viewport(1440, 900, false);
await sleep(8000);
await signIn(cdp);
await sleep(8000);

async function click(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
}

async function tap(needle) {
  const all = JSON.parse(await cdp.eval(PROBE));
  const hit = all.find((t) => t.label.toLowerCase().includes(needle.toLowerCase()));
  if (!hit) {
    console.log(`  MISS ${needle}`);
    return false;
  }
  await click(hit.x, hit.y);
  await sleep(2600);
  return true;
}

const shots = [];
async function record(name) {
  cdp.errors.length = 0;
  await sleep(1200);
  const file = `${OUT}/w2-${name}.png`;
  await cdp.shot(file);
  const text = await cdp.eval('document.body.innerText');
  const path = await cdp.eval('location.pathname');
  shots.push({ name, path, file, text, errors: [...new Set(cdp.errors)] });
  console.log(`  shot ${name} @ ${path}`);
}

async function home() {
  await cdp.send('Page.navigate', { url: WEB + '/beeline/channels' });
  await sleep(6000);
}

// 1 — Members, through the Room-list header's MembersGlyph.
if (await tap('Workspace members')) await record('members');
await home();

// 2 — Bookmarks.
if (await tap('Bookmarks')) await record('bookmarks');
await home();

// 3 — Workspace settings (already seen) then its Members row.
if (await tap('Open Workspace settings')) {
  await record('settings-workspace');
  if (await tap('Members')) await record('settings-workspace-members');
}
await home();

// 4 — The account hub, the rail's YOU command. DESIGN: "Settings is one entry".
if (await tap('Alan — Settings')) {
  await record('settings-hub');
  for (const row of ['Identity', 'Appearance', 'Workbench']) {
    if (await tap(row)) {
      await record(`settings-${row.toLowerCase()}`);
      // Bone: flip the canvas and re-shoot the hub behind it.
      if (row === 'Appearance') {
        if (await tap('Bone')) {
          await record('appearance-bone');
          await home();
          await record('deck-bone');
          await cdp.send('Page.navigate', { url: WEB + '/beeline/settings' });
          await sleep(6000);
          await tap('Appearance');
          await tap('Obsidian');
        }
      }
      await tap('Back');
      await sleep(1500);
    }
  }
}
await home();

// 5 — The Room transcript's overflow sheet, which carries the Members row.
if (await tap('Open Room #ship-the-slab')) {
  await sleep(3000);
  if (await tap('More')) await record('room-overflow-sheet');
}

writeFileSync('.verification/design-audit/report-pass2.json', JSON.stringify(shots, null, 2));
console.log(`\n${shots.length} surfaces recorded`);
await cdp.close();
process.exit(0);
