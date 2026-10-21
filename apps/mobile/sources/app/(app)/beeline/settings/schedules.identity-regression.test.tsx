vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });

import React from 'react';
// @ts-expect-error No renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const room = vi.hoisted(() => vi.fn(async () => ({ room: { name: 'Room' }, viewer: { permissions: { manage: true } }, members: [{ identity: { kind: 'agent', pubkey: 'agent-1', name: 'Test agent' } }] })));
const operation = vi.hoisted(() => vi.fn(async (name: string, _input?: unknown) => name === 'readScheduledWork' ? { roomName: 'Room', agentNames: [['agent-1', 'Test agent']], schedules: [
  { id: 'daily', title: 'Morning summary', roomId: 'room', agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Morning summary', nextRunAt: 1790000000, runCount: 14 },
  { id: 'video', title: 'Post youtube video', maxRuns: 1, roomId: 'corner-1', agentId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 1440 }, message: 'Start the workflow', nextRunAt: 1790000000, runCount: 2, workflowSlug: 'post_youtube_video', corner: { id: 'corner-1', name: 'video' } },
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
const PhoneError = vi.hoisted(() => class MonolithPhoneOperationError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly code: string) {
    super(`Monolith ${operation} failed (${status}): ${code}`);
    this.name = 'MonolithPhoneOperationError';
  }
});
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation, MonolithPhoneOperationError: PhoneError }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async () => () => undefined,
}) }));
vi.mock('@/buzz/surface-storage', async () => {
  const { SurfaceResponseCache } = await import('@beeline/buzz-client');
  const { SurfaceRegistry } = await import('@/buzz/surface-registry');
  const { selectIdentities } = await import('@/buzz/identity-records');
  const stored = new Map<string, string>();
  return {
    surfaceAddress: (relayOrigin: string, viewerPubkey: string, endpoint: string,
      params?: Record<string, string>) => ({ relayOrigin, viewerPubkey, endpoint, params }),
    mobileSurfaceCache: new SurfaceRegistry(new SurfaceResponseCache({
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: string) => { stored.set(key, value); },
      remove: async (key: string) => { stored.delete(key); },
    }), undefined, selectIdentities),
  };
});
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { resetClientState } from '@/sync/client-reset';
import ScheduledWork from './schedules';
import type { ScheduledWorkResult } from '@beeline/api-contract/phone';

async function render(element: React.ReactElement) {
  let tree: any;
  await act(async () => { tree = create(element); });
  return tree;
}

// Reproduction MOBILE-D: a valid scheduled-work DTO has no Room viewer.
it.each(['fetched', 'cached'] as const)('MOBILE-D: renders %s scheduled work after an identity update', async (source) => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetClientState();
  mobileSurfaceCache.clear();
  operation.mockClear();
  const { identityScope, recordPerson } = await import('@/buzz/identity-records');
  recordPerson(identityScope('http://local', 'viewer'),
    { pubkey: 'agent-1', kind: 'agent', name: 'Updated agent' }, Number.MAX_SAFE_INTEGER);
  params.value = { roomId: source, workspaceId: 'ws' };
  if (source === 'cached') {
    const value = await operation('readScheduledWork');
    await mobileSurfaceCache.persist(
      surfaceAddress('http://local', 'viewer', '/room/:id/scheduled-work', { roomId: source }),
      value as unknown as ScheduledWorkResult,
      (candidate): candidate is ScheduledWorkResult => Boolean(candidate && typeof candidate === 'object' && 'schedules' in candidate),
    );
    operation.mockClear();
  }
  const tree = await render(<ScheduledWork />);
  try {
    expect(tree.root.findByProps({ testID: 'scheduled-work-daily' }).props.title)
      .toBe('Morning summary');
    expect(tree.root.findByProps({ testID: 'subscription-sub' }).props.title)
      .toBe('Triage new issues');
    expect(operation.mock.calls.filter(([name]) => name === 'readScheduledWork'))
      .toHaveLength(source === 'cached' ? 0 : 1);
  } finally { await act(async () => tree.unmount()); }
});
