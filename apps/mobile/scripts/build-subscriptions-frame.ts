import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webProofShims } from '../sources/test/browserProof.js';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(mobile, '../../evidence/subscriptions');
mkdirSync(output, { recursive: true });
const workflowContract = JSON.stringify(JSON.parse(readFileSync(path.resolve(mobile, '../../docs/workflows/feedback-triage.json'), 'utf8')));
const shims: Record<string, string> = {
  ...webProofShims(mobile),
  'expo-router': `import React from 'react';
    export const useFocusEffect = effect => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => {
      const page = new URLSearchParams(location.search).get('page');
      return {roomId:'room-1',workspaceId:'workspace-1',
        scheduleId:page === 'schedule-workflow' ? 'schedule-workflow' : 'schedule-prompt',
        subscriptionId:page === 'subscription-workflow' || page === 'stop-confirm' ? 'subscription-workflow' : 'subscription-prompt'};
    };
    export const router = {push:()=>undefined,replace:()=>undefined,back:()=>undefined};`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async name => {
    if (name === 'listRoomSchedules') return {schedules: location.search.includes('empty') ? [] : [
      {id:'schedule-prompt',roomId:'room-1',agentId:'agent-1',cadence:{kind:'cron',expression:'0 9 * * 1-5',timeZone:'UTC'},
        message:'Post the morning standup summary for this Room.',nextRunAt:1790000000},
      {id:'schedule-workflow',roomId:'corner-1',agentId:'agent-1',cadence:{kind:'interval',everyMinutes:1440},
        message:'Start the feedback-triage workflow.',workflowSlug:'feedback-triage',
        nextRunAt:1790000000,corner:{id:'corner-1',name:'triage'}}]};
    if (name === 'listRoomSubscriptions') return {subscriptions: location.search.includes('empty') ? [] : [
      {id:'subscription-prompt',roomId:'room-1',agentId:'agent-1',source:'room',event:'joined',
        prompt:'Welcome the new member and share the Room guide.'},
      {id:'subscription-workflow',roomId:'corner-1',agentId:'agent-1',source:'repository',event:'issue.opened',
        repository:'owner/widgets',prompt:'Start the feedback-triage workflow for this issue.',
        workflowSlug:'feedback-triage',corner:{id:'corner-1',name:'triage'}}]};
    if (name === 'readWorkflowDefinition') return {contract:${workflowContract},runs:[]};
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
  entryPoints: [path.join(mobile, 'scripts/subscriptions-frame.tsx')],
  outfile: path.join(output, 'frame.js'), bundle: true, platform: 'browser', jsx: 'automatic',
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
  writeFileSync(path.join(output, 'frame.html'),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}#root{display:flex;flex-direction:column;min-height:100%}</style><div id="root"></div><script src="frame.js"></script>');
  console.log(path.join(output, 'frame.html'));
});
