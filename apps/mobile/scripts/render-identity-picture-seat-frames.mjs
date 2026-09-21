// Phone-width before/after frames of the Settings identity tile wearing a
// loud square photo (person photos stay darkflighted in the product, so the
// generated mark cannot prove the seat).
//
//   node apps/mobile/scripts/render-identity-picture-seat-frames.mjs
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const outDir = path.join(repoRoot, '.verification/identity-avatar-seat');
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';

const shims = {
  'react-native-unistyles': `import { beelineThemes } from '${path.join(mobileRoot, 'sources/buzz/groknight')}';
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
  'expo-router': `import React from 'react';
    export const router = { back: () => undefined, push: () => undefined, replace: () => undefined };
    export const useLocalSearchParams = () => ({});
    export const useRouter = () => ({ back: () => undefined, push: () => undefined });`,
  'expo-updates': `export const isEnabled = false;
    export const channel = null; export const updateId = null;
    export const checkForUpdateAsync = async () => ({ isAvailable: false });
    export const fetchUpdateAsync = async () => ({ isNew: false });
    export const reloadAsync = async () => undefined;`,
  '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) });
    export const clearBuzzIdentity = async () => undefined;`,
  '@/auth/github-auth-session': `export const clearPendingGitHubSignInState = async () => undefined;`,
  '@/auth/monolith-session': `export const monolithSession = { signOut: async () => undefined };`,
  '@/buzz/community-storage': `export const loadActiveCommunityId = async () => null;`,
  '@/buzz/person-name': `export const ensurePersonNameForWorkspace = async () => ({ name: 'Captain' });
    export const loadPreferredPersonName = async () => 'Captain';
    export const savePreferredPersonName = async () => undefined;`,
  '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({ monolithEnabled: true, relayUrl: 'https://relay.test' });`,
  '@/buzz/workbench': `export const connectionsForViewer = () => [];`,
  '@/buzz/workbench-source': `export const getWorkbenchSource = () => ({ readWorkbench: async () => ({ connections: [] }) });`,
  '@/buzz/surface-storage': `export const clearMobileSurfaceStorage = async () => undefined;`,
  '@/buzz/room-open-trace': `export const roomOpenTraceEnabled = () => false;`,
  '@/sync/appConfig': `export const loadAppConfig = () => ({ releaseVersion: 'development', releaseSha: null });`,
  '@/sync/storage': `export const useLocalSettingMutable = (name) => [name === 'appearance' ? 'dark' : 'medium', () => undefined];`,
  '@/unistyles': `export const applyAppearanceChoice = () => undefined; export const setAppDisplay = () => undefined;`,
  '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() {
        return {
          surfaceSubscribe: async () => () => undefined,
          getGlobalPersonProfile: async () => ({ name: 'Captain', handle: 'captain' }),
        };
      }
    }`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async (name) => {
      if (name === 'getManagedIdentity') return { face: 'fox', pushLevel: 'mine', handle: 'captain', name: 'Captain' };
      return undefined;
    };`,
  '@/sync/transport/room-view-client': `export class RoomViewClient { async workspaces() { return { workspaces: [] }; } }`,
  '@/push/buzz-push-registration': `export const getBuzzPushEnabled = async () => true;
    export const getBuzzPushRegistrationState = async () => ({ registered: true, phase: 'ready' });
    export const registerBuzzPushNotifications = async () => ({ registered: true });
    export const setBuzzPushEnabled = async () => ({ registered: true });`,
  '@/push/buzz-push-status': `export const buzzPushPhaseDetail = () => null; export const pushSwitchValue = () => true;`,
  '@/push/push-level-storage': `export const saveStoredPushLevel = async () => undefined;`,
  '@/push/presented-notifications': `export const reconcilePresentedNotificationBadge = async () => undefined;`,
  '@/sync/pushRegistration': `export const getPushPermissionInfo = async () => ({ status: 'granted', granted: true, canAskAgain: true });`,
  '@/text': `export const t = (key) => ({
      'settings.privacyPolicy': 'Privacy policy',
      'settings.termsOfService': 'Terms of service',
    }[key] ?? key);`,
  '@/utils/open-external-url': `export const openExternalUrl = async () => undefined;`,
  '@/components/buzz/FacePickerSheet': `export const FacePickerSheet = () => null;`,
  '@/components/buzz/PushLevelSetting': `export const PushLevelSetting = () => null;`,
  '@/components/buzz/AppearanceSetting': `export const AppearanceSetting = () => null;`,
  '@/components/buzz/UiSizeSetting': `export const UiSizeSetting = () => null;`,
  '@/components/buzz/SettingsRow': `import React from 'react';
    export const SettingsRow = (props) => React.createElement('div', {
      'data-testid': props.testID,
      style: { padding: '14px 16px', color: '#e8e2d6', fontSize: 16, borderBottom: '1px solid #2a2433' },
    }, props.title);`,
  '@/components/buzz/MonoHull': `import React from 'react';
    export const HullSurface = ({ children, style }) => React.createElement('div', { style }, children);
    export const PixelGateReveal = ({ children }) => React.createElement(React.Fragment, null, children);
    export const PixelLoader = () => null; export const MonoButton = () => null;`,
  '@/components/buzz/IdentityMark': `import React from 'react';
    const PICTURE = ${JSON.stringify(
      'data:image/svg+xml;base64,' +
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
            '<rect width="96" height="96" fill="#ffffff"/>' +
            '<rect x="0" y="0" width="28" height="28" fill="#000000"/>' +
            '<rect x="68" y="0" width="28" height="28" fill="#000000"/>' +
            '<rect x="0" y="68" width="28" height="28" fill="#000000"/>' +
            '<rect x="68" y="68" width="28" height="28" fill="#000000"/>' +
            '</svg>',
        ).toString('base64'),
    )};
    export const IdentityMark = (props) => React.createElement('img', {
      'data-testid': props.testID, src: PICTURE, width: props.size, height: props.size,
      style: { width: props.size, height: props.size, display: 'block' },
    });`,
};

mkdirSync(outDir, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'identity-seat-frames-'));
try {
  await build({
    entryPoints: [path.join(mobileRoot, 'scripts/identity-picture-seat-frames.tsx')],
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
              return { path: path.join(mobileRoot, 'node_modules/react-native-web/dist/index.js') };
            if (requested.startsWith('@/')) {
              const candidate = path.join(mobileRoot, 'sources', requested.slice(2));
              return {
                path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
                  .map((extension) => candidate + extension)
                  .find((entry) => existsSync(entry) && statSync(entry).isFile()),
              };
            }
          });
          api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
            contents: shims[requested],
            loader: 'tsx',
            resolveDir: mobileRoot,
          }));
        },
      },
    ],
  });
  const html = path.join(directory, 'index.html');
  await writeFile(
    html,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#14091A}</style>
<div id="root"></div><script src="bundle.js"></script>`,
  );

  const capture = (mode, dest) => {
    const result = spawnSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=390,844',
        '--force-device-scale-factor=2',
        `--user-data-dir=${path.join(directory, `profile-${mode}`)}`,
        `--screenshot=${dest}`,
        '--virtual-time-budget=4000',
        `${pathToFileURL(html).href}?mode=${mode}`,
      ],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMPDIR: '/tmp' } },
    );
    if (result.status !== 0) {
      throw new Error(`chrome ${mode}: ${result.stderr || result.stdout || result.status}`);
    }
    console.log(`wrote ${dest}`);
  };

  capture('before', path.join(outDir, 'before.png'));
  capture('after', path.join(outDir, 'after.png'));
} finally {
  await rm(directory, { recursive: true, force: true });
}
