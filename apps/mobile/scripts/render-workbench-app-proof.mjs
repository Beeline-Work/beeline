// Render the real Gmail detail and connect-list screens on react-native-web
// with a fixed failed provider response, then capture both in Chrome.
//
//   node apps/mobile/scripts/render-workbench-app-proof.mjs
//   TMPDIR=/tmp google-chrome --headless=new --no-sandbox --user-data-dir=/tmp/wb-detail \
//     --window-size=420,850 --screenshot=proof/workbench-gmail/detail.png http://127.0.0.1:4180/
//   TMPDIR=/tmp google-chrome --headless=new --no-sandbox --user-data-dir=/tmp/wb-list \
//     --window-size=420,850 --screenshot=proof/workbench-gmail/list.png http://127.0.0.1:4180/?page=list
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const outDir = path.join(repoRoot, '.scratch/workbench-app-proof');
const bundlePath = path.join(outDir, 'bundle.js');
const htmlPath = path.join(outDir, 'index.html');
const port = 4180;

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

const unistylesShim = `import { beelineThemes } from '${path.join(mobileRoot, 'sources/buzz/groknight')}';
const theme = { buzz: beelineThemes.obsidian };
export const StyleSheet = {
  absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  hairlineWidth: 1,
  create: (factory) => (typeof factory === 'function' ? factory(theme) : factory),
};
export function useUnistyles() {
  return { theme };
}
`;

const reanimatedShim = `import * as React from 'react';
import { View } from 'react-native';
const AnimatedView = React.forwardRef((props, ref) => React.createElement(View, { ...props, ref }));
export default { View: AnimatedView, Text: (props) => React.createElement('span', props), createAnimatedComponent: (C) => C };
const identity = (value) => value;
export const Easing = new Proxy({}, { get: () => (...args) => (typeof args[0] === 'function' ? args[0] : identity) });
export const ReduceMotion = { System: 'system' };
export const FadeInDown = new Proxy({}, { get: () => () => FadeInDown });
export const useAnimatedStyle = (factory) => factory();
export const useReducedMotion = () => true;
export const useSharedValue = (value) => ({ value });
export const withTiming = identity;
export const withRepeat = identity;
export const withSequence = (...values) => values[0];
export const withDelay = (_, value) => value;
export const runOnJS = (fn) => fn;
export const interpolate = identity;
export const cancelAnimation = () => undefined;
export const useAnimatedProps = (factory) => factory();
`;

await build({
  entryPoints: [path.join(mobileRoot, 'scripts/workbench-app-proof.tsx')],
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
  loader: { '.png': 'dataurl' },
  sourcemap: false,
  plugins: [
    {
      name: 'workbench-keys-proof-shims',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^expo-router$/ }, () => ({ path: 'router-shim', namespace: 'workbench-keys-proof' }));
        buildApi.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: 'safe-area-shim', namespace: 'workbench-keys-proof' }));
        buildApi.onResolve({ filter: /^@\/buzz\/workbench-source$/ }, () => ({ path: 'source-shim', namespace: 'workbench-keys-proof' }));
        buildApi.onResolve({ filter: /^@\/buzz\/app-sign-in$/ }, () => ({ path: 'signin-shim', namespace: 'workbench-keys-proof' }));
        buildApi.onResolve({ filter: /^react-native$/ }, () => ({
          path: path.join(mobileRoot, 'node_modules/react-native-web/dist/index.js'),
        }));
        buildApi.onResolve({ filter: /^react-native-svg$/ }, () => ({
          path: path.join(
            mobileRoot,
            'node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js',
          ),
        }));
        buildApi.onResolve({ filter: /^react-native-unistyles$/ }, () => ({
          path: 'unistyles-shim',
          namespace: 'workbench-keys-proof',
        }));
        buildApi.onResolve({ filter: /^react-native-reanimated$/ }, () => ({
          path: 'reanimated-shim',
          namespace: 'workbench-keys-proof',
        }));
        buildApi.onResolve({ filter: /^expo-haptics$/ }, () => ({
          path: 'haptics-shim',
          namespace: 'workbench-keys-proof',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'workbench-keys-proof' }, (args) => {
          if (args.path === 'router-shim') return { contents: `import React from 'react'; export const router={back() {},push() {}}; export const useLocalSearchParams=()=>({workspaceId:'proof',viewerId:'proof',appId:'gmail-proof'}); export const useFocusEffect=(fn)=>React.useEffect(fn,[]);`, loader: 'tsx', resolveDir: mobileRoot };
          if (args.path === 'safe-area-shim') return { contents: `export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`, loader: 'ts' };
          if (args.path === 'signin-shim') return { contents: `export const openAppSignIn=async()=>{};`, loader: 'ts' };
          if (args.path === 'source-shim') return { contents: `const app={id:'gmail-proof',key:'gmail',name:'Gmail',transport:'composio',status:'error',errorMessage:'App provider request failed (403) at POST /auth_configs',description:'Read and send Gmail messages.',accountLabel:'owner',workspaceName:'Workspace',useCount:0}; const view={apps:[app],appCatalog:[{appKey:'gmail',description:app.description}],helpers:[{id:'helper',name:'Helper',online:true}],connectors:[],connections:[]}; export const getWorkbenchSource=()=>({readWorkbench:async()=>view,beginAppSignIn:async()=>{throw new Error(app.errorMessage)},disconnectApp:async()=>{view.apps=[]},connectApp:async()=>({appId:app.id})});`, loader: 'ts' };
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
  '<!doctype html><html><head><meta charset="utf-8"><title>workbench app proof</title>' +
    '<style>html,body{margin:0;height:100%;background:#14091A}#root{height:100vh}</style>' +
    '</head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
);

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];
  const filePath = route === '/bundle.js' ? bundlePath : htmlPath;
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : 'text/html');
  createReadStream(filePath).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Workbench app proof: http://127.0.0.1:${port}`);
});
