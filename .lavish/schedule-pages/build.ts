import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webProofShims } from '../../apps/mobile/sources/test/browserProof.js';

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, '../..');
const mobile = path.join(root, 'apps/mobile');
mkdirSync(output, { recursive: true });
const fontFaces = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold',
  'IBMPlexMono-Regular', 'IBMPlexMono-Italic', 'IBMPlexMono-SemiBold']
  .map((name) => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`)
  .join('');
const workflowContract = JSON.stringify(JSON.parse(readFileSync(path.join(root, 'docs/workflows/feedback-triage.json'), 'utf8')));
const shims: Record<string, string> = {
  ...webProofShims(mobile),
  'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: beelineThemes.obsidian };
    export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });`,
  'expo-router': `import React from 'react';
    export const useFocusEffect = effect => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({roomId:location.search.includes('page=workflow')?'corner-1':'room-1',
      name:'feedback-triage',parentRoomId:'room-1',scheduleId:'schedule-workflow'});
    export const router = {push:href=>{
      if (href.pathname !== '/beeline/workflow') return;
      const next = new URL(location.href); next.searchParams.set('page','workflow'); location.href = next.href;
    },replace:()=>undefined,back:()=>history.back()};`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async name => {
    if (name === 'listRoomSchedules') return {schedules:[
      {id:'schedule-workflow',roomId:'corner-1',agentId:'agent-ruby',
        cadence:{kind:'cron',expression:'0 10 * * *',timeZone:'America/New_York'},
        message:'Start the feedback-triage workflow.',workflowSlug:'feedback-triage',
        nextRunAt:1791813600,corner:{id:'corner-1',name:'issues-triage'}}]};
    if (name === 'listRoomSubscriptions') return {subscriptions:[]};
    if (name === 'readWorkflowDefinition') return {contract:${workflowContract},runs:[]};
    return {};
  };`,
  '@/sync/transport/room-view-client': `export class RoomViewClient {async room() {return {
    room:{name:'beeline'},viewer:{permissions:{manage:true}},
    members:[{identity:{kind:'agent',pubkey:'agent-ruby',name:'Ruby'}}]};}}`,
  '@expo/vector-icons': `import React from 'react';
    export const Ionicons = props => React.createElement('span', {'data-icon':props.name});`,
  '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({publicKey:'${'a'.repeat(64)}'});`,
};

void build({
  entryPoints: [path.join(output, 'frame.tsx')], outfile: path.join(output, 'frame.js'),
  bundle: true, platform: 'browser', jsx: 'automatic', mainFields: ['browser', 'module', 'main'],
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
  loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true', global: 'globalThis' },
  plugins: [{ name: 'preview-shims', setup(api) {
    api.onResolve({ filter: /.*/ }, ({ path: requested }) => {
      if (requested in shims) return { path: requested, namespace: 'shim' };
      if (requested === 'react' || requested.startsWith('react/'))
        return { path: path.join(mobile, 'node_modules', requested === 'react' ? 'react/index.js' : `${requested}.js`) };
      if (requested === 'react-dom' || requested.startsWith('react-dom/'))
        return { path: path.join(mobile, 'node_modules', requested === 'react-dom' ? 'react-dom/index.js' : `${requested}.js`) };
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
writeFileSync(path.join(output, 'frame.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fontFaces}
html,body{margin:0;height:100%;font-family:SpaceGrotesk-Regular}#root{display:flex;flex-direction:column;min-height:100%}
</style></head><body><div id="root"></div><script src="frame.js"></script></body></html>`);
console.log(path.join(output, 'frame.html'));
});
