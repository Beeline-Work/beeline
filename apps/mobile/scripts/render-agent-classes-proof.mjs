import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webProofShims } from '../sources/test/browserProof.ts';

/**
 * Screenshots of the agent profile, Workspace settings and (once it exists)
 * the Agent classes settings page, painted from fixtures in headless Chrome:
 *   node --experimental-strip-types scripts/render-agent-classes-proof.mjs <label>
 * writes .verification/agent-classes/<label>-<page>.png.
 */
const label = process.argv[2] ?? 'after';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(mobile, '../../.verification/agent-classes');
await mkdir(out, { recursive: true });

const W = 'workspace-1';
const agents = [
  ['1'.repeat(64), 'Niglet', 'niglet', 'opus', 'heavy', ['opus', 'claude-code', 'anthropic'], ['fast', 'reviewer'], 'claude-opus-5-5', 20],
  ['2'.repeat(64), 'Sol', 'sol', 'gpt-6.1-sol', 'heavy', ['sol', 'codex', 'openai'], ['reviewer'], 'gpt-6.1-sol', 10],
  ['3'.repeat(64), 'Baby', 'baby', 'claude-fable-5-1', 'god', ['fable', 'claude-code', 'anthropic'], ['vision'], 'claude-fable-5-1', 50],
  ['4'.repeat(64), 'Speedy', 'speedy', 'deepseek-v4-flash', 'light', ['deepseek', 'pi', 'deepseek'], [], 'deepseek-v4-flash', 0.6],
  ['5'.repeat(64), 'Goosy', 'goosy', 'gemma-4-31b-it-fabled', 'light', ['goose', 'openrouter'], [], undefined, undefined],
];
const classesView = {
  workspaceId: W,
  registry: { source: 'https://models.dev/api.json', fetchedAt: 1790719200, modelCount: 4812 },
  agents: agents.map(([agentId, name, handle, model, tier, auto, custom, modelId, cost]) => ({
    agentId,
    name,
    handle,
    model,
    classes: {
      tier,
      unclassified: !modelId,
      source: modelId ? 'price' : 'unlisted',
      ...(modelId ? { modelId, outputCost: cost } : {}),
      provider: modelId ? auto[2] : 'openrouter',
      tags: [
        { tag: tier, kind: 'tier', removable: false },
        ...(modelId ? [] : [{ tag: 'unclassified', kind: 'status', removable: false }]),
        ...(modelId
          ? [
              { tag: auto[0], kind: 'family', removable: false },
              { tag: auto[1], kind: 'harness', removable: false },
              ...(auto[2] !== auto[0] ? [{ tag: auto[2], kind: 'provider', removable: false }] : []),
            ]
          : [
              { tag: auto[0], kind: 'harness', removable: false },
              { tag: auto[1], kind: 'provider', removable: false },
            ]),
        ...custom.map((tag) => ({ tag, kind: 'custom', removable: true })),
      ],
    },
  })),
  overrides: [{ scope: 'family', key: 'grok', tier: 'light' }],
  unclassified: [{ key: 'openrouter/gemma-4-31b-it-fabled', agentNames: ['Goosy'] }],
};
const workspaceView = {
  workspace: { id: W, name: 'Beeline', visibility: 'invite-only', role: 'owner', createdAt: 1, updatedAt: 1 },
  managerSettings: {
    visibility: 'invite-only',
    rooms: [
      { id: '22222222-2222-4222-8222-222222222222', name: 'beeline', visibility: 'public', createdAt: 1 },
      { id: '33333333-3333-4333-8333-333333333333', name: 'launch', visibility: 'invite-only', createdAt: 1 },
    ],
  },
  members: [{ identity: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Alan' } }],
  agents: agents.map(([pubkey, name, handle]) => ({ identity: { pubkey, kind: 'agent', name, handle } })),
  peopleTotal: 5,
  agentTotal: 13,
  membersTruncated: false,
  agentsTruncated: false,
  viewer: {
    identity: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Alan' },
    role: 'owner',
    permissions: { send: true, manage: true },
  },
  watchFilters: [],
};
const chatList = {
  workspace: { id: W, name: 'Beeline', visibility: 'invite-only', role: 'owner', updatedAt: 1 },
  chats: [],
  viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Alan' },
  truncated: false,
  watchFilters: [],
};

const shims = {
  ...webProofShims(mobile),
  'react-native-keyboard-controller': `export { KeyboardAvoidingView, ScrollView as KeyboardAwareScrollView } from 'react-native';`,
  'expo-router': `import React from 'react';
  export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
  export const useLocalSearchParams = () => ({ communityId: '${W}' });
  export const useRouter = () => ({ back: () => undefined, push: () => undefined });
  export const router = { push: () => undefined, replace: () => undefined, back: () => undefined };`,
  '@/sync/transport/monolith-operation': `const view = ${JSON.stringify(classesView)};
  export const monolithPhoneOperation = async (name) =>
    name === 'readWorkspaceAgentClasses' ? view : undefined;
  export const phoneOperationFailureReason = (reason) => String(reason);`,
  '@/sync/transport/room-view-client': `const workspace = ${JSON.stringify(workspaceView)};
  const chats = ${JSON.stringify(chatList)};
  export class RoomViewClient {
    async workspace() { return workspace; }
    async chats() { return chats; }
  }`,
  '@/sync/transport': `export class BuzzRigTransport {
    async ensureClient() { return { surfaceSubscribe: async () => () => undefined }; }
  }`,
  '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
  export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
  '@/buzz/avatar-upload': 'export const pickAndUploadAvatar = async () => undefined;',
  '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({ monolithUrl: 'https://relay.test' });`,
  '@/modal': 'export const Modal = { alert: () => undefined, confirm: async () => false };',
  '@react-native-async-storage/async-storage':
    'export default { getItem: async () => null, setItem: async () => undefined };',
  'expo-font': 'export const isLoaded = () => true; export const loadAsync = async () => {};',
  '@/utils/responsive': 'export const useIsDesktop = () => false;',
};

const entries = ['agent-classes-proof.tsx', 'agent-classes-settings-proof.tsx'].filter((file) =>
  existsSync(path.join(mobile, 'scripts', file)),
);
let fonts = '';
for (const font of [
  'SpaceGrotesk-Regular',
  'SpaceGrotesk-Medium',
  'SpaceGrotesk-SemiBold',
  'IBMPlexSans-Regular',
  'IBMPlexSans-SemiBold',
  'IBMPlexMono-Regular',
]) {
  const file = path.join(mobile, 'sources/assets/fonts', font + '.ttf');
  if (!existsSync(file)) continue;
  const bytes = await readFile(file);
  fonts += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${bytes.toString('base64')})}`;
}
const icons = await readFile(
  path.join(mobile, 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf'),
);
fonts += `@font-face{font-family:ionicons;src:url(data:font/ttf;base64,${icons.toString('base64')})}`;

const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-classes-proof-'));
try {
  for (const entry of entries) {
    const name = entry.replace(/\.tsx$/, '');
    await build({
      entryPoints: [path.join(mobile, 'scripts', entry)],
      outfile: path.join(temp, `${name}.js`),
      bundle: true,
      platform: 'browser',
      jsx: 'automatic',
      mainFields: ['browser', 'module', 'main'],
      resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
      loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
      logLevel: 'error',
      plugins: [
        {
          name: 'agent-classes-native-web-proof',
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
    // Inlined so a thrown error reaches the overlay with its message, not "Script error.".
    const bundle = (await readFile(path.join(temp, `${name}.js`), 'utf8')).replace(/<\/script/g, '<\\/script');
    await writeFile(
      path.join(temp, `${name}.html`),
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body{margin:0;background:#14091A}*{box-sizing:border-box}</style><div id="root"></div><script>window.process={env:{NODE_ENV:'development'}};addEventListener('error',(e)=>{const pre=document.createElement('pre');pre.style.color='#F85149';pre.style.whiteSpace='pre-wrap';pre.textContent=String(e.message)+'\\n'+String(e.error&&e.error.stack);document.body.appendChild(pre);});</script><script>${bundle}</script>`,
    );
  }
  const pages = [
    ['agent-classes-proof', 'profile', 1250],
    ['agent-classes-proof', 'workspace', 1100],
    ['agent-classes-settings-proof', 'classes', 2000],
  ].filter(([entry]) => entries.includes(`${entry}.tsx`));
  for (const [entry, page, height] of pages) {
    const png = path.join(out, `${label}-${page}.png`);
    const run = spawnSync(
      process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=390,${height}`,
        `--user-data-dir=${path.join(temp, 'profile')}`,
        '--virtual-time-budget=8000',
        `--screenshot=${png}`,
        `${pathToFileURL(path.join(temp, `${entry}.html`)).href}?page=${page}`,
      ],
      { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TMPDIR: '/var/tmp' } },
    );
    if (run.status !== 0) throw new Error(`${page}: chrome exited ${run.status}\n${run.stderr}`);
    console.log(png);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
