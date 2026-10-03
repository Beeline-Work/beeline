import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { CHROME, webProofShims } from './browserProof';

/**
 * Captures `scripts/design-proof.tsx` in Obsidian and Bone, one PNG per page
 * and theme, for the design-inconsistency evidence (PR #2044). It writes
 * files, so it runs only when asked:
 *
 *   DESIGN_PROOF_OUT=../../docs/evidence/design-inconsistencies \
 *     npx vitest run sources/test/design-proof.browser
 */
const out = process.env.DESIGN_PROOF_OUT;
const CHROME_TMP = '/var/tmp';
const label = process.env.DESIGN_PROOF_LABEL ?? 'after';

const PAGES: { page: string; width: number; height: number }[] = [
  { page: 'board', width: 1200, height: 1100 },
  { page: 'frames', width: 1200, height: 760 },
  { page: 'workflows', width: 390, height: 640 },
  { page: 'language', width: 390, height: 640 },
  { page: 'text-selection', width: 390, height: 640 },
  { page: 'members', width: 390, height: 640 },
  { page: 'welcome-1', width: 1200, height: 900 },
  { page: 'welcome-2', width: 1200, height: 900 },
  { page: 'welcome-3', width: 1200, height: 900 },
  { page: 'welcome-4', width: 1200, height: 900 },
];

async function fontsCss(mobile: string) {
  let css = '';
  for (const font of ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular', 'IBMPlexMono-SemiBold', 'IBMPlexMono-Italic']) {
    const file = path.join(mobile, 'sources/assets/fonts', `${font}.ttf`);
    if (!existsSync(file)) continue;
    css += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${(await readFile(file)).toString('base64')})}`;
  }
  return css;
}

function shims(mobile: string, theme: 'obsidian' | 'bone'): Record<string, string> {
  const base = webProofShims(mobile);
  return {
    ...base,
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    import * as legacy from '${path.join(mobile, 'sources/theme')}';
    const theme = { ...(legacy.${theme}Theme ?? {}), buzz: beelineThemes.${theme}, dark: beelineThemes.${theme}.dark };
    export const StyleSheet = { create: f => (typeof f === 'function' ? f(theme) : f), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });
    export const UnistylesRuntime = { setTheme() {}, setRootViewBackgroundColor() {} };`,
    'react-native-reanimated': `${base['react-native-reanimated']}
    const builder = new Proxy({}, { get: () => () => builder });
    export const FadeOut = builder; export const FadeIn = builder; export const Layout = builder;
    export const FadeOutDown = builder; export const FadeInUp = builder; export const FadeOutUp = builder;
    export const LinearTransition = builder; export const withSpring = identity;
    export const interpolateColor = (v, i, o) => o[o.length - 1];`,
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ roomId: 'room-1', textId: 'text-1' });
    export const useRouter = () => ({ push() {}, back() {}, replace() {} });
    export const router = { push() {}, back() {}, replace() {} };
    export const usePathname = () => '/';`,
    '@/hooks/useUpdates': `export const useUpdates = () => ({ promptVisible: true, reloadApp: async () => {}, dismissPrompt: () => {} });`,
    '@/sync/persistence': `export const loadLocalSettings = () => ({}); export const saveLocalSettings = () => {};
    export const loadSettings = () => ({ settings: {}, version: null });
    export const retrieveTempText = () => 'Select any part of this message to copy it.\\n\\nThe page header is the shared PageHeader.';`,
    '@/sync/storage': `import React from 'react';
    export const useSettingMutable = () => React.useState(null);
    const state = { settings: {}, localSettings: {} };
    export const storage = Object.assign((select) => select(state), { getState: () => state, subscribe: () => () => undefined });`,
    'expo-localization': `export const getLocales = () => [{ languageCode: 'en' }];`,
    '@/buzz/welcome-cards': `export const completeWelcomeCards = async () => {}; export const readWelcomeCards = async () => ({});`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async room() { return { room: { name: 'app' }, viewer: { permissions: { manage: true } }, repositoryResolution: 'repository', members: [] }; }
    }`,
    '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => ({ defaultBranch: 'main',
      workflows: [{ name: 'Release', lastRunAt: ${Math.floor(Date.UTC(2026, 9, 2) / 1000)}, conclusion: 'success' }, { name: 'Nightly audit' }] });`,
    '@/modal/ModalManager': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
    'react-native-view-shot': `export const captureRef = async () => ''; export default {};`,
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
  };
}

async function shoot(theme: 'obsidian' | 'bone', page: string, width: number, height: number) {
  const mobile = process.cwd();
  // A short temp path Chrome can always reach (a sandboxed Chrome cannot read /tmp).
  const directory = await mkdtemp(path.join(CHROME_TMP, 'design-proof-'));
  try {
    const shimmed = shims(mobile, theme);
    await build({
      entryPoints: [path.join(mobile, 'scripts/design-proof.tsx')],
      outfile: path.join(directory, 'bundle.js'),
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      mainFields: ['browser', 'module', 'main'],
      resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
      loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
      logLevel: 'error',
      plugins: [
        {
          name: 'design-proof',
          setup(api) {
            api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
              if (requested in shimmed) return { path: requested, namespace: 'shim' };
              if (requested === 'react-native')
                return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
              if (requested.startsWith('@/')) {
                const candidate = path.join(mobile, 'sources', requested.slice(2));
                const found = ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                  .map((extension) => candidate + extension)
                  .find((file) => existsSync(file) && statSync(file).isFile());
                if (found) return { path: found };
              }
              return undefined;
            });
            api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
              contents: shimmed[requested],
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
      `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;min-height:100%}${await fontsCss(mobile)}</style><div id="root"></div><pre id="result" style="display:none">PENDING</pre><script>window.process={env:{NODE_ENV:'development'}};</script><script src="bundle.js"></script>`,
    );
    const png = path.join(out!, `${label}-${theme}-${page}.png`);
    const run = spawnSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        `--window-size=${width},${height}`,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--virtual-time-budget=5000',
        '--enable-logging=stderr',
        '--v=0',
        `--screenshot=${png}`,
        `${pathToFileURL(html).href}?page=${page}`,
      ],
      { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TMPDIR: CHROME_TMP } },
    );
    expect(run.error).toBeUndefined();
    const pageErrors = run.stderr.split('\n').filter((line) => /CONSOLE|Uncaught/.test(line));
    if (process.env.DESIGN_PROOF_LOG) console.log(theme, page, pageErrors.join('\n'));
    expect(pageErrors.filter((line) => line.includes('Uncaught')), `${theme} ${page}`).toEqual([]);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(png), `${png} was not written`).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it.skipIf(!out || !existsSync(CHROME))(
  'captures every design-inconsistency surface in Obsidian and Bone',
  async () => {
    await mkdir(out!, { recursive: true });
    for (const theme of ['obsidian', 'bone'] as const) {
      for (const { page, width, height } of PAGES) await shoot(theme, page, width, height);
    }
  },
  900_000,
);
