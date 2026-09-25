import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const outDir = path.join(repoRoot, '.scratch/consolidated-board-proof');
const bundlePath = path.join(outDir, 'bundle.js');
const htmlPath = path.join(outDir, 'index.html');
const port = Number(process.env.CONSOLIDATED_PROOF_PORT ?? 4179);

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
const groknight = beelineThemes[new URLSearchParams(location.search).get('theme') === 'light' ? 'bone' : 'obsidian'];
export const StyleSheet = {
  absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  hairlineWidth: 1,
  create: (factory) => (typeof factory === 'function' ? factory({ buzz: groknight, colors: { text: groknight.textPrimary } }) : factory),
};
export function useUnistyles() {
  return { theme: { buzz: groknight, colors: { text: groknight.textPrimary } } };
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
export const useAnimatedProps = (factory) => factory();
export const cancelAnimation = () => undefined;
export const withDelay = (_, value) => value;
export const useReducedMotion = () => true;
export const useSharedValue = (value) => ({ value });
export const withTiming = (value) => value;
export const withRepeat = (value) => value;
export const runOnJS = (fn) => fn;
export const withSequence = (value) => value;
export const FadeInDown = { duration: () => FadeInDown, springify: () => FadeInDown };
`;

// Only the transport and native host adapters are fixtures; profile and management render production components.
const fixtureMocks = {
  'expo-router': `export const router = { back() {}, push() {}, replace() {} }; export const useNavigation = () => ({addListener:()=>()=>{},dispatch(){}}); export const useLocalSearchParams = () => ({communityId: globalThis.__boardFixture.workspace.workspace.id});`,
  'react-native-keyboard-controller': `export { ScrollView as KeyboardAwareScrollView, KeyboardAvoidingView } from 'react-native';`,
  '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => globalThis.__boardFixture.identity; export const getEffectiveRelayUrl = async () => 'https://fixture.invalid';`,
  '@/buzz/surface-storage': `export const surfaceAddress = () => ({}); export const mobileSurfaceCache = {read:async()=>null,write:async()=>{}};`,
  '@/sync/transport/room-view-client': `export class RoomViewClient { workspace = async () => globalThis.__boardFixture.workspace; agent = async () => globalThis.__boardFixture.agent; workspaceMembers = async () => globalThis.__boardFixture.workspace; }`,
  '@/sync/transport': `export class BuzzRigTransport { ensureClient = async () => ({surfaceSubscribe:async()=>()=>{}}); resolveDirectMessage = async () => ({channelId:'fixture-dm'}); }`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => { throw Error('Visual proof: writes disabled'); };`,
  '@/buzz/community-invite': `export const createCommunityInviteUrl = async () => ''; export const resolveCommunityInvitePublicOrigin = () => '';`,
  '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({});`,
  '@/buzz/corner-navigation': `export const navigateToRoom = () => {};`,
  '@/components/buzz/MemberPickerSheet': `export const MemberPickerSheet = () => null;`,
  '@/modal/ModalManager': `export const Modal = { confirm:async()=>false, prompt:async()=>null };`,
  '@beeline/buzz-client': `export * from '${path.join(repoRoot, 'packages/buzz-client/src/index.ts')}'; export class SurfaceRefreshScheduler { constructor(options){ this.options=options; } async startAfter(wait){ await wait; this.options.apply(await this.options.fetch()); } force(){} signal(){} dispose(){} }`,
};

await build({
  entryPoints: [path.join(mobileRoot, 'scripts/consolidated-board-proof.tsx')],
  bundle: true,
  banner: { js: 'globalThis.process = { env: { NODE_ENV: "production" } };' },
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
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
    '.json',
  ],
  format: 'iife',
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
  sourcemap: false,
  plugins: [
    {
      name: 'workspace-picture-proof-shims',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(fixtureMocks, args.path)
            ? { path: args.path, namespace: 'board-fixture' }
            : undefined,
        );
        buildApi.onLoad({ filter: /.*/, namespace: 'board-fixture' }, (args) => ({
          contents: fixtureMocks[args.path],
          loader: 'tsx',
          resolveDir: mobileRoot,
        }));

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
              contents:
                'export const useSafeAreaInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });',
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
  '<!doctype html><html><head><meta charset="utf-8"><title>Consolidated board component proof</title></head><body style="margin:0"><div id="root"></div><script src="bundle.js"></script></body></html>',
);

const server = createServer((request, response) => {
  const route = (request.url ?? '').split('?')[0];
  const filePath = route === '/bundle.js' ? bundlePath : htmlPath;
  response.setHeader('Content-Type', filePath.endsWith('.js') ? 'text/javascript' : 'text/html');
  createReadStream(filePath).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Consolidated board component proof: http://127.0.0.1:${port}`);
});
