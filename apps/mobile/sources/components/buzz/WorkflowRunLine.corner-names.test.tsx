import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CornerListItem, WorkflowRunDetailView } from '@beeline/api-contract/phone';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Linking: {}, Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Circle: host('Circle'), Path: host('Path') };
});
vi.mock('react-native-unistyles', () => {
  // Any theme token reads as a plain value.
  const theme: any = new Proxy({}, { get: () => theme });
  return { StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory(theme) } };
});
vi.mock('./CornerGlyph', () => ({ CORNER_META_SIZE: 12, CornerGlyph: () => null }));
vi.mock('./IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('./Ledger', () => ({ provisionalProseStyle: {}, settledAgentProseStyle: {} }));
vi.mock('./MonoHull', () => ({ HullLivePulse: () => null }));

import { WorkflowRunLine } from './WorkflowRunLine';
import {
  acceptCornerStatusFrame,
  noteCornerLaneSubscribed,
  resetRoomCornerStore,
} from '@/buzz/room-corner-store';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => resetRoomCornerStore());

const detail = {
  run: { runId: 'run', roomId: 'parent', roomName: 'general', state: 'build', status: 'running',
    viewerHolds: false, startedAt: 1, updatedAt: 2 },
  contract: { handoffs: { build: { kind: 'handoff', does: 'Build it', on: {} } } },
  history: [{ toState: 'build', at: 1, displayStatus: 'current',
    openedCorners: [{ id: 'corner-a', name: 'saved-name', parentRoomId: 'parent' }] }],
  roleHolders: {},
} as unknown as WorkflowRunDetailView;

const row = (name: string) => ({
  corner: { id: 'corner-a', name },
  lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
  state: 'working',
}) as unknown as CornerListItem;

function frame(sequence: number, name: string) {
  return {
    roomId: 'parent', sequence, cornerCount: 1, waitingCornerCount: 0,
    openCorners: [{ id: 'corner-a', name, state: 'working' as const }],
    corners: [row(name)],
  };
}

function cornerName(tree: ReactTestRenderer): string {
  const link = tree.root.find((node: any) => node.props.testID === 'workflow-run-corner-corner-a');
  return link.props.accessibilityLabel;
}

it('names an opened corner from the parent Room record, and follows a rename', async () => {
  const opened: string[] = [];
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <WorkflowRunLine detail={detail} now={3} onOpenCorner={(corner) => opened.push(corner.name)} />,
    );
  });
  // No row in the record yet: the run's saved name.
  expect(cornerName(tree)).toBe('Open corner saved-name');
  await act(async () => {
    noteCornerLaneSubscribed('parent', false);
    acceptCornerStatusFrame(frame(1, 'first-name'));
  });
  expect(cornerName(tree)).toBe('Open corner first-name');
  await act(async () => { acceptCornerStatusFrame(frame(2, 'renamed')); });
  expect(cornerName(tree)).toBe('Open corner renamed');
  tree.root.find((node: any) => node.props.testID === 'workflow-run-corner-corner-a').props.onPress();
  expect(opened).toEqual(['renamed']);
  await act(async () => tree.unmount());
});
