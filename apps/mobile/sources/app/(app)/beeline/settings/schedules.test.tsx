vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });

import React from 'react';
// @ts-expect-error No renderer declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const room = vi.hoisted(() => vi.fn(async () => ({ room: { name: 'Room' }, viewer: { permissions: { manage: true } }, members: [{ identity: { kind: 'agent', pubkey: 'agent-1', name: 'Hoots' } }] })));
const operation = vi.hoisted(() => vi.fn(async (name: string, _input?: unknown) => name === 'readScheduledWork' ? { roomName: 'Room', agentNames: [['agent-1', 'Hoots']], schedules: [
  { id: 'daily', roomId: 'room', agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Morning summary', nextRunAt: 1790000000, runCount: 14 },
  { id: 'video', roomId: 'corner-1', agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 1440 }, message: 'Start the workflow', nextRunAt: 1790000000, runCount: 2, workflowSlug: 'post_youtube_video', corner: { id: 'corner-1', name: 'video' } },
], subscriptions: [{ id: 'sub', roomId: 'room', agentId: 'agent-1', source: 'repository', event: 'issue.opened', repository: 'owner/widgets', prompt: 'Triage new issues.', firedCount: 3 }] } : {}));
const params = vi.hoisted(() => ({ value: { roomId: 'room', workspaceId: 'ws' } as Record<string, string> }));
const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({ router, useLocalSearchParams: () => params.value, useFocusEffect: (effect: any) => React.useEffect(effect, [effect]) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const host = (name: string) => (props: any) => createElement(name, props, props.children);
  return { Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default }, StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map((part: any) => Array.isArray(part) ? Object.assign({}, ...part) : part)) : style }, Pressable: host('Pressable'), TouchableOpacity: host('TouchableOpacity'), Text: host('Text'), ScrollView: host('ScrollView'), View: host('View') };
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
vi.mock('@/components/buzz/WorkflowRunLine', () => ({ WorkflowRunLine: () => null }));
vi.mock('@/components/buzz/CornerGlyph', () => ({ CORNER_META_SIZE: 10, CornerGlyph: () => null }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'viewer' }), getEffectiveRelayUrl: async () => 'http://local' }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: class { room = room; } }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async () => () => undefined,
}) }));
vi.mock('@/buzz/surface-storage', () => {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const key = (address: { endpoint: string; params?: Record<string, unknown> }) =>
    `${address.endpoint}:${JSON.stringify(address.params ?? {})}`;
  const notify = (address: { endpoint: string; params?: Record<string, unknown> }) =>
    listeners.get(key(address))?.forEach((listener) => listener());
  return {
    surfaceAddress: (_relay: string, _viewer: string, endpoint: string, params?: Record<string, unknown>) =>
      ({ endpoint, params }),
    mobileSurfaceCache: {
      clear: () => { values.clear(); listeners.forEach((items) => items.forEach((listener) => listener())); },
      peek: (address: { endpoint: string; params?: Record<string, unknown> }) => values.get(key(address)) ?? null,
      read: async (address: { endpoint: string; params?: Record<string, unknown> }) => values.get(key(address)) ?? null,
      write: async (address: { endpoint: string; params?: Record<string, unknown> }, value: unknown) => {
        values.set(key(address), value); notify(address);
      },
      fetch: async (address: { endpoint: string; params?: Record<string, unknown> }, _guard: unknown,
        request: () => Promise<unknown>) => { const value = await request(); values.set(key(address), value); notify(address); return value; },
      subscribe: (address: { endpoint: string; params?: Record<string, unknown> }, listener: () => void) => {
        const items = listeners.get(key(address)) ?? new Set<() => void>();
        items.add(listener); listeners.set(key(address), items);
        return () => { items.delete(listener); };
      },
    },
  };
});
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { resetClientState } from '@/sync/client-reset';
import ScheduledWork, { orderScheduledWork } from './schedules';
import PromptSchedule from './schedule';
import Subscription from './subscription';

beforeEach(() => {
  resetClientState();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  router.push.mockClear();
  router.back.mockClear();
  operation.mockClear();
  mobileSurfaceCache.clear();
});

/** The pressable row itself, not the part that passes its testID down. */
const press = (tree: any, testID: string) =>
  tree.root.find((node: any) => node.props?.testID === testID && typeof node.props.onPress === 'function').props.onPress();

async function render(element: React.ReactElement) {
  let tree: any;
  await act(async () => { tree = create(element); });
  return tree;
}

