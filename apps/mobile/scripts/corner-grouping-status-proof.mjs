/** Browser proof of the shipped anchored disclosure and status overlay. */
import { build } from 'esbuild';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(mobile, '../../.corner-artifacts/grouping-proof');
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'scene.tsx'),
  `
import React from 'react';
import { createRoot } from '${mobile}/node_modules/react-dom/client';
import { View, Text } from 'react-native';
import { CornerOpenedMarkers } from '${mobile}/sources/components/buzz/CornerOpenedMarker';
import { TurnBandSlot, TurnProgressLine, TurnSettledLine } from '${mobile}/sources/components/buzz/TurnProgressLine';
import { roomBottomChromeStyles } from '${mobile}/sources/buzz/room-bottom-chrome';
import { theme } from '${mobile}/scripts/ui-alignment-proof/unistyles';
const query=new URLSearchParams(location.search), count=Number(query.get('count')??3), state=query.get('state')??'idle';
const hull=theme.buzz, chrome=roomBottomChromeStyles(hull);
const message={id:'source',cornerMarkers:Array.from({length:count},(_,i)=>({id:'event-'+i,daemonFact:{type:'corner-open',cornerId:'corner-'+i,name:['corner-lines','room-header','tray-choices','status-paint'][i],objective:''}}))};
const root=createRoot(document.getElementById('root'));
root.render(<View style={{height:'100vh',backgroundColor:hull.bgTerminal}}>
 <View style={{padding:16}}><Text style={{...hull.type.body,color:hull.textPrimary}}>lunchboxfortwo</Text><Text style={{...hull.type.body,color:hull.textPrimary}}>Open corners for these changes.</Text><CornerOpenedMarkers message={message} onOpenCorner={id=>{document.getElementById('result').textContent=id;}}/></View>
 <View testID="transcript" style={{flex:1,overflow:'hidden'}}>{Array.from({length:100},(_,i)=><Text key={i} style={{...hull.type.body,color:hull.textPrimary}}>Transcript {i} · text remains readable while idle</Text>)}</View>
 <View testID="composer-stack" style={chrome.stack}><TurnBandSlot testID="hanging-turn-chrome">{state==='working'?<TurnProgressLine label="Ruby thinking…"/>:state==='settled'?<TurnSettledLine line="Ruby finished · 42s"/>:null}</TurnBandSlot><View testID="composer" style={[chrome.composerRow,{height:70}]}><Text style={{...hull.type.body,color:hull.textPrimary}}>Tag an agent with @</Text></View></View>
</View>);
`,
);
const source = (p) => {
  for (const ext of ['', '.web.tsx', '.web.ts', '.tsx', '.ts'])
    if (existsSync(p + ext)) return p + ext;
  return p;
};
await build({
  entryPoints: [join(out, 'scene.tsx')],
  bundle: true,
  outfile: join(out, 'bundle.js'),
  jsx: 'automatic',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(mobile, 'node_modules')],
  plugins: [
    {
      name: 'proof',
      setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({
          path: join(mobile, 'node_modules/react-native-web/dist/index.js'),
        }));
        b.onResolve({ filter: /^react-native-unistyles$/ }, () => ({
          path: join(mobile, 'scripts/ui-alignment-proof/unistyles.ts'),
        }));
        b.onResolve({ filter: /^expo-haptics$/ }, () => ({ path: 'haptics', namespace: 'stub' }));
        b.onResolve({ filter: /^react-native-svg$/ }, () => ({
          path: join(mobile, 'scripts/ui-alignment-proof/svg.tsx'),
        }));
        b.onResolve({ filter: /^@\// }, (a) => ({
          path: source(join(mobile, 'sources', a.path.slice(2))),
        }));
        b.onResolve({ filter: /^\.\/(Ledger|BeelineMarkSpinner|MonoHull)$/ }, (a) => ({
          path: a.path,
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents:
            a.path === 'haptics'
              ? 'export const impactAsync=()=>{}; export const ImpactFeedbackStyle={Light:0};'
              : a.path.endsWith('Ledger')
                ? 'export const LEDGER_MARGINALIA_WIDTH=36;'
                : a.path.endsWith('MonoHull')
                  ? "export { View as HullLivePulse } from 'react-native'; export const PixelLoader=()=>null;"
                  : 'export const MARK_CELL=18; export const BeelineMarkSpinner=()=>null;',
          loader: 'jsx',
          resolveDir: mobile,
        }));
      },
    },
  ],
});
mkdirSync(join(out, 'fonts'), { recursive: true });
const fonts = readdirSync(join(mobile, 'sources/assets/fonts')).filter((f) =>
  /^(SpaceGrotesk|IBMPlexMono)/.test(f),
);
for (const f of fonts) copyFileSync(join(mobile, 'sources/assets/fonts', f), join(out, 'fonts', f));
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts.map((f) => `@font-face{font-family:'${f.replace('.ttf', '')}';src:url('/fonts/${f}')}`).join('')}body{margin:0}#result{position:fixed;top:0;right:0}</style><div id="root"></div><output id="result"></output><script src="/bundle.js"></script>`,
);
createServer((req, res) => {
  const path = join(out, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(path)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    'Content-Type',
    path.endsWith('.js')
      ? 'application/javascript'
      : path.endsWith('.ttf')
        ? 'font/ttf'
        : 'text/html',
  );
  res.end(readFileSync(path));
}).listen(19248, '0.0.0.0', () => console.log('Proof at http://127.0.0.1:19248'));
