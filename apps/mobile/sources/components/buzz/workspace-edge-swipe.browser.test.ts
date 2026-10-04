import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('Workspace edge swipe through the page stack', () => {
  it.each(['baseline', 'obsidian', 'bone'])(
    'demonstrates the shared rail (%s)',
    async (mode) => {
      const mobile = process.cwd();
      const shims = webProofShims(mobile);
      shims['@/utils/responsive'] = 'export const useIsDesktop = () => false;';
      shims['expo-status-bar'] = 'export const StatusBar = () => null;';
      shims['@/auth/buzz-identity-storage'] = `
      window.__proofSignedIn = true;
      export const loadBuzzIdentity = async () => window.__proofSignedIn ? ({ publicKey: 'proof-person' }) : null;
      export const getEffectiveRelayUrl = async () => 'proof-server';`;
      shims['@/auth/monolith-session'] = `export const monolithSession = {
        subscribeIdentityChange: listener => { window.__proofIdentityChanged = listener; return () => {}; }
      };`;
      shims['@/buzz/surface-storage'] = `
      export const surfaceAddress = (...args) => args;
      export const mobileSurfaceCache = { read: async () => null, write: async () => undefined };`;
      shims['@/sync/transport/room-view-client'] = `
      export class RoomViewClient { async workspaces() { return {
        viewer: { pubkey: 'proof-person', name: 'Viewer', kind: 'human', face: 'owl' },
        workspaces: [{ id: 'workspace-a', name: 'Night Shift' }, { id: 'workspace-b', name: 'Morning Watch' }]
      }; } }`;
      shims['@react-native-async-storage/async-storage'] = `export default {
      getItem: async key => localStorage.getItem(key),
      setItem: async (key, value) => localStorage.setItem(key, value),
      removeItem: async key => localStorage.removeItem(key)
    };`;
      shims['react-native-unistyles'] = shims['react-native-unistyles']
        .replace('beelineThemes.obsidian', `beelineThemes.${mode === 'bone' ? 'bone' : 'obsidian'}`)
        .replace(
          'const theme = { buzz:',
          'const theme = { dark: true, colors: { surface: "transparent", groupped: { background: "transparent" } }, buzz:',
        );
      // Only the native animation driver is replaced. The drawer, gesture
      // responder, page layout, marks, and selection storage remain real.
      shims['react-native-reanimated'] = `
      import React from 'react'; import { View, Text } from 'react-native';
      const listeners = new Set(); const notify = () => queueMicrotask(() => listeners.forEach(fn => fn()));
      export const useSharedValue = initial => {
        const ref = React.useRef(); if (!ref.current) {
          let value = initial; ref.current = { get value(){return value}, set value(next){value=next;notify()} };
        } return ref.current;
      };
      export const useAnimatedStyle = factory => { const [,render]=React.useReducer(x=>x+1,0);
        React.useEffect(()=>{listeners.add(render);return()=>listeners.delete(render)},[]); return factory(); };
      export const withTiming = (value, config, callback) => { if(callback) setTimeout(()=>callback(true),0); return value; };
      export const Easing = { bezier:()=>undefined, out:x=>x, poly:()=>undefined };
      export const ReduceMotion = { System: 'system' }; export const useReducedMotion = () => true;
      export const runOnJS = fn => fn;
      const entering = new Proxy({}, {get:()=>()=>entering}); export const FadeInDown = entering;
      export const withRepeat = value => value; export const withSequence = (...values) => values[0];
      export default { View, Text, createAnimatedComponent: component => component };`;
      shims['expo-router'] = `
      import React from 'react'; import { View, Text, Pressable } from 'react-native';
      import { BuzzCommunityShell, CommunityDrawerTrigger } from '${path.join(mobile, 'sources/components/buzz/CommunityRail')}';
      let page='conversation', selected='workspace-a'; const listeners=new Set();
      const publish=()=>listeners.forEach(fn=>fn());
      window.__proofNavigate=next=>{page=next;publish()};
      export const router={
        replace: target=>{selected=target.params.communityId;page='rooms';publish()},
        push: target=>{page=target.split('/').at(-1);publish()}
      };
      const useRoute=()=>{const [,render]=React.useReducer(x=>x+1,0);React.useEffect(()=>{listeners.add(render);return()=>listeners.delete(render)},[])};
      export const useGlobalSearchParams=()=>{useRoute();return {communityId:selected}};
      function Page(){const [taps,setTaps]=React.useState(0);useRoute();return <View testID="proof-page" style={{height:700}}>
        <Text>{page}: {selected} · taps: {taps}</Text>
        {page==='rooms' && <CommunityDrawerTrigger community={{communityId:selected,name:selected}}/>}
        <Pressable testID="proof-tap" onPress={()=>setTaps(taps+1)}><Text>Page action</Text></Pressable>
      </View>}
      export const Stack=Object.assign(()=>{useRoute();return page==='conversation' || page==='rooms' ?
        <BuzzCommunityShell communities={[]} activeCommunityId={null} onSelect={()=>{}} onAdd={()=>{}} onSettings={()=>{}}><Page/></BuzzCommunityShell> : <Page/>}, {Screen:()=>null});`;
      if (mode === 'baseline') {
        shims['@/components/buzz/WorkspaceNavigationShell'] =
          'export const WorkspaceNavigationShell = ({children}) => children;';
      }
      const { result, status, stderr } = await runBrowserProof({
        entry: path.join(mobile, 'scripts/workspace-edge-swipe-proof.tsx'),
        mobile,
        shims,
        width: mode === 'bone' ? 820 : 390,
        budgetMs: 15_000,
        query: mode === 'baseline' ? '?baseline' : '',
      });
      console.log(result);
      expect(status, stderr).toBe(0);
      if (mode === 'baseline') {
        expect(result).toContain('FAIL settings: left-edge swipe reveals the existing rail');
        expect(result).toContain('RESULT FAIL');
      } else {
        expect(result).toContain('RESULT PASS');
        expect(result).not.toContain('FAIL');
      }
    },
    90_000,
  );
});
