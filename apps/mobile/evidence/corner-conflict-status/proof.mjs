// Build the real phone status component against captured PhoneService responses.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '../..');
const out = resolve(mobile, '../../.corner-artifacts/conflict-browser');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'scene.tsx'), `
import React from 'react';
import {createRoot} from '${mobile}/node_modules/react-dom/client';
import {View,Text} from 'react-native';
import {CornerStatusLine} from '${mobile}/sources/components/buzz/CornerStatusLine';
import {readRoomView} from '${mobile}/../../packages/api-contract/dist/phone.js';
import {theme} from '${mobile}/scripts/ui-alignment-proof/unistyles';
import snapshots from '${here}/responses.json';
const state=new URLSearchParams(location.search).get('state')||'conflict';
const view=readRoomView(snapshots[state]);
const hull=theme.buzz;
createRoot(document.getElementById('root')).render(<View style={{height:'100vh',backgroundColor:hull.bgBase,paddingTop:32}}>
<Text style={{...hull.type.body,color:hull.textPrimary,padding:16}}>CONFLICT-STATUS-1 · {state}</Text>
<CornerStatusLine lifecycle={view.cornerLifecycle} archived={false} onOpenPullRequest={()=>{}}/>
</View>);
`);
function source(path) {
  for (const ext of ['', '.web.tsx', '.web.ts', '.tsx', '.ts']) if (existsSync(path + ext)) return path + ext;
  return path;
}
await build({entryPoints:[join(out,'scene.tsx')],bundle:true,outfile:join(out,'bundle.js'),
  jsx:'automatic',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},
  nodePaths:[join(mobile,'node_modules')],plugins:[{name:'phone-proof',setup(b){
    b.onResolve({filter:/^react-native$/},()=>({path:join(mobile,'node_modules/react-native-web/dist/index.js')}));
    b.onResolve({filter:/^react-native-unistyles$/},()=>({path:join(mobile,'scripts/ui-alignment-proof/unistyles.ts')}));
    b.onResolve({filter:/^@\//},a=>({path:source(join(mobile,'sources',a.path.slice(2)))}));
  }}]});
writeFileSync(join(out,'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:IBMPlexMono-Regular;src:url(/IBMPlexMono-Regular.ttf)}@font-face{font-family:SpaceGrotesk-Regular;src:url(/SpaceGrotesk-Regular.ttf)}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
createServer((req,res)=>{
  const font = /^\/(IBMPlexMono-Regular|SpaceGrotesk-Regular)\.ttf$/.test(req.url);
  const path=font ? join(mobile,'sources/assets/fonts',req.url.slice(1)) : join(out,req.url.startsWith('/bundle.js')?'bundle.js':'index.html');
  res.setHeader('Content-Type',font?'font/ttf':path.endsWith('.js')?'application/javascript':'text/html');
  res.end(readFileSync(path));
}).listen(19249,'127.0.0.1',()=>console.log('http://127.0.0.1:19249/?state=conflict'));
