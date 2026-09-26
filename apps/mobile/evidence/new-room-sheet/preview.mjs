import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webProofShims } from '../../sources/test/browserProof.ts';

const evidence = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(evidence, '../..');
const out = path.resolve(mobile, '../../.scratch/new-room-sheet');
const port = Number(process.env.NEW_ROOM_SHEET_PORT ?? 4188);

await mkdir(out, { recursive: true });

const shims = webProofShims(mobile);
shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
  'beelineThemes.obsidian',
  'beelineThemes.bone',
);
shims['react-native-device-info'] = `export const getDeviceType = () => 'Handset';`;
shims['@/utils/responsive'] = 'export const useIsDesktop = () => false;';
shims['react-native-reanimated'] = shims['react-native-reanimated'].replace(
  'export const FadeInDown = entering;',
  `export const FadeInDown = entering;
    export const FadeOut = entering;
    export const interpolateColor = identity;`,
);

await build({
  entryPoints: [path.join(evidence, 'preview.tsx')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'browser',
  jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl', '.json': 'json' },
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
  plugins: [
    {
      name: 'new-room-sheet-proof',
      setup(api) {
        api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
          if (requested in shims) return { path: requested, namespace: 'shim' };
          if (requested === 'react-native')
            return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
          if (requested === 'react-native-svg')
            return {
              path: path.join(
                mobile,
                'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js',
              ),
            };
          if (requested === 'react-dom/client')
            return { path: path.join(mobile, 'node_modules/react-dom/client.js') };
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

let fonts = '';
for (const font of [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexSans-Regular',
  'IBMPlexSans-SemiBold',
  'IBMPlexMono-Regular',
]) {
  const file = path.join(mobile, 'sources/assets/fonts', `${font}.ttf`);
  if (!existsSync(file)) continue;
  const bytes = await readFile(file);
  fonts += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${bytes.toString('base64')})}`;
}

await writeFile(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${fonts}html,body,#root{margin:0;min-height:100%;background:#F3EEE4}*{box-sizing:border-box}</style>` +
    `<div id="root"></div><script src="bundle.js"></script>`,
);

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];
  const filePath =
    route === '/bundle.js' ? path.join(out, 'bundle.js') : path.join(out, 'index.html');
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : 'text/html');
  createReadStream(filePath).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`New Room sheet preview: http://127.0.0.1:${port}`);
});
