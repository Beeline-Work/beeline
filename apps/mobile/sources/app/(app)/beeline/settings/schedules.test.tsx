
import React from 'react';
// @ts-expect-error No renderer declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const room = vi.hoisted(() => vi.fn(async () => ({ room: { name: 'Room' }, viewer: { permissions: { manage: true } }, members: [{ identity: { kind: 'agent', pubkey: 'agent-1', name: 'Hoots' } }] })));
const operation = vi.hoisted(() => vi.fn(async (name: string, _input?: unknown) => name === 'listRoomSchedules' ? { schedules: [
  { id: 'daily', roomId: 'room', agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Morning summary', nextRunAt: 1790000000, runCount: 14 },
  { id: 'video', roomId: 'corner-1', agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 1440 }, message: 'Start the workflow', nextRunAt: 1790000000, runCount: 2, workflowSlug: 'post_youtube_video', corner: { id: 'corner-1', name: 'video' } },
] }
  : name === 'listRoomSubscriptions' ? { subscriptions: [{ id: 'sub', roomId: 'room', agentId: 'agent-1', source: 'repository', event: 'issue.opened', repository: 'owner/widgets' }] } : {}));
const params = vi.hoisted(() => ({ value: { roomId: 'room', workspaceId: 'ws' } as Record<string, string> }));
const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({ router, useLocalSearchParams: () => params.value, useFocusEffect: (effect: any) => React.useEffect(effect, [effect]) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const host = (name: string) => (props: any) => createElement(name, props, props.children);
  return { Pressable: host('Pressable'), TouchableOpacity: host('TouchableOpacity'), Text: host('Text'), ScrollView: host('ScrollView'), View: host('View') };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (fn: any) => fn({ buzz: { type: {}, space: {} } }), hairlineWidth: 1 } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/buzz/PageHeader', () => ({ PageHeader: () => null }));
vi.mock('@/components/buzz/SettingsRow', async () => {
  const { createElement } = await import('react');
  return { SettingsRow: (props: any) => createElement('SettingsRow', props, props.leading) };
});
vi.mock('@/components/buzz/WorkflowGlyph', () => ({ WorkflowGlyph: () => null }));
vi.mock('@/components/buzz/CornerGlyph', () => ({ CORNER_META_SIZE: 10, CornerGlyph: () => null }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'viewer' }), getEffectiveRelayUrl: async () => 'http://local' }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: class { room = room; } }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
import ScheduledWork from './schedules';
import PromptSchedule from './schedule';
import Subscription from './subscription';

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  router.push.mockClear();
  router.back.mockClear();
  operation.mockClear();
});

/** The pressable row itself, not the part that passes its testID down. */
const press = (tree: any, testID: string) =>
  tree.root.find((node: any) => node.props?.testID === testID && typeof node.props.onPress === 'function').props.onPress();

async function render(element: React.ReactElement) {
  let tree: any;
  await act(async () => { tree = create(element); });
  return tree;
}

it('lists every entry as one row in the shared grammar, each opening its own page', async () => {
  params.value = { roomId: 'room', workspaceId: 'ws' };
  const tree = await render(<ScheduledWork />);
  try {
    const row = (testID: string) => tree.root.findByProps({ testID });
    expect(row('scheduled-work-daily').props).toMatchObject({ title: 'Morning summary · Every hour', description: '@Hoots · this Room', chevron: 'right' });
    expect(row('scheduled-work-video').props).toMatchObject({ title: 'post_youtube_video workflow · Every day', description: '@Hoots · #video' });
    expect(row('scheduled-work-video').props.leading).toBeTruthy();
    expect(row('scheduled-work-daily').props.leading).toBeUndefined();
    expect(row('subscription-sub').props).toMatchObject({ title: 'issue.opened · When received', description: '@Hoots · owner/widgets' });
    act(() => row('scheduled-work-daily').props.onPress());
    act(() => row('scheduled-work-video').props.onPress());
    act(() => row('subscription-sub').props.onPress());
    expect(router.push.mock.calls.map(([href]) => href)).toEqual([
      { pathname: '/beeline/settings/schedule', params: { roomId: 'room', scheduleId: 'daily' } },
      { pathname: '/beeline/workflow', params: { roomId: 'corner-1', name: 'post_youtube_video', scheduleId: 'video', parentRoomId: 'room' } },
      { pathname: '/beeline/settings/subscription', params: { roomId: 'room', subscriptionId: 'sub' } },
    ]);
    // No stop control and no delivery timestamps on the list.
    expect(tree.root.findAll((node: any) => /stop|revoke/i.test(String(node.props?.testID ?? ''))).length).toBe(0);
  } finally { await act(async () => tree.unmount()); }
});

it('stops a prompt schedule from its page only after the confirm step', async () => {
  params.value = { roomId: 'room', scheduleId: 'daily' };
  const tree = await render(<PromptSchedule />);
  try {
    expect(tree.root.findByProps({ testID: 'schedule-prompt' }).props.children).toBe('Morning summary');
    expect(tree.root.findByProps({ testID: 'schedule-run-count' }).props).toMatchObject({ title: 'Runs so far', value: '14' });
    await act(async () => press(tree, 'stop-schedule'));
    expect(operation.mock.calls.filter(([name]) => name === 'deleteRoomSchedule')).toHaveLength(0);
    await act(async () => press(tree, 'stop-schedule-confirm'));
    expect(operation).toHaveBeenCalledWith('deleteRoomSchedule', { roomId: 'room', scheduleId: 'daily' });
    expect(router.back).toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});

it('stops a subscription from its page only after the same confirm step', async () => {
  params.value = { roomId: 'room', subscriptionId: 'sub' };
  const tree = await render(<Subscription />);
  try {
    expect(tree.root.findByProps({ testID: 'subscription-trigger' }).props.children).toBe('issue.opened from owner/widgets.');
    await act(async () => press(tree, 'stop-subscription'));
    expect(operation.mock.calls.filter(([name]) => name === 'deleteRoomSubscription')).toHaveLength(0);
    await act(async () => press(tree, 'stop-subscription-confirm'));
    expect(operation).toHaveBeenCalledWith('deleteRoomSubscription', { roomId: 'room', subscriptionId: 'sub' });
    expect(router.back).toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});
