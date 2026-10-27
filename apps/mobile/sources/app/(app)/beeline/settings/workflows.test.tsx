import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { connectionErrorTitle, connectionErrorDescription } from '@/buzz/app-error-copy';

const controls = vi.hoisted(() => ({ room: vi.fn(), operation: vi.fn() }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View:host('View'), Text:host('Text'), ScrollView:host('ScrollView'), TouchableOpacity:host('TouchableOpacity') };
});
vi.mock('expo-router', () => ({
  router: { replace:vi.fn(), back:vi.fn() },
  useLocalSearchParams: () => ({roomId:'room-1'}),
  useFocusEffect: (effect:()=>void) => React.useEffect(effect,[effect]),
}));
vi.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:()=>({top:0,bottom:0})}));
vi.mock('@/utils/responsive', () => ({useIsDesktop:()=>false}));
vi.mock('@/buzz/latency-route-hook', () => ({useLatencyRouteFrame:()=>undefined}));
vi.mock('@/auth/buzz-identity-storage', () => ({loadBuzzIdentity:async()=>({publicKey:'viewer'}),getEffectiveRelayUrl:async()=>'https://relay.test'}));
vi.mock('@/sync/transport/room-view-client', () => ({RoomViewClient:class { room=controls.room; }}));
vi.mock('@/sync/transport/monolith-operation', () => ({monolithPhoneOperation:controls.operation}));
vi.mock('@/constants/Typography', () => ({Typography:{default:()=>({})}}));
vi.mock('@/components/buzz/PageHeader', () => ({PageHeader:()=>null}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({SurfaceGlyphLoader:()=>null}));
vi.mock('@/components/buzz/ChevronGlyph', () => ({ChevronGlyph:()=>null,CHEVRON_ROW_SIZE:16}));
vi.mock('@/components/buzz/SettingsRow', () => ({SettingsRow:(props:any)=>React.createElement('SettingsRow',props)}));
vi.mock('@/modal/ModalManager', () => ({Modal:{confirm:vi.fn()}}));

import RoomWorkflows from './workflows';

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  controls.room.mockReset().mockResolvedValue({viewer:{permissions:{manage:true}},repositoryResolution:'repository',room:{name:'beeline'}});
  controls.operation.mockReset().mockResolvedValue({workflows:[],defaultBranch:'main'});
});

it.each([
  ['network',new RoomViewHttpError(504,'surface_request_timed_out'),connectionErrorTitle,connectionErrorDescription],
  ['server refusal',Object.assign(new Error('Workspace admins only'),{status:403}),'Workspace admins only',undefined],
  ['unknown',new Error('opaque_diagnostic'),'Could not load workflows.',undefined],
])('R2: displays the %s failure and Retry reloads Workflow settings', async (_kind,reason,title,description) => {
  controls.room.mockRejectedValueOnce(reason);
  let tree:any;
  try {
    await act(async()=>{tree=create(<RoomWorkflows />);});
    const row=tree.root.findByType('SettingsRow');
    expect(row.props.title).toBe(title);
    expect(row.props.title).not.toContain('{error}');
    expect(row.props.description).toBe(description);
    expect(row.props.action).toBe('Retry');
    await act(async()=>row.props.onPress());
    expect(controls.room).toHaveBeenCalledTimes(2);
    expect(controls.operation).toHaveBeenCalledWith('listRoomWorkflows',{roomId:'room-1'});
    expect(tree.root.findAllByType('SettingsRow')).toHaveLength(0);
  } finally { if(tree) await act(async()=>tree.unmount()); }
});
