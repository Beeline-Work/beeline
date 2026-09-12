import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';

const root = process.cwd(),
  mobile = path.join(root, 'apps/mobile');
const out = path.join(root, '.scratch/relay-proof');
const variantPath = path.join(mobile, 'sources/app/(app)/beeline/chat/RoomMessageVariants.tsx');
const hullPath = path.join(mobile, 'sources/components/buzz/MonoHull.tsx');
// Mount the production declarations verbatim, excluding unrelated native-only
// module initialization. No renderer, layout, copy or style is reimplemented.
async function declarations(file, names) {
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements
    .filter((node) => {
      const name = node.name?.text ?? node.declarationList?.declarations[0]?.name?.text;
      return names.includes(name);
    })
    .map((node) => node.getText(ast))
    .join('\n');
}
await writeFile(
  path.join(out, 'variants.tsx'),
  `
import React, {useState,useRef,useEffect} from '${mobile}/node_modules/react';
import {Text,View,Pressable,Platform} from 'react-native';
import {StyleSheet} from './unistyles';
import {groknight} from '${mobile}/sources/buzz/groknight';
import {Typography} from '${mobile}/sources/constants/Typography';
import {cornerName} from '${mobile}/sources/buzz/corners';
import {ALIVE_RING_PAD} from '${mobile}/sources/buzz/identity-mark';
import {HullSurface} from './hull';
${await declarations(variantPath, ['RepositoryFactCard', 'DaemonFactCard', 'RelayHandOff', 'styles'])}
`,
);
await writeFile(
  path.join(out, 'hull.tsx'),
  `
import React from '${mobile}/node_modules/react';
import {View} from 'react-native';
import {StyleSheet} from './unistyles';
import {Typography} from '${mobile}/sources/constants/Typography';
import {typeRoles} from '${mobile}/sources/buzz/groknight';
${await declarations(hullPath, ['HullSurface', 'SCRATCHES', 'styles'])}
`,
);
await writeFile(
  path.join(out, 'unistyles.ts'),
  `
import {StyleSheet as RN} from 'react-native';
import {groknight} from '${mobile}/sources/buzz/groknight';
export const StyleSheet={...RN,create:(f)=>RN.create(typeof f==='function'?f({buzz:groknight}):f)};
`,
);
await writeFile(
  path.join(out, 'entry.tsx'),
  `
import React from '${mobile}/node_modules/react';
import {createRoot} from '${mobile}/node_modules/react-dom/client';
import {Text,View} from 'react-native';
import {RelayHandOff,DaemonFactCard} from './variants';
import {displayRoomMessages} from '${mobile}/sources/buzz/room-view-presentation';
import {foldSystemLines} from '${mobile}/sources/buzz/system-lines';
import {groknight} from '${mobile}/sources/buzz/groknight';
import data from './data.json';
const roomMode = new URLSearchParams(location.search).has('room');
const messages = foldSystemLines(displayRoomMessages((roomMode?data.room:data.corner).messages,'a'.repeat(64)));
createRoot(document.getElementById('root')!).render(<View style={{minHeight:844,backgroundColor:groknight.bgBase,padding:22}}>
  <Text style={{...groknight.type.sectionHead,color:groknight.textSecondary,marginTop:20}}>BEELINE · {roomMode?'ROOM':'CORNER'}</Text>
  <Text style={{...groknight.type.hero,color:groknight.textPrimary,marginTop:14,marginBottom:28}}>{roomMode?'#beeline':'Endpoint work'}</Text>
  {messages.map(m=>m.daemonFact?<View key={m.id}><DaemonFactCard message={m} onOpenCorner={()=>{}} onOpenUrl={()=>{}}/>
    {m.relayReports?.map(r=><RelayHandOff key={r.id} message={r}/>)}</View>:
    m.relay?<RelayHandOff key={m.id} message={m}/>:null)}
</View>);
`,
);
await build({
  entryPoints: [path.join(out, 'entry.tsx')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  conditions: ['browser'],
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.js', '.json'],
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: {
    react: path.join(mobile, 'node_modules/react'),
    'react-native': path.join(mobile, 'node_modules/react-native-web/dist/index.js'),
    '@': path.join(mobile, 'sources'),
  },
});
const fonts = [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexMono-Regular',
  'IBMPlexSans-Regular',
  'IBMPlexSans-SemiBold',
];
await writeFile(
  path.join(out, 'index.html'),
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
${fonts.map((f) => `@font-face{font-family:'${f}';src:url('/fonts/${f}.ttf')}`).join('\n')}
html,body{margin:0;background:#14091A}*{box-sizing:border-box}
</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`,
);
if (process.argv.includes('--build-only')) process.exit(0);

createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = url.startsWith('/fonts/')
    ? path.join(mobile, 'sources/assets', url)
    : path.join(out, url === '/bundle.js' ? 'bundle.js' : 'index.html');
  res.setHeader(
    'Content-Type',
    file.endsWith('.js') ? 'text/javascript' : file.endsWith('.ttf') ? 'font/ttf' : 'text/html',
  );
  createReadStream(file).pipe(res);
}).listen(4187, '127.0.0.1', () => console.log('Relay proof http://127.0.0.1:4187'));
