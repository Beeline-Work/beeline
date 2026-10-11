import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webProofShims } from '../sources/test/browserProof.js';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(mobile, '../../evidence/subscriptions');
mkdirSync(output, { recursive: true });
const baseline = process.argv.includes('--main-baseline');
const basename = baseline ? 'main-baseline' : 'frame';
const baselineSource = path.join(mobile, 'scripts/_main-schedules-baseline.tsx');
const baselineEntry = path.join(mobile, 'scripts/_main-baseline-frame.tsx');
const mainSource = (file: string) => execFileSync('git', ['show', `origin/main:${file}`], {
  cwd: path.resolve(mobile, '../..'), encoding: 'utf8',
});
if (baseline) {
  writeFileSync(baselineSource, mainSource('apps/mobile/sources/app/(app)/beeline/settings/schedules.tsx'));
  writeFileSync(baselineEntry, `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport List from './_main-schedules-baseline';\ncreateRoot(document.getElementById('root')!).render(<List />);\n`);
}
const fontFaces = [
  'SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold',
  'IBMPlexMono-Regular', 'IBMPlexMono-Italic', 'IBMPlexMono-SemiBold',
].map((name) => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`).join('');
const workflowContract = JSON.stringify(JSON.parse(readFileSync(path.resolve(mobile, '../../docs/workflows/feedback-triage.json'), 'utf8')));
const shims: Record<string, string> = {
  ...webProofShims(mobile),
  'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: new URLSearchParams(location.search).get('theme') === 'light'
      ? beelineThemes.bone : beelineThemes.obsidian };
    export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });`,
  ...(baseline ? { '@/buzz/scheduled-work': mainSource('apps/mobile/sources/buzz/scheduled-work.ts') } : {}),
  'expo-router': `import React from 'react';
    export const useFocusEffect = effect => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => {
      const query = new URLSearchParams(location.search);
      const page = query.get('page');
      return {roomId:query.get('roomId') ?? 'room-1',workspaceId:'workspace-1',
        name:query.get('name') ?? 'feedback-triage',
        parentRoomId:query.get('parentRoomId') ?? undefined,
        scheduleId:query.get('scheduleId') ?? (page === 'schedule-workflow' ? 'schedule-workflow'
          : page === 'schedule-prompt' ? 'schedule-prompt' : undefined),
        subscriptionId:query.get('subscriptionId') ?? (page === 'subscription-workflow' || page === 'stop-confirm' ? 'subscription-workflow'
          : page === 'subscription-prompt' ? 'subscription-prompt' : undefined)};
    };
    export const router = {push:href=>{
      if (href.pathname !== '/beeline/workflow') return;
      const next = new URL(location.href);
      next.searchParams.set('page','workflow-from-subscription');
      next.searchParams.set('roomId',href.params.roomId);
      next.searchParams.set('name',href.params.name);
      if (href.params.parentRoomId) next.searchParams.set('parentRoomId',href.params.parentRoomId);
      if (href.params.scheduleId) next.searchParams.set('scheduleId',href.params.scheduleId);
      if (href.params.subscriptionId) next.searchParams.set('subscriptionId',href.params.subscriptionId);
      location.href = next.href;
    },replace:()=>undefined,back:()=>undefined};`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async name => {
    if (name === 'listRoomSchedules') return {schedules: location.search.includes('empty') ? [] : [
      {id:'schedule-prompt',roomId:'room-1',agentId:'agent-1',cadence:{kind:'cron',expression:'0 9 * * 1-5',timeZone:'UTC'},
        message:'Post the morning standup summary for this Room.',nextRunAt:1790000000},
      {id:'schedule-workflow',roomId:'corner-1',agentId:'agent-1',cadence:{kind:'interval',everyMinutes:1440},
        message:'Start the feedback-triage workflow.',workflowSlug:'feedback-triage',
        nextRunAt:1780000000,corner:{id:'corner-1',name:'triage'}}]};
    if (name === 'listRoomSubscriptions') return {subscriptions: location.search.includes('empty') ? [] : [
      {id:'subscription-prompt',roomId:'room-1',agentId:'agent-1',source:'room',event:'joined',
        prompt:'Welcome the new member and share the Room guide.'},
      {id:'subscription-workflow',roomId:'corner-1',agentId:'agent-1',source:'repository',event:'issue.opened',
        repository:'owner/widgets',prompt:'Start the feedback-triage workflow for this issue.',
        workflowSlug:'feedback-triage',corner:{id:'corner-1',name:'triage'}}]};
    if (name === 'readWorkflowDefinition') return {contract:${workflowContract},runs:[]};
    if (name === 'readRoomWebhooks') return {sources:[]};
    return {};
  };`,
  '@/sync/transport/room-view-client': `export class RoomViewClient {async room() {return {
    room:{name:'beeline'},viewer:{permissions:{manage:true}},
    members:[{identity:{kind:'agent',pubkey:'agent-1',name:'Worker'}}]};}}`,
  '@expo/vector-icons': `import React from 'react';
    export const Ionicons = props => React.createElement('span', {'data-icon':props.name});`,
  '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({publicKey:'${'a'.repeat(64)}'});`,
};

void build({
  entryPoints: [baseline ? baselineEntry : path.join(mobile, 'scripts/subscriptions-frame.tsx')],
  outfile: path.join(output, `${basename}.js`), bundle: true, platform: 'browser', jsx: 'automatic',
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  plugins: [{ name: 'native-web-frame', setup(api) {
    api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
      if (requested in shims) return { path: requested, namespace: 'shim' };
      if (requested === 'react-native') return { path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') };
      if (requested.startsWith('@/')) {
        const candidate = path.join(mobile, 'sources', requested.slice(2));
        return { path: ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']
          .map((extension) => candidate + extension)
          .find((entry) => existsSync(entry) && statSync(entry).isFile())! };
      }
    });
    api.onLoad({ filter: /.*/, namespace: 'shim' }, ({ path: requested }) => ({
      contents: shims[requested], loader: 'tsx', resolveDir: mobile,
    }));
  } }],
}).then(() => {
  writeFileSync(path.join(output, `${basename}.html`),
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fontFaces}html,body{margin:0;height:100%;font-family:SpaceGrotesk-Regular}#root{display:flex;flex-direction:column;min-height:100%}</style><div id="root"></div><script src="${basename}.js"></script>`);
  console.log(path.join(output, `${basename}.html`));
}).finally(() => {
  if (baseline && existsSync(baselineSource)) unlinkSync(baselineSource);
  if (baseline && existsSync(baselineEntry)) unlinkSync(baselineEntry);
});
