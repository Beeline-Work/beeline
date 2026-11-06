import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/', replace: vi.fn() }));
vi.mock('expo-router', () => ({ usePathname: () => route.pathname, router: { replace: route.replace } }));
vi.mock('./beeline/channels', () => ({ default: () => React.createElement('RoomDeck') }));
import Index from './index';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { route.pathname = '/'; route.replace.mockClear(); });
it('mounts the Room deck directly without a landing replace', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Index />); });
  expect(tree!.root.findAllByType('RoomDeck')).toHaveLength(1);
  expect(route.replace).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
it('leaves deep-linked destinations authoritative and restores the deck on Back', async () => {
  route.pathname = '/beeline/chat/pushed';
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Index />); });
  expect(tree!.toJSON()).toBeNull();
  route.pathname = '/';
  await act(async () => tree.update(<Index />));
  expect(tree!.root.findAllByType('RoomDeck')).toHaveLength(1);
  expect(route.replace).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
