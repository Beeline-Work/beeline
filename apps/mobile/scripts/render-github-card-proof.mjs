import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webProofShims } from '../sources/test/browserProof.ts';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Usage: node scripts/render-github-card-proof.mjs <out-dir>
const out = path.resolve(process.argv[2] ?? path.resolve(mobile, '../../.verification/github-card-return'));
await mkdir(out, { recursive: true });
const shims = webProofShims(mobile);
shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
  'beelineThemes.obsidian',
  "beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian']",
);
shims['react-native-unistyles'] += '\nexport const UnistylesRuntime = { setTheme: () => {} };';
shims['@react-native-async-storage/async-storage'] =
  'export default { getItem: async key => localStorage.getItem(key), setItem: async (key,value) => localStorage.setItem(key,value) };';
shims['@/buzz/onboarding-rollout'] = 'export const useRepositoryOnboarding = () => true;';
shims['@/sync/transport/monolith-operation'] = 'export const monolithPhoneOperation = async () => { throw {code:"github_connection_failed"}; };';
shims['expo-router'] = `export const useLocalSearchParams = () => ({repositoryPicker:new URLSearchParams(location.search).get('repositoryPicker')??undefined,githubConnectionError:new URLSearchParams(location.search).get('githubConnectionError')??undefined}); export const router = {setParams:()=>{const url=new URL(location.href);url.searchParams.delete('githubConnectionError');history.replaceState(null,'',url);}};`;
shims['react-native-reanimated'] += '\nexport const FadeOut = {}; export const interpolateColor = (_, a,b)=>b[1];';
shims['@/auth/auth-session'] = 'export const authSessionOptions = () => ({});';
shims['@/auth/desktop-auth-session'] = 'export const openAccountAuthSession = async () => null; export const subscribeToAuthUrls = () => ({});';
shims['@/auth/github-auth-session'] = 'export const githubInstallationRedirectUri = () => ""; export const runGitHubInstallationSession = async () => null; export const clearPendingGitHubInstallation = async () => {};';
shims['expo-font'] = 'export const isLoaded = () => true; export const loadAsync = async () => {};';
shims['@/utils/responsive'] = 'export const useIsDesktop = () => innerWidth >= 768;';
await build({
  entryPoints: [path.join(mobile, 'scripts/github-card-proof.tsx')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'browser',
  jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  plugins: [
    {
      name: 'github-card-return-proof',
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
