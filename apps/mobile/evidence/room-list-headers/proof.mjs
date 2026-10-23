/** Browser stand-in for Reproductions 1 and 2: Room list headers and the turn line over scrolled transcript.
 * SRC = apps/mobile tree whose sources to render (HEAD copy or worktree); OUT = output dir; PORT. */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const mobile = resolve(process.env.MOBILE);
const src = resolve(process.env.SRC);
const out = resolve(process.env.OUT);
const port = Number(process.env.PORT);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'scene.tsx'), `
import React from 'react';
import { createRoot } from '${mobile}/node_modules/react-dom/client';
import { View, Text } from 'react-native';
import { RoomListSectionHeader } from '${src}/sources/components/buzz/RoomListSectionHeader';
import { TurnBandSlot, TurnProgressLine, TurnSettledLine } from '${src}/sources/components/buzz/TurnProgressLine';
import { roomBottomChromeStyles } from '${src}/sources/buzz/room-bottom-chrome';
import { theme } from '${src}/scripts/ui-alignment-proof/unistyles';
const q=new URLSearchParams(location.search), state=q.get('state')??'idle', counted=q.get('counted')==='1';
const hull=theme.buzz, chrome=roomBottomChromeStyles(hull);
const row=(name,preview)=><View key={name} style={{paddingHorizontal:16,paddingVertical:10}}><Text style={{...hull.type.body,color:hull.textPrimary}}>{name}</Text><Text style={{...hull.type.body,color:hull.textMuted}}>{preview}</Text></View>;
// Each commit's call site: HEAD passed count={section.data.length}; the fix passes none.
const headers=<View testID="headers">
 <RoomListSectionHeader title="Rooms" count={counted?3:undefined} actionAccessibilityLabel="Create a new Room" onAction={()=>{}} testID="rooms-header"/>
 {row('Beeline','Speedy: Merged #2814')}{row('Markets','Z.ai is down 28% from its high')}{row('Design','Ruby: Mock is ready')}
 <RoomListSectionHeader title="Direct messages" count={counted?2:undefined} actionAccessibilityLabel="Start a direct message" onAction={()=>{}} testID="dm-header"/>
 {row('Ruby','Sounds good')}{row('Speedy','Review is done')}
</View>;
// Production phone path: the slot is told thinking only while composerAck is set.
const line=state==='working'?<TurnProgressLine label="Ruby thinking…"/>:state==='settled'?<TurnSettledLine line="Ruby finished · 42s"/>:null;
createRoot(document.getElementById('root')).render(<View style={{height:'100vh',backgroundColor:hull.bgTerminal}}>
 {q.get('view')==='headers'?headers:<>
 <View testID="transcript" style={{flex:1,overflow:'hidden',justifyContent:'flex-end'}}>{Array.from({length:60},(_,i)=><Text key={i} style={{...hull.type.body,color:hull.textPrimary}}>Transcript line {i} · scrolled up behind the composer</Text>)}</View>
 <View testID="composer-stack" style={chrome.stack}><TurnBandSlot thinking={state==='working'} testID="hanging-turn-chrome">{line}</TurnBandSlot><View testID="composer" style={[chrome.composerRow,{height:70}]}><Text style={{...hull.type.body,color:hull.textMuted}}>Tag an agent with @</Text></View></View>
 </>}
</View>);
`);
const source = (p) => { for (const ext of ['', '.web.tsx', '.web.ts', '.tsx', '.ts']) if (existsSync(p + ext)) return p + ext; return p; };
await build({
  entryPoints: [join(out, 'scene.tsx')], bundle: true, outfile: join(out, 'bundle.js'), jsx: 'automatic', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, nodePaths: [join(mobile, 'node_modules')],
  banner: { js: 'var process={env:{NODE_ENV:"production"}};' }, loader: { '.js': 'jsx', '.ttf': 'file', '.png': 'file' }, assetNames: '[name]', publicPath: '/',
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  plugins: [{ name: 'proof', setup(b) {
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: join(mobile, 'node_modules/react-native-web/dist/index.js') }));
    b.onResolve({ filter: /^react-native-unistyles$/ }, () => ({ path: join(src, 'scripts/ui-alignment-proof/unistyles.ts') }));
    b.onResolve({ filter: /^expo-haptics$/ }, () => ({ path: 'haptics', namespace: 'stub' }));
    b.onResolve({ filter: /^react-native-svg$/ }, () => ({ path: join(src, 'scripts/ui-alignment-proof/svg.tsx') }));
    b.onResolve({ filter: /^@\// }, (a) => ({ path: source(join(src, 'sources', a.path.slice(2))) }));
    b.onResolve({ filter: /^\.\/(Ledger|BeelineMarkSpinner|MonoHull)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === 'haptics' ? 'export const impactAsync=()=>{}; export const ImpactFeedbackStyle={Light:0};'
        : a.path.endsWith('Ledger') ? 'export const LEDGER_MARGINALIA_WIDTH=36;'
        : a.path.endsWith('MonoHull') ? "export { View as HullLivePulse } from 'react-native'; export const PixelLoader=()=>null;"
        : 'export const MARK_CELL=18; export const BeelineMarkSpinner=()=>null;',
      loader: 'jsx', resolveDir: mobile,
    }));
  } }],
});
mkdirSync(join(out, 'fonts'), { recursive: true });
const fonts = readdirSync(join(mobile, 'sources/assets/fonts')).filter((f) => /^(SpaceGrotesk|IBMPlexMono)/.test(f));
for (const f of fonts) copyFileSync(join(mobile, 'sources/assets/fonts', f), join(out, 'fonts', f));
writeFileSync(join(out, 'index.html'), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts.map((f) => `@font-face{font-family:'${f.replace('.ttf', '')}';src:url('/fonts/${f}')}`).join('')}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>`);
createServer((req, res) => {
  const p = join(out, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', p.endsWith('.js') ? 'application/javascript' : p.endsWith('.ttf') ? 'font/ttf' : 'text/html');
  res.end(readFileSync(p));
}).listen(port, '127.0.0.1', () => console.log('Proof at http://127.0.0.1:' + port));
