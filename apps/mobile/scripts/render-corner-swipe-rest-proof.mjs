import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webProofShims } from '../sources/test/browserProof.ts';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(mobile, '../../.verification/corner-swipe-rest/' + (process.env.PROOF_PHASE || 'after'));
await mkdir(out, { recursive: true });
const shims = webProofShims(mobile);
shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
  'beelineThemes.obsidian',
  "beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian']",
);
shims['@react-native-async-storage/async-storage'] =
  'export default { getItem: async key => localStorage.getItem(key), setItem: async (key,value) => localStorage.setItem(key,value) };';
shims['expo-font'] = 'export const isLoaded = () => true; export const loadAsync = async () => {};';
shims['react-native-keyboard-controller'] = `export { KeyboardAvoidingView, View as KeyboardProvider } from 'react-native'; export const useKeyboardState = selector => selector({ height: 0, isVisible: false });`;
shims['@/utils/responsive'] = 'export const useIsDesktop = () => innerWidth >= 768;';
shims['react-native-reanimated'] += `export const FadeOutDown = new Proxy({}, {get: () => () => FadeOutDown}); export const FadeOut = new Proxy({}, {get: () => () => FadeOut}); export const interpolateColor = (_, __, colors) => colors[0];`;
shims['react-native-safe-area-context'] = `import React from 'react'; import {View} from 'react-native'; export const useSafeAreaInsets = () => ({top:0,bottom:0,left:0,right:0}); export const SafeAreaProvider = ({children}) => children; export const SafeAreaInsetsContext = React.createContext({top:0,bottom:0,left:0,right:0}); export const initialWindowMetrics = null;`;
shims['react-native-unistyles'] += `export const UnistylesRuntime = {themeName:'bone',setTheme:()=>{}};`;
shims['react-native-view-shot'] = `export const captureRef = async () => ''; export default () => null;`;
shims['expo-router'] = `export const router = {push:()=>{},back:()=>{}}; export const useRouter = () => router; export const usePathname = () => '/proof'; export const useLocalSearchParams = () => ({});`;
await build({
  entryPoints: [path.join(mobile, 'scripts/corner-swipe-rest-web-proof.tsx')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'browser',
  jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
  define: { global: 'globalThis', 'process.env': '{}', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  plugins: [
    {
      name: 'corner-swipe-rest-web-proof',
      setup(api) {
        if (process.env.PROOF_PHASE === 'before') api.onLoad({ filter: /RoomMessageVariants\.tsx$/ }, ({ path: file }) => {
          if (!file.endsWith('/RoomMessageVariants.tsx')) return;
          const relative = path.relative(path.resolve(mobile, '../..'), file);
          return { contents: execFileSync('git', ['show', 'HEAD:' + relative], { encoding: 'utf8' }), loader: 'tsx', resolveDir: path.dirname(file) };
        });
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
let fonts = '';
for (const font of [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexSans-Regular',
  'IBMPlexSans-SemiBold',
]) {
  const bytes = await readFile(path.join(mobile, 'sources/assets/fonts', font + '.ttf'));
  fonts += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${bytes.toString('base64')})}`;
}
const icons = await readFile(
  path.join(
    mobile,
    'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf',
  ),
);
fonts += `@font-face{font-family:ionicons;src:url(data:font/ttf;base64,${icons.toString('base64')})}`;
await writeFile(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{margin:0;height:100%}*{box-sizing:border-box}</style><div id="root"></div><script src="bundle.js"></script>`,
);
console.log(out);
