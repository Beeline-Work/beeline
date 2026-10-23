// Swipe the #markets card left on the phone list and capture the revealed leave action.
import { page } from './cdp.mjs';
import { execFileSync } from 'node:child_process';
execFileSync('node', [new URL('./seed-beeline.mjs', import.meta.url).pathname], { env: process.env });
await page.size(412, 892); await page.scheme(false);
await page.go('http://127.0.0.1:8792/beeline/channels', 7000);
const r = await page.eval(`(()=>{const e=[...document.querySelectorAll('[data-testid^="room-"]')].find(e=>/^#markets/.test(e.innerText));const b=e.getBoundingClientRect();return {t:b.top,b:b.bottom}})()`);
const y = (r.t + r.b) / 2;
await page.drag(330, y, 150, y);
await page.sleep(800);
const a = await page.eval(`(()=>{const e=document.querySelector('[aria-label^="Leave #markets"]');if(!e)return null;let p=e;for(let i=0;i<3;i++)p=p.parentElement;const b=e.parentElement.parentElement.getBoundingClientRect();return {l:b.left,r:b.right,t:b.top,b:b.bottom}})()`);
console.log(JSON.stringify({ card: r, actions: a }));
await page.shot(`/tmp/rlm88/shots/${process.argv[2]}/phone-swipe.png`);
await page.close();
