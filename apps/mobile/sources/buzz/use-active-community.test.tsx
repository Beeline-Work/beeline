import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => 'workspace-stored'),
  setItem: vi.fn(async (_key: string, _value: string) => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));
const viewer = vi.hoisted(() => ({ publicKey: 'viewer' }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: viewer.publicKey }) }));

import { saveActiveCommunityId } from './community-storage';
import { useActiveCommunityId } from './use-active-community';
import { resetClientState } from '@/sync/client-reset';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: any[] = [];
afterEach(async () => { await act(async () => mounted.splice(0).forEach((tree) => tree.unmount())); });

it('reads the stored Workspace, then follows a Room opened elsewhere', async () => {
  const seen: Array<string | null | undefined> = [];
  function Reader() { const id = useActiveCommunityId(); seen.push(id); return <span>{id ?? ''}</span>; }
  await act(async () => { mounted.push(create(<Reader />)); });
  expect(seen[0]).toBeUndefined();
  expect(seen.at(-1)).toBe('workspace-stored');
  await act(async () => saveActiveCommunityId('viewer', 'workspace-opened'));
  expect(seen.at(-1)).toBe('workspace-opened');
});

it('follows the new viewer after an identity change', async () => {
  const seen: Array<string | null | undefined> = [];
  function Reader() { const id = useActiveCommunityId(); seen.push(id); return <span>{id ?? ''}</span>; }
  await act(async () => { mounted.push(create(<Reader />)); });
  expect(seen.at(-1)).toBe('workspace-opened');
  viewer.publicKey = 'other';
  asyncStorage.getItem.mockImplementation(async (key: string) =>
    key.endsWith('other') ? 'workspace-other' : 'workspace-stored');
  await act(async () => resetClientState());
  expect(seen.at(-1)).toBe('workspace-other');
  await act(async () => saveActiveCommunityId('viewer', 'workspace-old-viewer'));
  expect(seen.at(-1)).toBe('workspace-other');
  await act(async () => saveActiveCommunityId('other', 'workspace-next'));
  expect(seen.at(-1)).toBe('workspace-next');
});
