import { chromium } from '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { rooms, workspace, agents, localDatabase } from '../../scripts/transcript-speed/fixture.mjs';
import { fixtureStimulus } from '../../scripts/transcript-speed/stimulus.mjs';
const stimulus = await fixtureStimulus();
const db = new pg.Client({connectionString: localDatabase(process.env.LATENCY_RIG_DATABASE_URL)});
await db.connect();
const browser = await chromium.launch({executablePath:'/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>console.log('pageerror',error.message));
const cdp=await page.context().newCDPSession(page); await cdp.send('Network.enable');
let frames=[];
cdp.on('Network.webSocketFrameReceived',e=>{try{const f=JSON.parse(e.response.payloadData);frames.push({at:Date.now(),bytes:Buffer.byteLength(e.response.payloadData),...f});}catch{}});
const results=[];
try {
 await page.goto('http://127.0.0.1:23882/review/transcript-fixture-local-only-36bbb7b4');
 await page.waitForURL('**/beeline/channels**');
 await page.goto(`http://127.0.0.1:23882/beeline/chat/${rooms[0]}?communityId=${workspace}`);
 await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
 await page.waitForTimeout(2000);
 for(const profile of [{name:'normal',rttMs:0,mbps:100},{name:'throttled',rttMs:150,mbps:1.6}]) {
  await fetch('http://127.0.0.1:23881/__latency-rig/profile',{method:'POST',body:JSON.stringify({...profile,jitterMs:0,failureRate:0})});
  for(let trial=0;trial<3;trial++){
   frames=[];
   const id=(await import('node:crypto')).randomBytes(32).toString('hex');
   const tail=`TAIL-${id.slice(0,10)}`;
   await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',[id,rooms[1],agents[0],'Background audit payload '+'B'.repeat(128*1024)+tail]);
   await page.waitForTimeout(50);
   const actionAt=Date.now();const active=await stimulus.incoming(rooms[0]);
   await page.getByText(active.text,{exact:true}).waitFor();
   const paintedAt=Date.now(); await page.waitForTimeout(200);
   const offscreen=frames.find(f=>f.roomId===rooms[1]&&f.preview?.id===id);
   const activeFrame=frames.find(f=>f.message?.id===active.id);
   if(!offscreen||!activeFrame)throw new Error('Missing offscreen preview or active full delta');
   if(offscreen.bytes>8192)throw new Error('Oversized preview');
   results.push({platform:'web',profile:profile.name,trial,offscreenBytes:offscreen.bytes,activeBytes:activeFrame.bytes,arrivalMs:activeFrame.at-actionAt,paintMs:paintedAt-actionAt,offscreenType:offscreen.type});
   console.log(JSON.stringify(results.at(-1)));
   await writeFile('/tmp/jellybean-hol-web-results.json',JSON.stringify({reproduction:'NET-HOL-1',results},null,2));
   if(profile.name==='throttled'&&trial===2){
    await page.getByTestId(`desktop-room-${rooms[1]}`).click();
    await page.waitForFunction(tail=>document.body.innerText.includes(tail),tail,{timeout:45000});
    results.push({openOffscreenFetchesFullText:true,tail});
    await page.screenshot({path:'/tmp/jellybean-hol-full-open.png'});
   }
  }
 }
 await writeFile('/tmp/jellybean-hol-web-results.json',JSON.stringify({reproduction:'NET-HOL-1',results},null,2));
}finally{await browser.close();await db.end();await stimulus.close();}
