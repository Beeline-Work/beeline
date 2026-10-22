import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  enabled:false, path:vi.fn(async ():Promise<string|null> => '/beeline/chat/room'),
  complete:vi.fn(async () => undefined), operation:vi.fn(async () => ({})),
  browserComplete:vi.fn(), params: { installed: '1', error: undefined as string | undefined },
}));
vi.mock('expo-web-browser',()=>({maybeCompleteAuthSession:mocks.browserComplete}));
vi.mock('@/buzz/onboarding-rollout',()=>({useRepositoryOnboarding:()=>mocks.enabled}));
vi.mock('@/buzz/latency-route-hook',()=>({useLatencyRouteFrame:()=>undefined}));
vi.mock('@/auth/github-auth-session',()=>({githubInstallationReturnPath:mocks.path,completeGitHubInstallationRoute:mocks.complete}));
vi.mock('@/sync/transport/monolith-operation',()=>({monolithPhoneOperation:mocks.operation}));
vi.mock('react-native',()=>({Platform:{OS:'web'},View:(props:any)=>React.createElement('View',props,props.children),Text:(props:any)=>React.createElement('Text',props,props.children)}));
vi.mock('react-native-unistyles',()=>({StyleSheet:{create:()=>({page:{},copy:{}})}}));
vi.mock('@/components/buzz/Button',()=>({Button:(props:any)=>React.createElement('Button',props)}));
vi.mock('@/components/buzz/PageHeader',()=>({PageHeader:(props:any)=>React.createElement('PageHeader',props)}));
vi.mock('expo-router',()=>({useLocalSearchParams:()=>mocks.params,Redirect:(props:any)=>React.createElement('Redirect',props)}));
import GitHubInstallation from './github-installation';
beforeEach(()=>{vi.clearAllMocks();mocks.enabled=false;mocks.path.mockResolvedValue('/beeline/chat/room');mocks.operation.mockResolvedValue({});mocks.complete.mockResolvedValue(undefined);mocks.params={installed:'1',error:undefined};});
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
it('GH-WEB-1: ON refreshes and returns to channels without a pending path',async()=>{
  mocks.enabled=true;mocks.path.mockResolvedValue(null);
  const renderer=await render();
  expect(mocks.operation).toHaveBeenCalledWith('listGitHubRepositories',{refresh:true});
  expect(renderer.root.findByType('Redirect').props.href).toBe('/beeline/channels');
  expect(mocks.browserComplete).toHaveBeenCalledTimes(1);
});
it('returns to the saved Room after refreshing repositories',async()=>{
  mocks.enabled=true;
  const renderer=await render();
  expect(renderer.root.findByType('Redirect').props.href).toBe('/beeline/chat/room');
  expect(mocks.operation).toHaveBeenCalledTimes(1);
});
it('GH-WEB-1: failed refresh offers the primary Room recovery action',async()=>{
  mocks.enabled=true;mocks.path.mockResolvedValue(null);
  mocks.operation.mockRejectedValueOnce(new Error('Repository refresh failed'));
  const renderer=await render();
  expect(renderer.root.findByType('PageHeader').props.title).toBe('GitHub needs another try');
  expect(mocks.browserComplete).not.toHaveBeenCalled();
  const button = renderer.root.findByType('Button');
  expect(button.props.label).toBe('Back to Room');
  expect(button.props.variant).toBe('primary');
  await act(async()=>{button.props.onPress();});
  expect(mocks.operation).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType('Redirect').props.href).toBe('/beeline/channels');
  expect(mocks.browserComplete).not.toHaveBeenCalled();
});
it('Back to Room takes a GitHub error back to the Room to start again',async()=>{
  mocks.enabled=true;mocks.params={installed:'0',error:'access_denied'};
  mocks.complete.mockRejectedValueOnce(new Error('GitHub authorization was denied'));
  const renderer=await render();
  expect(renderer.root.findByType('PageHeader').props.title).toBe('GitHub needs another try');
  await act(async()=>{renderer.root.findByType('Button').props.onPress();});
  expect(renderer.root.findByType('Redirect').props.href).toBe('/beeline/chat/room');
  expect(mocks.operation).not.toHaveBeenCalled();
});
