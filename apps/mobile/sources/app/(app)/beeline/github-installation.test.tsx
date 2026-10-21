import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  enabled:false, path:vi.fn(async ():Promise<string|null> => '/beeline/chat/room'),
  complete:vi.fn(async () => undefined), operation:vi.fn(async () => ({})),
}));
vi.mock('@/buzz/onboarding-rollout',()=>({useRepositoryOnboarding:()=>mocks.enabled}));
vi.mock('@/buzz/latency-route-hook',()=>({useLatencyRouteFrame:()=>undefined}));
vi.mock('@/auth/github-auth-session',()=>({githubInstallationReturnPath:mocks.path,completeGitHubInstallationRoute:mocks.complete}));
vi.mock('@/sync/transport/monolith-operation',()=>({monolithPhoneOperation:mocks.operation}));
vi.mock('react-native',()=>({View:(props:any)=>React.createElement('View',props,props.children),Text:(props:any)=>React.createElement('Text',props,props.children)}));
vi.mock('react-native-unistyles',()=>({StyleSheet:{create:()=>({page:{},copy:{}})}}));
vi.mock('@/components/buzz/Button',()=>({Button:(props:any)=>React.createElement('Button',props)}));
vi.mock('@/components/buzz/PageHeader',()=>({PageHeader:(props:any)=>React.createElement('PageHeader',props)}));
vi.mock('expo-router',()=>({useLocalSearchParams:()=>({installed:'1'}),Redirect:(props:any)=>React.createElement('Redirect',props)}));
import GitHubInstallation from './github-installation';
beforeEach(()=>{vi.clearAllMocks();mocks.enabled=false;mocks.path.mockResolvedValue('/beeline/chat/room');});
async function render(){let renderer:any;await act(async()=>{renderer=create(<GitHubInstallation/>);});return renderer;}
it('OFF preserves the existing return target and performs no new repository refresh',async()=>{
  const renderer=await render();
  expect(renderer.root.findByType('Redirect').props.href).toBe('/beeline/chat/room');
  expect(mocks.complete).toHaveBeenCalledWith('1');
  expect(mocks.operation).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('PageHeader')).toHaveLength(0);
});
it('OFF keeps the existing channels fallback for an unbound return',async()=>{
  mocks.path.mockResolvedValue(null);
  const renderer=await render();
  expect(renderer.root.findByType('Redirect').props.href).toBe('/beeline/channels');
  expect(mocks.complete).not.toHaveBeenCalled();
});
it('ON shows the Beeline retry UI for an unbound return',async()=>{
  mocks.enabled=true;mocks.path.mockResolvedValue(null);
  const renderer=await render();
  expect(renderer.root.findByType('PageHeader').props.title).toBe('GitHub needs another try');
  expect(renderer.root.findByType('Button').props.label).toBe('Retry');
  expect(mocks.complete).not.toHaveBeenCalled();
});
