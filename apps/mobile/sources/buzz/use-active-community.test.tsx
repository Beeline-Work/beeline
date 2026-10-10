import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => 'workspace-stored'),
  setItem: vi.fn(async (_key: string, _value: string) => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'viewer' }) }));

import { saveActiveCommunityId } from './community-storage';
import { useActiveCommunityId } from './use-active-community';

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
