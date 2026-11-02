/** Build inert real-component frames; inspect/capture them with chrome-devtools-axi. */
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webProofShims } from '../sources/test/browserProof';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? '.beeline-proof/room-deck-unavailable');
mkdirSync(output, { recursive: true });
for (const theme of ['bone', 'obsidian']) {
  const shims = webProofShims(mobile);
  shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
  shims['@/sync/transport/live-connection'] = `export const useConnectionState = () => 'disconnected';
    export const reconnectNow = () => { window.__reconnects = (window.__reconnects ?? 0) + 1; };`;
  await build({
    entryPoints: [path.join(mobile, 'scripts/room-deck-unavailable-proof.tsx')],
    outfile: path.join(output, `${theme}.js`),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    loader: { '.js': 'jsx', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
    plugins: [{
      name: 'native-web-proof',
      setup(api) {
        api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
          if (requested in shims) return { path: requested, namespace: 'shim' };
          if (requested === 'react-native') return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
          if (requested.startsWith('@/')) {
            const candidate = path.join(mobile, 'sources', requested.slice(2));
            return { path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
              .map(extension => candidate + extension)
              .find(entry => existsSync(entry) && statSync(entry).isFile())! };
          }
        });
        api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({ contents: shims[requested], loader: 'tsx', resolveDir: mobile }));
      },
    }],
  });
  const fonts = ['Regular', 'Medium', 'SemiBold'].map(weight => {
    const data = readFileSync(path.join(mobile, `sources/assets/fonts/SpaceGrotesk-${weight}.ttf`)).toString('base64');
    return `@font-face{font-family:SpaceGrotesk-${weight};src:url(data:font/ttf;base64,${data})}`;
  }).join('');
  writeFileSync(path.join(output, `${theme}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}${fonts}</style></head><body><div id="root"></div><script src="${theme}.js"></script></body></html>`);
}
console.log(`Built Bone and Obsidian frames in ${output}. Add ?before to render the original centered banner.`);
