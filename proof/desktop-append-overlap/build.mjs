import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '../../apps/mobile');
const nodePaths = [path.join(mobileRoot, 'node_modules')];

await build({
  entryPoints: [path.join(here, 'app.tsx')],
  bundle: true,
  define: { 'process.env.NODE_ENV': '"development"' },
  outfile: path.join(here, 'bundle.js'),
  platform: 'browser',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  format: 'iife',
  nodePaths,
  jsx: 'automatic',
  sourcemap: false,
  plugins: [
    {
      name: 'rnw-shim',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^react-native$/ }, () => ({
          path: path.join(mobileRoot, 'node_modules/react-native-web/dist/index.js'),
        }));
        buildApi.onResolve({ filter: /^react-native-svg$/ }, () => ({
          path: path.join(mobileRoot, 'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js'),
        }));
      },
    },
  ],
});

await writeFile(
  path.join(here, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>desktop append overlap repro</title>
<style>html,body{margin:0;background:#0b0b10;}#root{padding:8px;}</style></head>
<body><div id="root"></div>
<pre id="log" style="color:#9fe29f;font:11px monospace;padding:8px;white-space:pre-wrap;"></pre>
<pre id="status" style="color:#e2b89f;font:11px monospace;padding:0 8px;"></pre>
<script src="bundle.js"></script></body></html>`,
);
console.log('built');
