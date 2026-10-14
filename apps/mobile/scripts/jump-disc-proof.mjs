/** Render shipped jump/status components and exercise the complete visible hit box. */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync('/tmp/jump-disc-proof-');
const baseline = process.argv.includes('--baseline');
const entry = join(out, 'scene.tsx');
writeFileSync(entry, `
import React, {useState} from 'react';
import { createRoot } from '${mobile}/node_modules/react-dom/client';
import { flushSync } from '${mobile}/node_modules/react-dom';
import { View, Text } from 'react-native';
import { TurnBandSlot, TurnProgressLine } from '${mobile}/sources/components/buzz/TurnProgressLine';
import { RoomCatchUpControls } from '${mobile}/sources/components/buzz/RoomCatchUpControls';
import { roomBottomChromeStyles } from '${mobile}/sources/buzz/room-bottom-chrome';
const chrome = roomBottomChromeStyles({bgTerminal:'#F3EEE4',border:'#DED2BC'});
const root = createRoot(document.getElementById('root'));
let jumps = 0;
function Scene({line, taller, keyboard, width}) {
 const [inset,setInset] = useState(0);
 const disc = <RoomCatchUpControls corner={false} badgeCount={3} discVisible bottomInset={${baseline} ? undefined : inset} onJumpToNewest={() => jumps++} />;
 return <View style={{height:keyboard ? 460 : 780,width,backgroundColor:'#F3EEE4'}}>
  <View style={{flex:1,overflow:'hidden'}}><Text>Scrolled older transcript</Text>{disc}</View>
  <View style={chrome.stack}>
   <TurnBandSlot testID="slot" onTopInset={setInset}>
    {line && <View style={{paddingTop:taller ? 35 : 0}}><TurnProgressLine label="Ruby Mulling…" startedAt={1} onStop={() => {}} /></View>}
   </TurnBandSlot>
   <View style={[chrome.composerRow,{height:70}]}><Text>Message</Text></View>
  </View>
 </View>;
}
const results=[];
(async()=>{
for (const width of [390,412]) for (const line of [false,true]) for (const taller of [false,true]) for (const keyboard of [false,true]) {
 flushSync(()=>root.render(<Scene {...{line,taller,keyboard,width}}/>));
 await new Promise(requestAnimationFrame);
 await new Promise(requestAnimationFrame);
 await new Promise(r=>setTimeout(r,100));
 const disc=document.querySelector('[data-testid="newest-jump-disc"]');
 const slot=document.querySelector('[data-testid="slot"]');
 const d=disc.getBoundingClientRect(), s=slot.getBoundingClientRect();
 const hit=[ [d.left+2,d.top+22], [d.left+22,d.bottom-2], [d.right-2,d.top+22], [d.left+22,d.top+2] ].every(([x,y])=>disc.contains(document.elementFromPoint(x,y)));
 const before=jumps; disc.click();
 results.push({width,line,taller,keyboard,gap:s.top-d.bottom,hit,jumped:jumps===before+1,pass:d.bottom<=s.top-3.9&&hit&&jumps===before+1});
}
document.getElementById('result').textContent=JSON.stringify(results);
})();
`);
const source = p => { for(const ext of ['', '.web.tsx','.web.ts','.tsx','.ts']) if(existsSync(p+ext)) return p+ext; return p; };
await build({entryPoints:[entry],bundle:true,outfile:join(out,'bundle.js'),jsx:'automatic',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[join(mobile,'node_modules')],plugins:[{name:'proof',setup(b){
 b.onResolve({filter:/^react-native$/},()=>({path:join(mobile,'node_modules/react-native-web/dist/index.js')}));
 b.onResolve({filter:/^react-native-unistyles$/},()=>({path:join(mobile,'scripts/ui-alignment-proof/unistyles.ts')}));
 b.onResolve({filter:/^react-native-svg$/},()=>({path:join(mobile,'scripts/ui-alignment-proof/svg.tsx')}));
 b.onResolve({filter:/^@\//},a=>({path:source(join(mobile,'sources',a.path.slice(2)))}));
 b.onResolve({filter:/^\.\/(BeelineMarkSpinner|MonoHull)$/},a=>a.importer.endsWith('TurnProgressLine.tsx')?{path:a.path,namespace:'stub'}:undefined);
 b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:a.path.endsWith('MonoHull')?"export { View as HullLivePulse } from 'react-native';":"export const MARK_CELL=18; export const BeelineMarkSpinner=()=>null;",loader:'jsx',resolveDir:mobile}));
}}]});
writeFileSync(join(out,'proof.html'),`<html><body style="margin:0"><div id="root"></div><pre id="result"></pre><script>${readFileSync(join(out,'bundle.js'),'utf8')}</script></body></html>`);
const playwrightModule = process.env.JUMP_PROOF_PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(playwrightModule);
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN ?? '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
let results;
try {
 const page = await browser.newPage({viewport:{width:500,height:1000}});
 await page.goto(`file://${out}/proof.html`);
 await page.waitForFunction(()=>document.getElementById('result').textContent.length > 0);
 results=JSON.parse(await page.locator('#result').textContent());
} finally { await browser.close(); }
console.log(JSON.stringify({baseline,results},null,2));
if(results.some(r=>!r.pass)) process.exitCode=1;
