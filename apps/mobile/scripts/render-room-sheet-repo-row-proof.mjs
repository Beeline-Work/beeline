import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webProofShims } from '../sources/test/browserProof.ts';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(mobile, '../../.verification/room-sheet-repo-row');
await mkdir(out, { recursive: true });
const shims = webProofShims(mobile);

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(mobile, entry)],
    outfile: path.join(out, outfile),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
    loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
    plugins: [
      {
        name: 'room-sheet-repo-row-native-web-proof',
        setup(api) {
          api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
            if (requested in shims) return { path: requested, namespace: 'shim' };
            if (requested === 'react-native')
              return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
            if (requested.startsWith('@/')) {
              const candidate = path.join(mobile, 'sources', requested.slice(2));
              return {
                path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                  .map((ext) => candidate + ext)
                  .find((file) => existsSync(file) && statSync(file).isFile()),
              };
            }
          });
          api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
            contents: shims[requested],
            loader: 'tsx',
            resolveDir: mobile,
          }));
        },
      },
    ],
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(out, outfile.replace('.js', '.html')),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#result{display:none}</style>
<div id="root"></div><pre id="result">PENDING</pre>
<script>window.__console=[];for(const level of ['error','warn']){const base=console[level].bind(console);console[level]=(...a)=>{window.__console.push(level+': '+a.map(String).join(' '));base(...a);};}</script>
<script src="${outfile}"></script>`,
  );
}

await bundle('scripts/room-sheet-repo-row-contrast-proof.tsx', 'room-sheet.js');
await bundle('scripts/new-room-repo-choice-proof.tsx', 'new-room.js');
console.log(`built ${out}/room-sheet.html and ${out}/new-room.html`);
