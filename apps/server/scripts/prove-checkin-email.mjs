/** Feature proof CHECKIN-A (not a defect report): real built email HTML and HTTP PNGs in Chrome. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import sharp from 'sharp';
import { PgliteDatabase } from '../src/test-support.ts';
import { migrate } from '../dist/database.js';
import { TokenAuth } from '../dist/auth.js';
import { PhoneService } from '../dist/phone-service.js';
import { DaemonService } from '../dist/daemon-service.js';
import { LiveHub } from '../dist/live.js';
import { createBeelineServer } from '../dist/server.js';
import { renderCheckinEmail } from '../dist/next-day-checkin.js';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const out='docs/evidence/checkin-email';
const approved=await readFile(out+'/approved-mock-v2.html','utf8');
const database=new PgliteDatabase(), live=new LiveHub();
const server=createBeelineServer({ database,live,auth:new TokenAuth(database,async()=>{throw Error('unused');}),
  phone:new PhoneService(database,'http://proof'),daemon:new DaemonService(database,live),mediaMaximumBytes:1024 });
const agents=[{id:'b'.repeat(64),name:'Beebee'},{id:'c'.repeat(64),name:'Luna'}];
const text="Morning, @maya. Yesterday we got three subject lines for your bakery's November newsletter, and you stopped before picking one.\n\nNext step: reply with 1, 2 or 3 and I'll write the full email around it.";
let origin, chrome, ws, preview;
const profile=await mkdtemp(join(tmpdir(),'checkin-chrome-'));
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name,face_id) VALUES($1,'agent','Beebee','fox'),($2,'agent','Luna','hare')`,agents.map(a=>a.id));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  preview=createServer((req,res)=>{
    const url=new URL(req.url,'http://preview');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(url.pathname==='/mock' ? approved : renderCheckinEmail('Beebee',text,'https://web.usebeeline.app/beeline/chat/proof',agents.slice(0,Number(url.searchParams.get('count')??2)),origin).html);
  });
  await new Promise(resolve=>preview.listen(0,'127.0.0.1',resolve));
  const previewOrigin=`http://127.0.0.1:${preview.address().port}`;
  chrome=spawn(process.env.CHROME_BIN??'/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{
    let log=''; const timeout=setTimeout(()=>reject(Error('Chrome startup timed out')),20000);
    chrome.stderr.on('data',data=>{log+=data;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
    chrome.on('error',reject);
  });
  ws=new WebSocket(endpoint); await new Promise(resolve=>ws.on('open',resolve));
  let id=0;const pending=new Map();
  ws.on('message',data=>{const message=JSON.parse(data);if(message.id){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const command=(method,params)=>send(method,params,sessionId);
  await command('Page.enable');
  async function capture(url,width,theme,mock=false) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
    await command('Page.navigate',{url});
    // Wait for a complete document instead of a timer; HTML and hosted PNGs must all be loaded.
    for(let attempt=0;attempt<100;attempt++) {
      const ready=await command('Runtime.evaluate',{expression:'document.readyState',returnByValue:true});
      if(ready.result.value==='complete') break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(mock) await command('Runtime.evaluate',{expression:`document.body.innerHTML=document.querySelectorAll('.col .frame > table')[${theme==='dark'?1:0}].outerHTML;document.body.style.margin='0';document.body.style.background='${theme==='dark'?'#14091A':'#F3EEE4'}';`});
    const state=await command('Runtime.evaluate',{expression:`(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));return {broken:[...document.images].filter(i=>!i.naturalWidth).length,overflow:document.documentElement.scrollWidth>innerWidth,text:document.querySelector('.bubble')?.textContent};})()`,awaitPromise:true,returnByValue:true});
    if(state.exceptionDetails) throw Error(JSON.stringify(state.exceptionDetails));
    assert.equal(state.result.value.broken,0);
    assert.equal(state.result.value.overflow,false);
    if(!mock) assert.equal(state.result.value.text,text);
    const {cssContentSize}=await command('Page.getLayoutMetrics');
    const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:cssContentSize.height,scale:1}});
    return Buffer.from(result.data,'base64');
  }
  const rows=[];
  for(const width of [390,600]) for(const theme of ['light','dark']) {
    const mock=await capture(previewOrigin+'/mock',width,theme,true);
    for(const count of [1,2]) {
      const actual=await capture(previewOrigin+'/?count='+count,width,theme);
      const height=Math.max((await sharp(mock).metadata()).height,(await sharp(actual).metadata()).height);
      const label=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width*2+16}" height="40"><rect width="100%" height="100%" fill="#fff"/><text x="12" y="25" font-size="14">Approved mock A (two agents)</text><text x="${width+28}" y="25" font-size="14">Built email · ${count} agent${count===1?'':'s'} · ${theme} · ${width}px</text></svg>`);
      const file=`${theme}-${count}-${width}.png`;
      await sharp({create:{width:width*2+16,height:height+40,channels:4,background:'#ddd'}}).composite([{input:label,left:0,top:0},{input:mock,left:0,top:40},{input:actual,left:width+16,top:40}]).png().toFile(out+'/'+file);
      rows.push({file,width,theme,count});
    }
  }
  const images=await Promise.all(rows.map(async r=>`<h2>${r.theme} · ${r.count} agent(s) · ${r.width}px</h2><img style="display:block;max-width:100%;height:auto" alt="Approved mock A beside the real rendered email" src="data:image/png;base64,${(await readFile(out+'/'+r.file)).toString('base64')}">`));
  await writeFile(out+'/comparison.html','<!doctype html><html><head><meta charset="utf-8"><title>CHECKIN-A email proof</title></head><body style="margin:24px;font:16px system-ui;background:#ddd"><h1>Approved mock A beside the built email</h1><p>Real HTML from the built server renderer; all PNGs loaded through the unauthenticated built server routes. Chrome light and dark, phone and desktop. The approved two-agent mock is the reference for both roster sizes. No email was sent.</p>'+images.join('')+'</body></html>');
  console.log('CHECKIN-A PASS: eight Chrome captures; exact message, all hosted PNGs loaded, no horizontal overflow. Comparison sheets saved in '+out);
} finally {
  ws?.close();chrome?.kill('SIGTERM');
  if(preview) {preview.closeAllConnections();await new Promise(resolve=>preview.close(resolve));}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await database.close();
  if(chrome) await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.on('exit',resolve));
  await rm(profile,{recursive:true,force:true});
}
