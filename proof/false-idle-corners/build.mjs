import { build } from 'esbuild';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const here = path.resolve('proof/false-idle-corners');
const mobile = path.resolve('apps/mobile');
const modules = path.join(mobile,'node_modules');
await build({entryPoints:[path.join(here,'app.tsx')],outfile:path.join(here,'bundle.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"',__DEV__:'true',global:'globalThis'},
  nodePaths:[modules],mainFields:['browser','module','main'],conditions:['browser','import','default'],
  resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],
  plugins:[{name:'web-proof',setup(b){
    b.onResolve({filter:/^(expo-router|react-native-reanimated)$/},()=>({path:path.join(here,'stubs.tsx')}));
    b.onResolve({filter:/(Button|ErrorBanner|SurfaceGlyphLoader|CornerObjectiveLine)$/},args=>args.importer.includes('node_modules') ? undefined : ({path:path.join(here,'stubs.tsx')}));
    b.onResolve({filter:/^react-native-unistyles$/},()=>({path:path.join(here,'unistyles.ts')}));
    b.onResolve({filter:/^react-native$/},()=>({path:path.join(modules,'react-native-web/dist/index.js')}));
    b.onResolve({filter:/^react-native-svg$/},()=>({path:path.join(modules,'react-native-svg/lib/module/ReactNativeSVG.web.js')}));
    b.onResolve({filter:/^@\//},args=>{const p=path.join(mobile,'sources',args.path.slice(2));return {path: existsSync(p) && statSync(p).isFile() ? p : ['.web.tsx','.web.ts','.tsx','.ts','.json'].map(ext=>p+ext).find(existsSync) ?? path.join(p,'index.ts')};});
  }}]});
await writeFile(path.join(here,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:SpaceGrotesk-Regular;src:url('/apps/mobile/sources/assets/fonts/SpaceGrotesk-Regular.ttf')}@font-face{font-family:SpaceGrotesk-Medium;src:url('/apps/mobile/sources/assets/fonts/SpaceGrotesk-Medium.ttf')}@font-face{font-family:SpaceGrotesk-SemiBold;src:url('/apps/mobile/sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')}body{margin:0}</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`);
