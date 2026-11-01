import { build } from 'esbuild';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { webProofShims } from '../../sources/test/browserProof';
const mobile = process.cwd();
const out = path.join(mobile, 'evidence/joined-agent-bugs/build');
const shims = webProofShims(mobile);
shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', "beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian']");
const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(name => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', name+'.ttf')).toString('base64')})}`).join('');
const before = execFileSync('git', ['show', '74f154af5c922f9bcc5059e8fb1d60a1cda689fa:apps/mobile/sources/components/buzz/RoomRosterSheet.tsx'], { encoding: 'utf8' });
async function main() {
mkdirSync(out, { recursive: true });
for (const phase of ['before', 'after']) {
  await build({ entryPoints: ['evidence/joined-agent-bugs/entry.tsx'], outfile: `${out}/${phase}.js`, bundle: true,
    platform: 'browser', jsx: 'automatic', mainFields: ['browser','module','main'],
    resolveExtensions: ['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],
    loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
    plugins: [{ name: 'proof', setup(api) {
      api.onResolve({filter: /.*/}, ({path: requested}) => {
        if (requested in shims) return {path: requested, namespace: 'shim'};
        if (requested === 'react-native') return {path: path.join(mobile,'node_modules/react-native-web/dist/index.js')};
        if (requested.startsWith('@/')) {
          const base = path.join(mobile, 'sources',requested.slice(2));
          return {path: ['', '.web.ts','.web.tsx','.ts','.tsx','.json','/index.ts','/index.tsx'].map(e => base+e).find(p => existsSync(p) && statSync(p).isFile())!};
        }
      });
      api.onLoad({filter: /.*/,namespace: 'shim'}, ({path: requested}) => ({contents: shims[requested],loader:'tsx',resolveDir:mobile}));
      if (phase === 'before') api.onLoad({filter: /\/RoomRosterSheet.tsx$/}, () => ({contents: before, loader:'tsx',resolveDir:path.join(mobile,'sources/components/buzz')}));
    }}] });
  writeFileSync(`${out}/${phase}.html`, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{margin:0;height:100%;background:#121215}</style><div id="root"></div><script src="${phase}.js"></script>`);
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
