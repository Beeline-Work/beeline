import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webProofShims } from '../sources/test/browserProof.js';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(mobile, '../../evidence/subscriptions');
mkdirSync(output, { recursive: true });
const shims: Record<string, string> = {
  ...webProofShims(mobile),
  'expo-router': `import React from 'react';
    export const useFocusEffect = effect => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({roomId:'room-1',workspaceId:'workspace-1'});
    export const router = {push:()=>undefined,replace:()=>undefined,back:()=>undefined};`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async name => {
    if (name === 'listRoomSchedules') return {schedules: location.search.includes('empty') ? [] : [
      {id:'daily',agentId:'agent-1',cadence:{kind:'cron',expression:'0 8 * * *',timeZone:'UTC'},
        message:'Post the morning standup summary',nextRunAt:1790000000},
      {id:'hourly',agentId:'agent-1',cadence:{kind:'interval',everyMinutes:60},
        message:'Start the feedback triage workflow',workflowSlug:'feedback-triage',
        nextRunAt:1790000000,corner:{id:'corner-1',name:'quiet amber corner'}}]};
    if (name === 'listRoomSubscriptions') return {subscriptions: location.search.includes('empty') ? [] : [
      {id:'repo-1',roomId:'room-1',agentId:'agent-1',source:'repository',event:'issue.opened',
        repository:'owner/widgets',lastFiredAt:1790000000},
      {id:'room-1',roomId:'room-1',agentId:'agent-1',source:'room',event:'joined'}]};
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
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#131515}</style><div id="root"></div><script src="frame.js"></script>');
  console.log(path.join(output, 'frame.html'));
});
