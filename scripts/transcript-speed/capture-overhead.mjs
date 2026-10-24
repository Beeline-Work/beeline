/** Paired sampler-on/off key-to-render bounds; commit hooks remain installed. */
import { mkdir, writeFile } from 'node:fs/promises';
import { rooms, workspace } from './fixture.mjs';
import { percentile } from './metrics.mjs';
const output = process.argv[2];
if (!output) throw new Error('Provide an output directory');
await mkdir(output, { recursive: true });
const session = process.env.TRANSCRIPT_WEBDRIVER_SESSION;
let browser, page;
async function wd(endpoint, value) {
  const response = await fetch(`http://127.0.0.1:19885/session/${session}/${endpoint}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) });
  const body=await response.json();if(!response.ok||body.value?.error)throw new Error(JSON.stringify(body));return body.value;
}
const evaluate=(script,...args)=>session?wd('execute/sync',{script,args}):page.evaluate(({script,args})=>Function(script).apply(null,args),{script,args});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  if(!session) {
    const {chromium}=await import(process.env.PLAYWRIGHT_CORE_PATH??'/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
    page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto('http://127.0.0.1:19882/review/transcript-fixture-local-only-36bbb7b4');await page.waitForURL('**/beeline/channels**');
    await page.goto(`http://127.0.0.1:19882/beeline/chat/${rooms[0]}?communityId=${workspace}`);
    await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  } else await wd('url',{url:`tauri://localhost/beeline/chat/${rooms[0]}?communityId=${workspace}`});
  await pause(2500);
  await evaluate(`globalThis.__bounds=[]; addEventListener('keydown',event=>{if(!event.isTrusted||event.key.length!==1)return;const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>globalThis.__bounds.push(performance.now()-start)));},true)`);
  let input;
  if(session) input=(await wd('element',{using:'css selector',value:'textarea[aria-label=Message]'}))['element-6066-11e4-a52e-4f735466cecf'];
  else await page.getByRole('textbox',{name:'Message',exact:true}).focus();
  const samples=[];
  for(let pair=0;pair<21;pair++) for(const enabled of pair%2?[true,false]:[false,true]) {
    if(session) await wd(`element/${input}/value`,{text:'\uE009a\uE000\uE003'});
    else await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
    await pause(150);
    await evaluate('globalThis.__bounds=[];if(arguments[0])globalThis.__transcriptSpeed.begin("overhead")',enabled);
    if(session) await wd(`element/${input}/value`,{text:'m'});else await page.keyboard.type('m');
    await pause(200);
    const values=await evaluate('if(arguments[0])globalThis.__transcriptSpeed.end();return globalThis.__bounds',enabled);
    if(values.length!==1) throw new Error('Expected one trusted key event in overhead pair');
    samples.push({pair,enabled,upperBoundMs:values[0]});
  }
  const stats=enabled=>{const v=samples.filter(s=>s.enabled===enabled).map(s=>s.upperBoundMs);return {n:v.length,p50Ms:percentile(v,.5),p95Ms:percentile(v,.95)};};
  const inactive=stats(false),active=stats(true);
  await writeFile(`${output}/capture.json`,JSON.stringify({method:'Alternating paired trusted keydown to second animation callback with sampler active/inactive. Measures incremental sampling cost only; layout-effect hooks are installed in both arms. Not total instrumentation overhead.',inactive,active,p50DifferenceMs:active.p50Ms-inactive.p50Ms,p95DifferenceMs:active.p95Ms-inactive.p95Ms,samples},null,2));
} finally {if(browser)await browser.close();}
