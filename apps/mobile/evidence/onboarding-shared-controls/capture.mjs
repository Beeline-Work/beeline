import fs from 'node:fs';
import path from 'node:path';
const port=Number(process.env.ONBOARDING_CDP_PORT??9337);
const tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map();const errors=[];
ws.onmessage=e=>{const x=JSON.parse(e.data);if(x.method==='Runtime.exceptionThrown')errors.push(x.params.exceptionDetails.text+': '+x.params.exceptionDetails.exception?.description);if(x.id){const p=pending.get(x.id);pending.delete(x.id);x.error?p[1](x.error):p[0](x.result)}};
const call=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,[r,j]);ws.send(JSON.stringify({id:n,method,params}))});
const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
await call('Page.enable');await call('Runtime.enable');
const screens=['sign-in','sign-in-error','profile','welcome&step=0','welcome&step=1','welcome&step=2','welcome&step=3','github','repository','starters','repository-choice&mode=none','repository-choice&mode=link','repository-choice&mode=create','repository-choice&mode=link&connected=0','repo-picker','agent-pending','agent-wait','agent-failed','agent-key','empty-room','workspace','workspace&join=1','create-workspace','invite','invite-offline','invite-unavailable','new-room','new-room-picker','repo-empty'];
if(process.env.ONBOARDING_SCREENS)screens.splice(0,screens.length,...process.env.ONBOARDING_SCREENS.split(','));
const phase=process.env.ONBOARDING_PHASE??'after';const device=process.env.ONBOARDING_DEVICE??'desktop';
const output=path.join(import.meta.dirname,phase,device);fs.mkdirSync(output,{recursive:true});const records=fs.existsSync(path.join(output,'results.json'))?JSON.parse(fs.readFileSync(path.join(output,'results.json'))).filter(r=>!screens.includes(r.screen)):[];
for(const theme of ['obsidian','bone'])for(const screen of screens){
  if(device==='desktop')await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  errors.length=0;const url=`http://127.0.0.1:${phase==='before'?4198:4197}/?screen=${screen}&theme=${theme}`;
  await call('Page.navigate',{url});await new Promise(r=>setTimeout(r,900));
  for(let retry=0;retry<10;retry++){if(await evaluate('document.body.innerText.length>0'))break;await new Promise(r=>setTimeout(r,200));}
  await evaluate('document.fonts.ready');await new Promise(r=>setTimeout(r,200));
  const result=await evaluate(`({text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth+1,buttons:[...document.querySelectorAll('[role=button]')].map(n=>({label:n.getAttribute('aria-label')||n.innerText,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))})`);
  const file=`${screen.replaceAll('&','-').replaceAll('=','-')}-${theme}.png`;
  const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,file),Buffer.from(shot.data,'base64'));
  records.push({screen,theme,...result,errors:[...errors],file});console.log(JSON.stringify({phase,device,screen,theme,textLength:result?.text?.length,errors:errors.length}));
}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(records,null,2));ws.close();
