import { build } from 'esbuild';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { webProofShims } from '../../sources/test/browserProof';
const mobile = process.cwd();
const out = path.join(mobile, 'evidence/joined-agent-bugs/build');
const shims = webProofShims(mobile);
shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', "beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian']");
Object.assign(shims, {
  'expo-router': `export const router={back(){},push(){},replace(){}}; export const useNavigation=()=>({addListener:()=>()=>{},dispatch(){}}); export const useLocalSearchParams=()=>({});`,
  'react-native-keyboard-controller': `export { ScrollView as KeyboardAwareScrollView, KeyboardAvoidingView } from 'react-native'; export const useKeyboardState=selector=>selector({height:0,isVisible:false});`,
  '@/auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:'owner'}); export const getEffectiveRelayUrl=async()=> 'https://fixture.invalid';`,
  '@/buzz/surface-storage': `export const surfaceAddress=(_url,_viewer,route)=>route; export const mobileSurfaceCache={read:async()=>globalThis.__joinedMembersFixture,write:async()=>{},fetch:async()=>globalThis.__joinedMembersFixture};`,
  '@/buzz/use-shared-surface': `export const useSurfaceSnapshot=address=>address && !address.includes('/agents/') ? globalThis.__joinedMembersFixture : null;`,
  '@/buzz/workspace-records': `export const workspaceRecordScope=()=> 'fixture'; export const useWorkspaceRecords=()=>0; export const recordWorkspacePage=()=>{}; export const recordWorkspaceRemoval=()=>{};
    export const workspacePage=()=>({people:{ids:globalThis.__joinedMembersFixture.members.map(m=>m.identity.pubkey),total:2,truncated:false},agents:{ids:globalThis.__joinedMembersFixture.agents.map(m=>m.identity.pubkey),total:4,truncated:false}});
    export const workspaceRows=(_scope,ids)=>[...globalThis.__joinedMembersFixture.members,...globalThis.__joinedMembersFixture.agents].filter(m=>ids.includes(m.identity.pubkey));`,
  '@/buzz/workspace-watch': `export const watchWorkspace=()=>({ready:Promise.resolve(),release(){}});`,
  '@/buzz/use-text-draft': `import {useState} from 'react'; export const useTextDraft=(_context,initial)=>[...useState(initial),{initialize(){},capture:()=>()=>true}];`,
  '@/buzz/latency-route-hook': `export const useLatencyRouteFrame=()=>{};`,
  '@/sync/transport/room-view-client': `export class RoomViewClient {workspace=async()=>globalThis.__joinedMembersFixture;workspaceMembers=async()=>globalThis.__joinedMembersFixture;}`,
  '@/sync/transport': `export class BuzzRigTransport {ensureClient=async()=>({surfaceSubscribe:async()=>()=>{}});}`,
  '@/sync/transport/live-connection': `export const sharedLiveConnection=()=>({register:async()=>()=>{}});`,
  '@/sync/transport/monolith-operation': `export const monolithPhoneOperation=async()=>{throw Error('Visual proof: writes disabled')};`,
  '@/buzz/community-invite': `export const createCommunityInviteUrl=()=>'';export const resolveCommunityInvitePublicOrigin=()=>'';`,
  '@/buzz/runtime-config': `export const getBuzzRuntimeConfig=()=>({});`,
  '@/buzz/corner-navigation': `export const navigateToRoom=()=>{};`,
  '@/components/buzz/PersonInviteSheet': `export const presentPersonInvite=async()=>{};`,
  '@/components/buzz/AgentProfileView': `export const AgentProfileView=()=>null;`,
  '@/components/buzz/AgentUsageSection': `export const USAGE_REFRESH_CLIENT_TIMEOUT_MS=25000;`,
  '@/modal/ModalManager': `export const Modal={confirm:async()=>false,prompt:async()=>null};`,
});
const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(name => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', name+'.ttf')).toString('base64')})}`).join('');

async function main() {
mkdirSync(out, { recursive: true });
for (const phase of ['approval']) {
  await build({ entryPoints: ['evidence/joined-agent-bugs/approval-entry.tsx'], outfile: `${out}/${phase}.js`, bundle: true,
    platform: 'browser', jsx: 'automatic', mainFields: ['browser','module','main'],
    resolveExtensions: ['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],
    loader: { '.js': 'jsx', '.png': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.EXPO_OS': '"web"', __DEV__: 'true', global: 'globalThis' },
    plugins: [{ name: 'proof', setup(api) {
      api.onResolve({filter: /.*/}, ({path: requested}) => {
        if (requested in shims) return {path: requested, namespace: 'shim'};
        if (requested === 'react-native') return {path: path.join(mobile,'node_modules/react-native-web/dist/index.js')};
        if (requested.startsWith('@/')) {
          const base = path.join(mobile, 'sources',requested.slice(2));
          return {path: ['', '.web.ts','.web.tsx','.ts','.tsx','.json','/index.ts','/index.tsx'].map(e => base+e).find(p => existsSync(p) && statSync(p).isFile())!};
        }
      });
      api.onLoad({filter: /.*/,namespace: 'shim'}, ({path: requested}) => ({contents: shims[requested],loader:'tsx',resolveDir:mobile}));
    }}] });
  writeFileSync(`${out}/${phase}.html`, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{margin:0;height:100%;background:#121215}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="${phase}.js"></script>`);
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
