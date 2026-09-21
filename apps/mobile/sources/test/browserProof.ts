import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';

/**
 * Shims every web proof needs: the pieces of the app that talk to a device
 * rather than to the page. Anything a proof is actually measuring stays real.
 */
export function webProofShims(mobile: string): Record<string, string> {
  return {
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: beelineThemes.obsidian };
    export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });`,
    'expo-clipboard': 'export const setStringAsync = async () => true;',
    'expo-haptics': `export const selectionAsync = async () => undefined;
    export const impactAsync = async () => undefined;
    export const ImpactFeedbackStyle = { Light: 'light' };`,
    'react-native-keyboard-controller': `export { KeyboardAvoidingView } from 'react-native';`,
    'react-native-safe-area-context':
      'export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });',
    'react-native-device-info': `export const getDeviceType = () => 'Desktop';`,
    'react-native-reanimated': `import { Animated } from 'react-native';
    const identity = value => value;
    export const Easing = new Proxy({}, { get: () => (...args) => (typeof args[0] === 'function' ? args[0] : identity) });
    const entering = new Proxy({}, { get: () => () => entering });
    export const FadeInDown = entering;
    export const ReduceMotion = { System: 'system' };
    export const useReducedMotion = () => true;
    export const useAnimatedStyle = factory => factory();
    export const useSharedValue = value => ({ value });
    export const withRepeat = identity; export const withSequence = (...v) => v[0];
    export const withTiming = identity; export const withDelay = (_, value) => value;
    export const cancelAnimation = () => undefined;
    export const runOnJS = fn => fn; export const runOnUI = fn => fn;
    export const useAnimatedProps = factory => factory();
    export const useDerivedValue = factory => ({ value: factory() });
    export const interpolate = identity;
    export default { View: Animated.View, Text: Animated.Text, createAnimatedComponent: c => c };`,
  };
}

/**
 * Builds a proof entry the way Metro builds the web bundle — `.web.*` wins,
 * and react-native-svg's web build is what turns a mark's props into DOM
 * attributes — then loads it in headless Chrome and returns what the page
 * wrote into `#result`. Console errors and warnings reach the page as
 * `window.__console` so a proof can assert on them.
 */
export async function runBrowserProof(options: {
  entry: string;
  mobile: string;
  shims: Record<string, string>;
  width: number;
  height?: number;
  query?: string;
}): Promise<{ result: string; status: number | null; stderr: string }> {
  const { entry, mobile, shims, width, height = 900, query = '' } = options;
  const directory = await mkdtemp(path.join(tmpdir(), 'browser-proof-'));
  try {
    await build({
      entryPoints: [entry],
      outfile: path.join(directory, 'bundle.js'),
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      mainFields: ['browser', 'module', 'main'],
      resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
      loader: { '.js': 'jsx' },
      define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
      plugins: [
        {
          name: 'native-web-proof',
          setup(api) {
            api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
              if (requested in shims) return { path: requested, namespace: 'shim' };
              if (requested === 'react-native')
                return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
              if (requested.startsWith('@/')) {
                const candidate = path.join(mobile, 'sources', requested.slice(2));
                return {
                  path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                    .map((extension) => candidate + extension)
                    .find(existsSync)!,
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
    const html = path.join(directory, 'index.html');
    await writeFile(
      html,
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>
<div id="root"></div><pre id="result">PENDING</pre>
<script>window.__console=[];for(const level of ['error','warn']){const base=console[level].bind(console);console[level]=(...a)=>{window.__console.push(level+': '+a.map(String).join(' '));base(...a);};}</script>
<script src="bundle.js"></script>`,
    );
    const browser = spawnSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--window-size=${width},${height}`,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--dump-dom',
        '--virtual-time-budget=6000',
        `${pathToFileURL(html).href}${query}`,
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        // Chrome builds its singleton socket under TMPDIR and dies when that
        // path is long, which says nothing about the surface under proof.
        env: { ...process.env, TMPDIR: '/tmp' },
      },
    );
    if (browser.error) throw browser.error;
    const match = browser.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);
    const result = (match?.[1] ?? browser.stdout)
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return { result, status: browser.status, stderr: browser.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
