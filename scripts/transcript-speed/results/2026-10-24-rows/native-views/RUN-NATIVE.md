# Native row capture inputs

These local-only helpers were read before use. They add diagnostic rows only
to the disposable fixture. Reset those rows before timing. APK paths, device,
ADB server and ports belong to this corner. The first before timing trial was
run separately; the shell helper records the remaining alternating arms.

## native-row-fixture.mjs

```javascript
import pg from 'pg';
import { localDatabase, rooms, viewer, agents, hash } from '../../transcript-speed/fixture.mjs';
const db = new pg.Client({ connectionString: localDatabase(process.env.LATENCY_RIG_DATABASE_URL) });
await db.connect();
try {
  const rows = [
    ['plain-header', viewer, 'Native row plain text.', 'message'],
    ['plain-grouped', viewer, 'Native row grouped text.', 'message'],
    ['markdown', viewer, '## Native row markdown\n\nA **bold** paragraph.\n\nAnother paragraph.', 'message'],
    ['attachment', viewer, 'Native row attachment.', 'message'],
    ['card', agents[0], 'Proposed corner: Native row card — Local view counting fixture', 'message'],
    ['system', viewer, 'Native row system line.', 'system'],
  ];
  for (const [i, [kind, author, text, presentation]] of rows.entries()) {
    const attachments = kind === 'attachment' ? [{url:'http://10.0.2.2:19882/image.png?native-row',name:'native-row.png',mimeType:'image/png',size:68,width:320,height:180}] : [];
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,attachments,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text`,
      [hash(`native-row-count:${kind}`), rooms[1], author, text, presentation, JSON.stringify(attachments), new Date(Date.UTC(2026,9,26,0,0,i)).toISOString()]);
  }
} finally { await db.end(); }
```

## native-row-android.mjs

```javascript
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.argv[2]; await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('adb',['-s','127.0.0.1:5555',...a],{maxBuffer:32e6});
if(adb('shell','getprop','ro.kernel.qemu').toString().trim()!=='1')throw Error('Fixture emulator only');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const [theme,night] of [['dark','yes'],['light','no']]){
  adb('shell','cmd','uimode','night',night);
  await pause(1500);
  let tree,stable=0,prior='';
  for(let i=0;i<30;i++){
    adb('shell','am','broadcast','-a','app.usebeeline.LATENCY_RIG_PROFILE','-n','app.usebeeline/.LatencyRigReceiver','--es','action','views');
    await pause(150);
    tree=JSON.parse(adb('shell','cat','/sdcard/Android/data/app.usebeeline/files/latency-views.json'));
    const flat=n=>[n,...n.children.flatMap(flat)];
    const nodes=flat(tree.tree);
    const labels=nodes.filter(n=>n.text?.includes('Native row')).map(n=>[n.text,n.x,n.y,n.width,n.height]);
    const signature=JSON.stringify(labels);
    stable=labels.length>=6&&signature===prior?stable+1:0;prior=signature;
    if(stable>=3)break;
    await pause(500);
  }
  if(stable<3)throw Error('Diagnostic rows did not reach stable native bounds');
  await writeFile(`${out}/${theme}-tree.json`,JSON.stringify(tree));
  await writeFile(`${out}/${theme}.png`,adb('exec-out','screencap','-p'));
}
```

## native-row-web.mjs

```javascript
import { chromium } from '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { rooms, workspace } from '../../transcript-speed/fixture.mjs';
const out = process.argv[2];
await mkdir(out, {recursive:true});
const browser = await chromium.launch({executablePath:'/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless:true,args:['--no-sandbox']});
try {
  const page = await browser.newPage({viewport:{width:1280,height:1100}});
  page.on('response', response => {
    if(response.status()>=400)console.error('HTTP',response.status(),new URL(response.url()).pathname);
  });
  page.on('requestfailed', request => console.error('request failed',new URL(request.url()).origin,request.failure()?.errorText));
  page.on('console', message => {if(message.type()==='error')console.error(message.text().slice(0,500));});
  for (const colorScheme of ['light','dark']) {
    await page.emulateMedia({colorScheme});
    page.on('pageerror', error => console.error(error.message));
    await page.addInitScript(() => {
      const OriginalDate = Date;
      const fixed = OriginalDate.UTC(2026,9,25,3,0,0);
      globalThis.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [fixed])); }
        static now() { return fixed; }
      };
    });
    await page.goto('http://127.0.0.1:20082/review/transcript-fixture-local-only-36bbb7b4');
    try { await page.waitForURL('**/beeline/channels**'); }
    catch(error) {await page.screenshot({path:`${out}/failed-login.png`});throw error;}
    await page.goto(`http://127.0.0.1:20082/beeline/chat/${rooms[1]}?communityId=${workspace}`);
    await page.getByText('Native row system line.',{exact:true}).last().waitFor();
    await page.waitForTimeout(3000);
    await page.mouse.move(5,5);
    await page.screenshot({path:`${out}/${colorScheme}.png`});
    await writeFile(`${out}/${colorScheme}-bounds.json`,JSON.stringify(await page.locator('[data-testid^="copy-message-"], [data-testid^="chat-message-text-"]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.testid,text:n.textContent,bounds:n.getBoundingClientRect().toJSON()}))),null,2));
  }
} finally {await browser.close();}
```

## run-native-arms.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /home/lunchbox/.local/state/beeline/corners/139454ab-340e-4a1a-93f3-143744c8e3cd
export PATH=/home/lunchbox/.nvm/versions/node/v20.11.0/bin:/home/lunchbox/android-sdk/platform-tools:/usr/bin:/bin
export ANDROID_ADB_SERVER_PORT=5694 LATENCY_RIG_DEVICE=127.0.0.1:5555
export LATENCY_RIG_DATABASE_URL='postgresql://localhost/beeline_latency_rig_transcript_rows_139454ab?host=%2Fvar%2Frun%2Fpostgresql'
export TRANSCRIPT_CONTROL_PORT=19926 TRANSCRIPT_ROW_SCENARIOS_ONLY=1 TRANSCRIPT_REPEAT_COUNT=1 TRANSCRIPT_FABRIC_MARKERS=1
for entry in after-flat:1 before:2 after-flat:2 before:3 after-flat:3; do
  arm=${entry%:*}; trial=${entry#*:}
  out="scripts/latency-rig/.local/native-rows-$arm/trial-$trial"
  mkdir -p "$out"
  date -u > "$out/host.txt"
  cat /proc/loadavg >> "$out/host.txt"
  free -m >> "$out/host.txt"
  node scripts/transcript-speed/reset.mjs > "$out/reset.log"
  export TRANSCRIPT_APK="$PWD/scripts/latency-rig/.local/rows-views-$arm.apk"
  adb -s "$LATENCY_RIG_DEVICE" install -r "$TRANSCRIPT_APK" > "$out/install.log"
  adb -s "$LATENCY_RIG_DEVICE" shell cmd uimode night no >> "$out/install.log"
  adb -s "$LATENCY_RIG_DEVICE" shell am force-stop app.usebeeline
  node scripts/transcript-speed/capture-android.mjs "$out" > "$out/capture.log" 2>&1
  printf '%s finished\n' "$entry"
done
```
