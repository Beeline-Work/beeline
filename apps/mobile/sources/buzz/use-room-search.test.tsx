import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useRoomSearch } from './use-room-search';
const focus = vi.hoisted(() => ({ current: undefined as undefined | (() => void) }));
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => { focus.current = callback; },
}));
vi.mock('./room-search-drafts', () => ({ removeRoomSearchDrafts: vi.fn(async () => {}) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function Screen({ workspace = 'workspace', identity = 'viewer' }) {
  const search = useRoomSearch(workspace, identity);
  return React.createElement('SearchScreen', search);
}
it('clears query and retracts the bar on list focus after opening a result', async () => {
  let tree: any;
  await act(async () => { tree = create(<Screen />); });
  const screen = () => tree.root.findByType('SearchScreen');
  act(() => focus.current!());
  act(() => { screen().props.setSearchOpen(true); screen().props.setQuery('release'); });
  expect(screen().props.query).toBe('release');
  expect(screen().props.searchOpen).toBe(true);
  // The mounted list remains behind the pushed result. Back delivers focus.
  act(() => focus.current!());
  expect(screen().props.query).toBe('');
  expect(screen().props.searchOpen).toBe(false);
  act(() => screen().props.setSearchOpen(true));
  expect(screen().props.query).toBe('');
  await act(async () => { tree.unmount(); });
});
