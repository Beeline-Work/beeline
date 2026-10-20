import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(path.resolve('.local/corner-proof/automation/node_modules/playwright/index.mjs')).href);
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
const variant=process.argv[2]??'branch';
const out=`.local/corner-proof/results/web-${variant}`;await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CORNER_PROOF_CHROMIUM??'/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1100,height:850},recordVideo:{dir:out,size:{width:1100,height:850}}});
const list=await context.newPage();
list.on('pageerror',e=>console.log('PAGEERROR',String(e)));
await list.goto('http://127.0.0.1:9182/review/corner-list-isolated-review-2026');
await list.waitForURL('**/beeline/channels',{timeout:60000});
await fetch('http://127.0.0.1:9183/reset');
await list.goto('http://127.0.0.1:9182/beeline/corners/b2aa0000-0000-4000-8000-000000000001');
await list.getByTestId('room-corner-b2aa0000-0000-4000-8000-000000000002').waitFor({timeout:60000});
await list.screenshot({path:out+'/initial-list.png'});
console.log('LIST',await list.locator('body').innerText());
const header=await context.newPage();header.on('pageerror',e=>console.log('HEADERERROR',String(e)));
await header.goto('http://127.0.0.1:9182/beeline/chat/b2aa0000-0000-4000-8000-000000000002?parent=b2aa0000-0000-4000-8000-000000000001&title=archive-proof&returnTo=corners');
await header.getByText('RIG AGENT · working',{exact:true}).waitFor({timeout:60000});
await header.waitForTimeout(500);
const results=[];
for(const action of ['archive','turn']) {
 if(action==='turn') {
  await header.goto('http://127.0.0.1:9182/beeline/chat/b2aa0000-0000-4000-8000-000000000003?parent=b2aa0000-0000-4000-8000-000000000001&title=turn-proof&returnTo=corners');
  await header.getByText('RIG AGENT · idle',{exact:true}).waitFor({timeout:10000});
 }
 // Ensure a held sequence larger than the restarted history's first frame.
 // Every mutation is still committed through the fixture database/service.
 await fetch('http://127.0.0.1:9183/reset');
 await list.waitForTimeout(500);
 const eviction=await (await fetch('http://127.0.0.1:9183/evict')).json();
 const id=action==='archive'?'b2aa0000-0000-4000-8000-000000000002':'b2aa0000-0000-4000-8000-000000000003';
 const startedAt=Date.now();
 const pending=[];
 for(const [name,page] of [['list',list],['header',header]]) {
  const promise=page.evaluate(({action,id})=>new Promise(resolve=>{
   const started=Date.now();let done=false;
   const test=()=>{
    const row=document.querySelector(`[data-testid="room-corner-${id}"]`);
    const body=document.body.innerText;
    const passing=action==='archive'
     ? (location.pathname.includes('/corners/')?!row:body.includes('archived')&&!body.includes('RIG AGENT · working'))
     : (location.pathname.includes('/corners/')?(row?.getAttribute('aria-label')??'').includes('. working'):body.includes('RIG AGENT · working'));
    if(passing&&!done){done=true;resolve({observedAt:Date.now(),text:row?.textContent??body.slice(-900)});}
   };
   const observer=new MutationObserver(()=>requestAnimationFrame(()=>requestAnimationFrame(test)));
   observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true});
   setTimeout(()=>{observer.disconnect();if(!done)resolve({timeout:true,observedAt:Date.now(),text:document.body.innerText.slice(-1400)});},5000);
  }),{action,id});
  pending.push(promise.then(value=>({surface:name,...value})));
 }
 const write=await (await fetch('http://127.0.0.1:9183/'+action)).json();
 if(action==='archive' && write.status!==204) throw new Error('Archive write failed: '+JSON.stringify(write));
 const observations=await Promise.all(pending);
 for(const [name,page] of [['list',list],['header',header]])await page.screenshot({path:`${out}/${action}-${name}.png`});
 results.push({action,eviction,startedAt,write,observations:observations.map(v=>({...v,elapsedMs:v.observedAt-write.startedAt}))});
 console.log(JSON.stringify(results.at(-1)));
}
await writeFile(out+'/results.json',JSON.stringify(results,null,2));
const listVideo=list.video(),headerVideo=header.video();
await context.close();
await copyFile(await listVideo.path(),out+'/list.webm');
await copyFile(await headerVideo.path(),out+'/header.webm');
await browser.close();
