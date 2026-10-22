import { writeFileSync } from 'node:fs';
const pages=await (await fetch('http://127.0.0.1:19224/json/list')).json();
const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
const call=(method,params={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
const [action,arg]=process.argv.slice(2);
if(action==='eval') console.log(JSON.stringify(await call('Runtime.evaluate',{expression:arg,returnByValue:true,awaitPromise:true})));
if(action==='size') console.log(await call('Emulation.setDeviceMetricsOverride',{width:1279,height:936,deviceScaleFactor:1,mobile:false}));
if(action==='open') console.log(await call('Page.navigate',{url:arg}));
if(action==='shot'){const r=await call('Page.captureScreenshot',{format:'png'});writeFileSync(arg,Buffer.from(r.result.data,'base64'));}
ws.close();
