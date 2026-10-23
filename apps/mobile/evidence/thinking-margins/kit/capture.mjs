// Uses the PR #2847 CDP kit against the real, locally built app.
import { page } from '../../room-list-icon-centre/kit/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const side = process.argv[2];
const context=process.argv[4] ?? 'dm';
const room=context==='corner'?'bee11e00-0000-4000-8000-000000000106':context==='room'?'97a7dad0-1c24-4610-8236-a77cf0fbb81a':'b8494555-af0a-4fb0-8ee4-64eebf14398a';
const out = `apps/mobile/evidence/thinking-margins/${side}${context==='dm'?'':'-'+context}`; mkdirSync(out,{recursive:true});
const base = `http://127.0.0.1:${process.argv[3] ?? '18892'}`;
await page.size(360,892);
await page.go(`${base}/review/thinking-local-disposable-review`,8000);
console.log(await page.eval('document.body.innerText.slice(-1800)'));
for (const theme of ['light','dark']) {
 await page.eval(`(()=>{const k='beeline.settings.local-settings';const v=JSON.parse(localStorage.getItem(k)||'{}');v.appearance='${theme}';localStorage.setItem(k,JSON.stringify(v));})()`);
 for (const [surface,width,height] of [['phone',360,892],['desktop',1280,860]]) {
  execFileSync('node',[new URL('./seed.mjs',import.meta.url).pathname],{env:process.env});
  await page.size(width,height); await page.scheme(theme==='dark');
  await page.go(`${base}/beeline/chat/${room}?communityId=bee11e00-0000-4000-8000-000000000105`,6500);
  const state=await page.eval(`(()=>{const row=document.querySelector('[data-testid="turn-progress-line"]');const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom}}; const text=[...document.querySelectorAll('[dir]')].find(e=>e.textContent==='Ruby, please think about the transcript alignment.'); return {body:document.body.innerText.slice(-1200),row:rect(row),name:rect(row?.querySelector('[dir]')),stop:rect(document.querySelector('[data-testid="turn-progress-line-stop"]')),text:rect(text)}})()`);
  if(!state.row || !state.name || !state.stop || !state.text) throw Error('Thinking line missing: '+state.body);
  writeFileSync(`${out}/${surface}-${theme}.json`,JSON.stringify(state,null,2));
  await page.shot(`${out}/${surface}-${theme}.png`);
  console.log(surface,theme,JSON.stringify(state).slice(0,1400));
 }
}
await page.close();
