// Workspace-picture clip render proof (web/PC stack — react-native-web, the
// Tauri desktop shell's renderer and expo web share it). Builds the real
// DesktopWorkspaceRail with esbuild, serves the bundle, and prints the Chrome
// capture command.
//
//   node apps/mobile/scripts/render-workspace-picture-clip-proof.mjs
//   google-chrome --headless=new --no-sandbox \
//     --screenshot=.verification/workspace-picture-clip.png \
//     --window-size=420,260 --force-device-scale-factor=4 http://127.0.0.1:4178
//
// The unistyles shim resolves StyleSheet.create against the real groknight
// theme, so the proof exercises the shipped styles, not copies of them.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const outDir = path.join(repoRoot, '.scratch/workspace-picture-clip-proof');
const bundlePath = path.join(outDir, 'bundle.js');
const htmlPath = path.join(outDir, 'index.html');
const port = Number(process.env.WORKSPACE_PICTURE_PROOF_PORT ?? 4178);

await mkdir(outDir, { recursive: true });

const isFile = (candidate) => existsSync(candidate) && statSync(candidate).isFile();

const resolveSource = (candidate) => {
  for (const ext of ['.ts', '.tsx', '']) {
    if (isFile(candidate + ext)) return candidate + ext;
  }
  for (const ext of ['/index.ts', '/index.tsx']) {
    if (isFile(candidate + ext)) return candidate + ext;
  }
  return candidate;
};

const unistylesShim = `import { groknight } from '${path.join(mobileRoot, 'sources/buzz/groknight')}';
export const StyleSheet = {
  absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  hairlineWidth: 1,
  create: (factory) => (typeof factory === 'function' ? factory({ buzz: groknight }) : factory),
};
export function useUnistyles() {
  return { theme: { buzz: groknight } };
}
`;

// The rail's entrance slide is irrelevant to a still capture, and reanimated's
// web runtime needs a bundler plugin the proof does not run. Render the rail at
// rest instead, so the capture shows the shipped styles with no transform.
const reanimatedShim = `import * as React from 'react';
import { View } from 'react-native';
const AnimatedView = React.forwardRef((props, ref) => React.createElement(View, { ...props, ref }));
export default { View: AnimatedView, createAnimatedComponent: (C) => C };
const identityEasing = (value) => value;
export const Easing = {
  bezier: () => identityEasing,
  poly: () => identityEasing,
  linear: identityEasing,
  ease: identityEasing,
  in: () => identityEasing,
  out: () => identityEasing,
  inOut: () => identityEasing,
};
export const ReduceMotion = { System: 'system' };
export const useAnimatedStyle = (factory) => factory();
export const useReducedMotion = () => true;
export const useSharedValue = (value) => ({ value });
export const withTiming = (value) => value;
export const withRepeat = (value) => value;
export const runOnJS = (fn) => fn;
export const withSequence = (value) => value;
export const FadeInDown = { duration: () => FadeInDown, springify: () => FadeInDown };
`;

await build({
  entryPoints: [path.join(mobileRoot, 'scripts/workspace-picture-clip-proof.tsx')],
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
      name: 'workspace-picture-proof-shims',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^react-native$/ }, () => ({
          path: path.join(mobileRoot, 'node_modules/react-native-web/dist/index.js'),
        }));
        buildApi.onResolve({ filter: /^react-native-unistyles$/ }, () => ({
          path: 'unistyles-shim',
          namespace: 'workspace-picture-proof',
        }));
        buildApi.onResolve({ filter: /^react-native-reanimated$/ }, () => ({
          path: 'reanimated-shim',
          namespace: 'workspace-picture-proof',
        }));
        buildApi.onResolve({ filter: /^expo-haptics$/ }, () => ({
          path: 'haptics-shim',
          namespace: 'workspace-picture-proof',
        }));
        buildApi.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({
          path: 'safe-area-shim',
          namespace: 'workspace-picture-proof',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'workspace-picture-proof' }, (args) => {
          if (args.path === 'unistyles-shim') {
            return { contents: unistylesShim, loader: 'tsx', resolveDir: mobileRoot };
          }
          if (args.path === 'reanimated-shim') {
            return { contents: reanimatedShim, loader: 'tsx', resolveDir: mobileRoot };
          }
          if (args.path === 'haptics-shim') {
            return {
              contents:
                'export const selectionAsync = async () => undefined;\n' +
                'export const impactAsync = async () => undefined;\n' +
                'export const ImpactFeedbackStyle = { Light: 1 };',
              loader: 'ts',
            };
          }
          if (args.path === 'safe-area-shim') {
            return {
              contents: 'export const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });',
              loader: 'ts',
            };
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
  '<!doctype html><html><head><meta charset="utf-8"><title>workspace picture clip proof</title></head><body style="margin:0"><div id="root"></div><script src="bundle.js"></script></body></html>',
);

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];
  const filePath = route === '/bundle.js' ? bundlePath : htmlPath;
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : 'text/html');
  createReadStream(filePath).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Workspace picture clip proof: http://127.0.0.1:${port}`);
});
