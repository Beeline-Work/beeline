// Capture the real web app's Room list (phone) and sidebar (desktop) in Bone and Obsidian,
// plus the DOM rects of every edge the brief measures. Pixel ink is measured in ink.py.
import { page } from './cdp.mjs';
import { execFileSync } from 'node:child_process';
const reseed = () => execFileSync('node', [new URL('./seed-beeline.mjs', import.meta.url).pathname], { env: process.env });
import { writeFileSync, mkdirSync } from 'node:fs';
const [side, port] = [process.argv[2], process.argv[3]];
const out = `/tmp/rlic/shots/${side}`; mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const setTheme = (t) => page.eval(`(()=>{const k='beeline.settings.local-settings';const v=JSON.parse(localStorage.getItem(k)||'{}');v.appearance=${JSON.stringify(t)};localStorage.setItem(k,JSON.stringify(v));return localStorage.getItem(k)})()`);
const rects = `(()=>{
  const r=(el)=>{if(!el)return null;const b=el.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom}};
  const q=(s)=>document.querySelector(s);
  const pane=q('[data-testid="desktop-navigation-pane"]');
  const scope=pane??document;
  const heads=[...scope.querySelectorAll('[role=heading]')].filter(h=>/ROOMS|DIRECT/.test(h.textContent));
  const rows=[...scope.querySelectorAll('[data-testid^="'+(pane?'desktop-room-':'room-')+'"]')].filter(e=>/^(desktop-)?room-[0-9a-f-]{36}$/.test(e.dataset.testid));
  return {
    viewport:{w:innerWidth,h:innerHeight}, pane:r(pane),
    trigger:r(q('[data-testid="workspace-avatar-trigger"]')),
    tray:r(q('[data-testid="'+(pane?'desktop-tray':'workspace-tray')+'"]')),
    filterAll:r(scope.querySelector('[data-testid="room-filter-all"]')),
    search:r(scope.querySelector('[data-testid="room-search-toggle"]')),
    heads:heads.map(h=>({label:r(h),row:r(h.parentElement),plus:r(h.parentElement.querySelector('[role=button]'))})),
    rows:rows.map(e=>({id:e.dataset.testid,row:r(e),frame:r(pane?e:e.parentElement),name:r(e.querySelector('[dir]')||e.firstElementChild),selected:e.getAttribute('aria-selected')})),
  };
})()`;
// Sign in through the local-only review link once; the profile keeps the session.
await page.size(412, 892);
await page.go(`${base}/review/${process.env.LATENCY_RIG_REVIEW_SECRET}`, 8000);
const results = {};
for (const theme of ['light', 'dark']) {
  const name = theme === 'light' ? 'bone' : 'obsidian';
  // Phone: 412 wide. Reseed so #beeline and @speedy are unread again.
  reseed();
  await page.size(412, 892);
  await page.scheme(theme === 'dark');
  await page.go(`${base}/beeline/channels`, 1500); await setTheme(theme); await page.go(`${base}/beeline/channels`, 6000);
  results[`phone-${name}`] = await page.eval(rects); await page.shot(`${out}/phone-${name}.png`);
  // Desktop: 1280 wide keeps the sidebar without the workspace strip; open #beeline so its row is selected.
  await page.size(1280, 860);
  await page.go(`${base}/beeline/channels`, 6000);
  const id = await page.eval(`(()=>{const e=[...document.querySelectorAll('[data-testid^="desktop-room-"]')].find(e=>e.innerText.startsWith('#beeline'));e?.click();return e?.dataset.testid})()`);
  await page.sleep(4000);
  results[`desktop-${name}`] = { opened: id, ...(await page.eval(rects)) }; await page.shot(`${out}/desktop-${name}.png`);
}
writeFileSync(`${out}/rects.json`, JSON.stringify(results, null, 1));
await page.close();
console.log(JSON.stringify(results['desktop-bone'], null, 0).slice(0, 1500));
