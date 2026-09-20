/**
 * Walk every governed surface in one signed-in tab and photograph it.
 *
 * The session token lives in sessionStorage, which is per-tab, so the sign-in
 * and the whole walk have to share one tab — a second tab lands on onboarding.
 *
 * Usage: node .verification/design-audit/sweep.mjs [desktop|phone|both]
 */
import { writeFileSync } from 'node:fs';
import { openTab, signIn, sleep, session, WEB, OUT } from './drive.mjs';

const want = process.argv[2] ?? 'both';
const VIEWPORTS = [
  { tag: 'desktop', w: 1440, h: 900, mobile: false },
  { tag: 'phone', w: 390, h: 844, mobile: true },
].filter((v) => want === 'both' || v.tag === want);

const ROUTES = [
  ['channels', '/beeline/channels'],
  ['room', `/beeline/chat/${session.roomId}`],
  ['room-empty', `/beeline/chat/${session.quietRoomId}`],
  ['corner', `/beeline/chat/${session.cornerId}`],
  ['dm', `/beeline/chat/${session.dmId}`],
  ['corners-list', `/beeline/corners/${session.roomId}`],
  ['members', '/beeline/members'],
  ['settings', '/beeline/settings'],
  ['settings-identity', '/beeline/settings/identity'],
  ['settings-workspace', '/beeline/settings/workspace'],
  ['settings-workbench', '/beeline/settings/workbench'],
  ['agents', '/beeline/agents'],
  ['bookmarks', '/beeline/bookmarks'],
  ['community', '/beeline/community'],
];

/** Click the first element whose visible text matches, the way a finger would. */
const boxFor = (needle) => `(() => {
  const want = ${JSON.stringify(needle)};
  const all = [...document.querySelectorAll('div,span,a,button')];
  const hit = all.reverse().find((e) => (e.innerText || '').trim() === want);
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()`;

async function tap(cdp, needle) {
  const raw = await cdp.eval(boxFor(needle));
  if (!raw) return false;
  const { x, y } = JSON.parse(raw);
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
  return true;
}

const cdp = await openTab();
await cdp.viewport(VIEWPORTS[0].w, VIEWPORTS[0].h, VIEWPORTS[0].mobile);
await sleep(8000);
await signIn(cdp);
await sleep(6000);

const report = [];
for (const viewport of VIEWPORTS) {
  await cdp.viewport(viewport.w, viewport.h, viewport.mobile);
  for (const [name, route] of ROUTES) {
    cdp.errors.length = 0;
    await cdp.send('Page.navigate', { url: WEB + route });
    await sleep(7000);
    const landed = await cdp.eval('location.pathname');
    const text = await cdp.eval('document.body.innerText.slice(0, 3000)');
    const crashed = /Something went wrong/.test(text ?? '');
    const file = `${OUT}/${viewport.tag}-${name}.png`;
    await cdp.shot(file);
    report.push({ name, route, landed, crashed, file, errors: [...cdp.errors].slice(0, 4), text });
    console.log(`${viewport.tag}/${name} -> ${landed}${crashed ? '  CRASHED' : ''}`);
  }

  // The desktop shell rewrites deep chat routes, so its panes are reached the
  // way a person reaches them: by clicking a row in the sidebar.
  if (viewport.tag === 'desktop') {
    await cdp.send('Page.navigate', { url: WEB + '/beeline/channels' });
    await sleep(8000);
    for (const [name, needle] of [
      ['pane-room', '#ship-the-slab'],
      ['pane-room-empty', '#design-notes'],
      ['pane-dm', '@chloropine'],
    ]) {
      cdp.errors.length = 0;
      const hit = await tap(cdp, needle);
      await sleep(6000);
      const text = await cdp.eval('document.body.innerText.slice(0, 3000)');
      const file = `${OUT}/desktop-${name}.png`;
      await cdp.shot(file);
      report.push({
        name: `desktop-${name}`,
        route: `click ${needle}`,
        landed: await cdp.eval('location.pathname'),
        crashed: /Something went wrong/.test(text ?? ''),
        file,
        errors: [...cdp.errors].slice(0, 4),
        text,
        clicked: hit,
      });
      console.log(`desktop/${name} -> ${hit ? 'clicked' : 'NOT FOUND'}`);
    }
  }
}
writeFileSync(`${OUT}/../report.json`, JSON.stringify(report, null, 2));
await cdp.close();
process.exit(0);