it('orders this Room first, then each corner with schedules by next run before subscriptions', () => {
  const cornerA = { id: 'a', name: 'A corner' };
  const cornerB = { id: 'b', name: 'B corner' };
  const schedule = (id: string, nextRunAt: number, corner?: typeof cornerA) =>
    ({ id, nextRunAt, corner } as any);
  const subscription = (id: string, corner?: typeof cornerA) => ({ id, corner } as any);
  const ordered = orderScheduledWork(
    [schedule('b-late', 30, cornerB), schedule('room-late', 20),
      schedule('a', 10, cornerA), schedule('room-early', 5), schedule('b-early', 1, cornerB)],
    [subscription('b-sub', cornerB), subscription('room-sub'), subscription('a-sub', cornerA)],
  );
  expect(ordered.map((entry) => entry.value.id)).toEqual([
    'room-early', 'room-late', 'room-sub', 'a', 'a-sub', 'b-early', 'b-late', 'b-sub',
  ]);
});

it('lists every entry as one row in the shared grammar, each opening its own page', async () => {
  params.value = { roomId: 'room', workspaceId: 'ws' };
  const tree = await render(<ScheduledWork />);
  try {
    const row = (testID: string) => tree.root.findByProps({ testID });
    expect(row('scheduled-work-daily').props).toMatchObject({ title: 'Morning summary', descriptionLead: 'Every hour', description: '· @Hoots · this Room', chevron: 'right' });
    expect(row('scheduled-work-video').props).toMatchObject({ title: 'Post youtube video', descriptionLead: 'Every day', description: '· @Hoots · corner video' });
    expect(row('scheduled-work-video').props.leading).toBeTruthy();
    expect(row('scheduled-work-daily').props.leading).toBeTruthy();
    expect(row('subscription-sub').props.leading).toBeTruthy();
    expect(row('subscription-sub').props).toMatchObject({ title: 'Triage new issues', descriptionLead: 'On new issue in owner/widgets', description: '· @Hoots · this Room' });
    act(() => row('scheduled-work-daily').props.onPress());
    act(() => row('scheduled-work-video').props.onPress());
    act(() => row('subscription-sub').props.onPress());
    expect(router.push.mock.calls.map(([href]) => href)).toEqual([
      { pathname: '/beeline/settings/schedule', params: { roomId: 'room', scheduleId: 'daily' } },
      { pathname: '/beeline/settings/schedule', params: { roomId: 'room', scheduleId: 'video' } },
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
    expect(tree.root.findByProps({ testID: 'scheduled-work-prompt' }).props.children).toBe('Morning summary');
    expect(tree.root.findByProps({ testID: 'scheduled-work-facts-when' }).props.title).toBe('When');
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
    expect(tree.root.findByProps({ testID: 'scheduled-work-facts-when' }).props.description).toBe('On new issue in owner/widgets');
    expect(tree.root.findByProps({ testID: 'scheduled-work-prompt' }).props.children).toBe('Triage new issues.');
    await act(async () => press(tree, 'stop-subscription'));
    expect(operation.mock.calls.filter(([name]) => name === 'deleteRoomSubscription')).toHaveLength(0);
    await act(async () => press(tree, 'stop-subscription-confirm'));
    expect(operation).toHaveBeenCalledWith('deleteRoomSubscription', { roomId: 'room', subscriptionId: 'sub' });
    expect(router.back).toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});

it('names empty and legacy corner names through the shared title grammar (J40)', async () => {
  params.value = { roomId: 'room', workspaceId: 'ws' };
  const original = operation.getMockImplementation()!;
  const base = { agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Check in', nextRunAt: 1790000000, runCount: 1 };
  operation.mockImplementation(async (name: string): Promise<any> => name === 'readScheduledWork' ? { roomName: 'Room', agentNames: [['agent-1', 'Hoots']], schedules: [
    { ...base, id: 'unnamed', roomId: 'abcdef12-3456', corner: { id: 'abcdef12-3456', name: '' } },
    { ...base, id: 'legacy', roomId: 'corner-2', corner: { id: 'corner-2', name: '#Room/fix-auth' } },
  ], subscriptions: [
    { id: 'sub', roomId: 'corner-3', agentId: 'agent-1', source: 'repository', event: 'issue.opened', repository: 'owner/widgets', prompt: 'Triage.', firedCount: 0, corner: { id: 'corner-3', name: 'room/triage' } },
  ] } : {});
  try {
    const tree = await render(<ScheduledWork />);
    const row = (testID: string) => tree.root.findByProps({ testID });
    expect(row('scheduled-work-unnamed').props.description).toBe('· @Hoots · corner corner-abcdef12');
    expect(row('scheduled-work-legacy').props.description).toBe('· @Hoots · corner fix-auth');
    expect(row('subscription-sub').props.description).toBe('· @Hoots · corner triage');
    tree.unmount();
  } finally {
    operation.mockImplementation(original);
  }
});
