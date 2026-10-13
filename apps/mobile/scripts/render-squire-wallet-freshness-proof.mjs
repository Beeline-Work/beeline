// Render the real Squire, Wallet and key screens against cached/server fixtures.
// Capture using chrome-devtools-axi at 390px; see evidence/squire-wallet-freshness/README.md.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const proofName = 'squire-wallet-freshness-proof';
const outDir = path.join(repoRoot, `.scratch/${proofName}`);
const bundlePath = path.join(outDir, 'bundle.js');
const htmlPath = path.join(outDir, 'index.html');
const port = Number(process.env.WORKBENCH_PROOF_PORT ?? 18487);

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
const theme = { buzz: beelineThemes[new URLSearchParams(window.location.search).get('theme') ?? 'obsidian'] };
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
  entryPoints: [path.join(mobileRoot, 'scripts', `${proofName}.tsx`)],
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', '__DEV__': 'false' },
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
      name: 'workbench-keys-proof-shims',
      setup(buildApi) {
        const shims = {
          'expo-router': `import React from 'react'; export const router={back(){},push(){}};
            export const useLocalSearchParams=()=>({workspaceId:'ws',viewerId:'owner',helperId:'machine-one',service:'trusty-squire',connectionId:'key'});
            export const useFocusEffect=(effect)=>React.useEffect(effect,[effect]);`,
          '@/auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:'owner'}); export const getEffectiveRelayUrl=async()=> 'https://relay.test';`,
          '@/buzz/latency-route-hook': `export const useLatencyRouteFrame=()=>{};`,
          '@/buzz/use-active-community': `export const useActiveCommunityId=()=> 'ws';`,
          '@/buzz/wallet-workspace': `export const resolveWalletWorkspaceId=async()=> 'ws';`,
          '@/buzz/wallet-icons': `export const chainIcon=()=>null; export const tokenIcon=()=>null;`,
          'expo-clipboard': `export const setStringAsync=async()=>{};`,
          'expo-web-browser': `export const openBrowserAsync=async()=>{};`,
          '@/sync/client-reset': `export const subscribeClientReset=()=>()=>{}; export const clientResetGeneration=()=>0; export const resetClientState=()=>{};`,
          '@/sync/transport/live-connection': `export const sharedLiveConnection=()=>({register:async()=>()=>{}});`,
        };
        const fixtureModules = ['@/buzz/surface-storage','@/buzz/wallet-source','@/buzz/workbench-source'];
        buildApi.onResolve({filter: /.*/}, args => {
          if (shims[args.path]) return {path:args.path,namespace:'freshness-fixture'};
          const match = fixtureModules.find(name=>args.path===name || args.path=== './'+name.split('/').at(-1));
          if(match) return {path:match,namespace:'freshness-data'};
        });
        buildApi.onLoad({filter:/.*/,namespace:'freshness-fixture'},args=>({contents:shims[args.path],loader:'tsx',resolveDir:mobileRoot}));
        buildApi.onLoad({filter:/.*/,namespace:'freshness-data'},args=>({contents:
          args.path==='@/buzz/wallet-source' ? 'export const getWalletSource=()=>globalThis.__freshnessSources.wallet;' :
          args.path==='@/buzz/workbench-source' ? 'export const getWorkbenchSource=()=>globalThis.__freshnessSources.workbench;' :
          `export { mobileSurfaceCache, surfaceAddress } from '${path.join(mobileRoot,'scripts/squire-wallet-freshness-fixtures.ts')}';`,loader:'ts',resolveDir:mobileRoot}));
        buildApi.onLoad({filter:/use-shared-surface\.ts$/},async args=> {
          const {readFile}=await import('node:fs/promises');
          const source=await readFile(args.path,'utf8');
          return {contents: source.replace('const resource = useSharedSurface(endpoint, params, guard, request, enabled, true);',
            `const before=new URLSearchParams(window.location.search).get('before')==='1';
             const resource = useSharedSurface(endpoint, params, guard, request, enabled, !before);`)
            .replace('if (address) void refresh();','if (address && !before) void refresh();'),loader:'tsx'};
        });

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
        buildApi.onResolve({ filter: /^react-native-keyboard-controller$/ }, () => ({
          path: 'keyboard-controller-shim',
          namespace: 'workbench-keys-proof',
        }));
        buildApi.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({
          path: 'safe-area-shim',
          namespace: 'workbench-keys-proof',
        }));
        buildApi.onResolve({ filter: /^expo-haptics$/ }, () => ({
          path: 'haptics-shim',
          namespace: 'workbench-keys-proof',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'workbench-keys-proof' }, (args) => {
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
          if (args.path === 'keyboard-controller-shim') {
            return { contents: "import React from 'react'; import {View} from 'react-native'; export const KeyboardProvider = ({children}) => children; export const KeyboardAvoidingView = ({children,...props}) => React.createElement(View,props,children); export const useKeyboardHandler = () => undefined;", loader: 'tsx', resolveDir: mobileRoot };
          }
          if (args.path === 'safe-area-shim') {
            return { contents: 'export const useSafeAreaInsets = () => ({top: 0, right: 0, bottom: 0, left: 0}); export const SafeAreaProvider = ({children}) => children;', loader: 'tsx' };
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
  `<!doctype html><html><head><meta charset="utf-8"><title>${proofName}</title>` +
    '<style>@font-face{font-family:SpaceGrotesk-Regular;src:url(/fonts/SpaceGrotesk-Regular.ttf)}' +
    '@font-face{font-family:SpaceGrotesk-Medium;src:url(/fonts/SpaceGrotesk-Medium.ttf)}' +
    '@font-face{font-family:SpaceGrotesk-SemiBold;src:url(/fonts/SpaceGrotesk-SemiBold.ttf)}' +
    '@font-face{font-family:IBMPlexMono-Regular;src:url(/fonts/IBMPlexMono-Regular.ttf)}' +
    'html,body{margin:0;height:100%;background:#14091A}#root{height:100vh}</style>' +
    '</head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
);

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];
  const fontName = route.startsWith('/fonts/') ? route.slice('/fonts/'.length) : '';
  const fontPath = /^[A-Za-z0-9-]+\.ttf$/.test(fontName)
    ? path.join(mobileRoot, 'sources/assets/fonts', fontName)
    : undefined;
  const filePath = fontPath && isFile(fontPath) ? fontPath : route === '/bundle.js' ? bundlePath : htmlPath;
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : filePath.endsWith('.ttf') ? 'font/ttf' : 'text/html');
  createReadStream(filePath).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`${proofName}: http://127.0.0.1:${port}`);
});
