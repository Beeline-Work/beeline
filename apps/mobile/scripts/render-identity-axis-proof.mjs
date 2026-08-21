import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const outDir = path.join(repoRoot, '.scratch/identity-axis-proof');
const bundlePath = path.join(outDir, 'bundle.js');
const htmlPath = path.join(outDir, 'index.html');
const shimPath = path.join(mobileRoot, 'scripts/identity-axis-proof-shims.tsx');
const buildOnly = process.argv.includes('--build-only');
const port = Number(process.env.IDENTITY_PROOF_PORT ?? 4173);

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(mobileRoot, 'scripts/identity-axis-proof.tsx')],
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: bundlePath,
  platform: 'browser',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: [
    '.web.tsx',
    '.web.ts',
    '.web.jsx',
    '.web.js',
    '.tsx',
    '.ts',
    '.jsx',
    '.js',
    '.css',
    '.json',
  ],
  format: 'iife',
  jsx: 'automatic',
  sourcemap: false,
  plugins: [
    {
      name: 'identity-proof-shims',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^react-native$/ }, () => ({
          path: path.join(mobileRoot, 'node_modules/react-native-web/dist/index.js'),
        }));
        buildApi.onResolve({ filter: /^react-native-svg$/ }, () => ({
          path: path.join(
            mobileRoot,
            'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js',
          ),
        }));
        buildApi.onResolve({ filter: /^react-native-unistyles$/ }, () => ({ path: shimPath }));
        buildApi.onResolve({ filter: /^\.\/MonoHull$/ }, (args) =>
          args.importer.endsWith('/components/buzz/IdentityMark.tsx')
            ? { path: shimPath }
            : undefined,
        );
        buildApi.onResolve({ filter: /^@\/buzz\/identity-mark$/ }, () => ({
          path: path.join(mobileRoot, 'sources/buzz/identity-mark.ts'),
        }));
      },
    },
  ],
});

await writeFile(
  htmlPath,
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beeline identity axis proof</title></head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
);

if (buildOnly) {
  console.log(`Built ${htmlPath}`);
  process.exit(0);
}

const server = createServer((request, response) => {
  const filePath = request.url === '/bundle.js' ? bundlePath : htmlPath;
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : 'text/html');
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Identity-axis proof: http://127.0.0.1:${port}`);
});
