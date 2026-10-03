
import React from 'react';
// @ts-expect-error No renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const room = vi.hoisted(() => vi.fn(async () => ({ room: { name: 'Room' }, viewer: { permissions: { manage: true } }, members: [] })));
const operation = vi.hoisted(() => vi.fn(async (name: string) => name === 'listRoomSchedules' ? { schedules: [{ id: 'daily', cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Morning summary', nextRunAt: 1790000000 }] } : {}));
vi.mock('expo-router', () => ({ router: { back: vi.fn() }, useLocalSearchParams: () => ({ roomId: 'room', workspaceId: 'ws' }), useFocusEffect: (effect: any) => React.useEffect(effect, [effect]) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const host = (name: string) => (props: any) => createElement(name, props, props.children);
  return { Pressable: host('Pressable'), TouchableOpacity: host('TouchableOpacity'), Text: host('Text'), ScrollView: host('ScrollView'), View: host('View') };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (fn: any) => fn({ buzz: { type: {}, space: {} } }) } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/buzz/PageHeader', () => ({ PageHeader: () => null }));
vi.mock('@/components/buzz/CornerGlyph', () => ({ CORNER_META_SIZE: 10, CornerGlyph: () => null }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'viewer' }), getEffectiveRelayUrl: async () => 'http://local' }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: class { room = room; } }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
import ScheduledWork from './schedules';
it('R12f: stopping a schedule removes its row without another Room or list read', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let tree: any;
  try {
    await act(async () => { tree = create(<ScheduledWork />); });
    await act(async () => tree.root.findByProps({ testID: 'stop-scheduled-work-daily' }).props.onPress({ stopPropagation() {} }));
    const confirm = tree.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((text: any) => text.props.children === 'CONFIRM STOP'));
    await act(async () => { confirm.props.onPress({ stopPropagation() {} }); });
    expect(tree.root.findAllByProps({ testID: 'stop-scheduled-work-daily' })).toHaveLength(0);
    expect(room).toHaveBeenCalledTimes(1);
    expect(operation.mock.calls.filter(([name]) => name === 'listRoomSchedules')).toHaveLength(1);
    console.log('R12f Demonstrated: stopped schedule absent; Room and list read once.');
  } finally { await act(async () => tree?.unmount()); }
});
