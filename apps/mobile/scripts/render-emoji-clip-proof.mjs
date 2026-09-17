// Emoji top-clip render proof (web/PC stack — react-native-web, the Tauri
// desktop shell's renderer and expo web share it). Builds the real
// MessageReactionStrip and the real reaction-chip cells (before/after styles)
// with esbuild, serves the bundle, and prints the Chrome capture command.
//
//   node apps/mobile/scripts/render-emoji-clip-proof.mjs
//   google-chrome --headless=new --no-sandbox --screenshot=.verification/emoji-top-clip-web.png \
//     --window-size=430,620 --force-device-scale-factor=3 http://127.0.0.1:4177
//
// The unistyles shim resolves StyleSheet.create against the real groknight
// theme, so the proof exercises the shipped styles, not copies of them.
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const outDir = path.join(repoRoot, '.scratch/emoji-clip-proof');
const bundlePath = path.join(outDir, 'bundle.js');
const htmlPath = path.join(outDir, 'index.html');
const port = Number(process.env.EMOJI_PROOF_PORT ?? 4177);

await mkdir(outDir, { recursive: true });

const resolveSource = (candidate) => {
  for (const ext of ['', '.ts', '.tsx']) {
    if (existsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of ['/index.ts', '/index.tsx']) {
    if (existsSync(candidate + ext)) return candidate + ext;
  }
  return candidate;
};

const unistylesShim = `import { groknight } from '${path.join(mobileRoot, 'sources/buzz/groknight')}';
export const StyleSheet = {
  create: (factory) => (typeof factory === 'function' ? factory({ buzz: groknight }) : factory),
};
export function useUnistyles() {
  return { theme: { buzz: groknight } };
}
`;

await build({
  entryPoints: [path.join(mobileRoot, 'scripts/emoji-clip-proof.tsx')],
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: bundlePath,
  platform: 'browser',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  format: 'iife',
  jsx: 'automatic',
  sourcemap: false,
  plugins: [
    {
      name: 'emoji-proof-shims',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^react-native$/ }, () => ({
          path: path.join(mobileRoot, 'node_modules/react-native-web/dist/index.js'),
        }));
        buildApi.onResolve({ filter: /^react-native-unistyles$/ }, () => ({
          path: 'unistyles-shim',
          namespace: 'emoji-proof',
        }));
        buildApi.onResolve({ filter: /^\.\/HullActionSheet$/ }, (args) =>
          args.importer.endsWith('/components/buzz/MessageReactionStrip.tsx')
            ? { path: 'hull-sheet-inset', namespace: 'emoji-proof' }
            : undefined,
        );
        buildApi.onLoad({ filter: /.*/, namespace: 'emoji-proof' }, (args) => {
          if (args.path === 'unistyles-shim') {
            return { contents: unistylesShim, loader: 'tsx', resolveDir: mobileRoot };
          }
          if (args.path === 'hull-sheet-inset') {
            return { contents: 'export const HULL_SHEET_INSET = 22;', loader: 'ts' };
          }
          return undefined;
        });
        buildApi.onResolve({ filter: /^@\// }, (args) => ({
          path: resolveSource(path.join(mobileRoot, 'sources', args.path.slice(2))),
        }));
      },
    },
  ],
});

await writeFile(
  htmlPath,
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>emoji top-clip proof</title></head><body style="margin:0"><div id="root"></div><script src="bundle.js"></script></body></html>',
);

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];
  const filePath = route === '/bundle.js' ? bundlePath : htmlPath;
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : 'text/html');
  createReadStream(filePath).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Emoji top-clip proof: http://127.0.0.1:${port}`);
});
