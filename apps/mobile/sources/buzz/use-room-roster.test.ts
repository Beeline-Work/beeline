import React from 'react';
// @ts-expect-error Renderer declarations are absent in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWorkspaceView, type WorkspaceView } from '@beeline/buzz-client';
const fixture = vi.hoisted(() => ({ origin: 'https://synthetic.invalid', storage: new Map<string, string>(), read: vi.fn(), error: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('@/auth/buzz-identity-storage', () => ({ getEffectiveRelayUrl: async () => fixture.origin }));
vi.mock('./surface-storage', async () => {
  const { SurfaceRegistry } = await import('./surface-registry');
  const { SurfaceResponseCache } = await import('@beeline/buzz-client');
  return { mobileSurfaceCache: new SurfaceRegistry(new SurfaceResponseCache({ get: async (key) => fixture.storage.get(key) ?? null,
      set: async (key, value) => {fixture.storage.set(key, value);}, remove: async (key) => {fixture.storage.delete(key);} })),
    surfaceAddress: (relayOrigin: string, viewerPubkey: string, endpoint: string, params: Record<string, string>) => ({ relayOrigin, viewerPubkey, endpoint, params }) };
});
import { useRoomRoster } from './use-room-roster';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { resetClientState } from '@/sync/client-reset';
const workspace = '11111111-1111-4111-8111-111111111111',other = '22222222-2222-4222-8222-222222222222',viewer = 'a'.repeat(64);
function dto(id = workspace): WorkspaceView {
  const identity = { pubkey: viewer, kind: 'human' as const, name: 'Reader', handle: 'reader' };
  return { workspace: { id, name: 'Roster', visibility: 'invite-only', role: 'owner', updatedAt: 1, createdAt: 1 }, members: [{ identity, role: 'owner' }], agents: [],
    viewer: { identity, role: 'owner', permissions: { send: true, manage: true } }, watchFilters: [], peopleTotal: 1, agentTotal: 0, membersTruncated: false, agentsTruncated: false };
}
let tree: any;const current: Array<WorkspaceView | null> = [],rendered: Array<string | null> = [];
function Picker({ open = false, id = workspace, index = 0, revision = 0 }: {open?: boolean;id?: string;index?: number;revision?: number;}) {
  const owner = useRoomRoster(id, viewer, open, fixture.read, fixture.error);current[index] = owner.value;rendered.push(current[index]?.workspace.id ?? null);return /*#__PURE__*/React.createElement("span", null, revision);
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;resetClientState();mobileSurfaceCache.clear();fixture.storage.clear();
  fixture.origin = 'https://synthetic.invalid';current.length = 0;rendered.length = 0;vi.clearAllMocks();fixture.read.mockResolvedValue(dto());
});
afterEach(() => {if (tree) act(() => tree.unmount());tree = undefined;});
describe('Room picker cached reads', () => {

  it('keeps a held roster visible for bylines but 1,000 closed-picker renders perform zero Workspace reads', async () => {
    await mobileSurfaceCache.write(surfaceAddress(fixture.origin, viewer, '/workspace/:id', { workspaceId: workspace }), dto(), isWorkspaceView);
    await act(async () => {tree = create(/*#__PURE__*/React.createElement(Picker, null));});
    for (let n = 1; n <= 1000; n++) await act(async () => tree.update(/*#__PURE__*/React.createElement(Picker, { revision: n })));
    expect(current[0]?.workspace.id).toBe(workspace);expect(fixture.read).not.toHaveBeenCalled();
  });
  it('two concurrent visible pickers share one actual snapshot flight', async () => {
    let finish!: (value: WorkspaceView) => void;fixture.read.mockImplementation(() => new Promise<WorkspaceView>((resolve) => {finish = resolve;}));
    await act(async () => {tree = create(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Picker, { open: true }), /*#__PURE__*/React.createElement(Picker, { open: true, index: 1 })));});
    expect(fixture.read).toHaveBeenCalledTimes(1);
    await act(async () => finish(dto()));
    expect(current.map((value) => value?.members[0]?.identity.pubkey)).toEqual([viewer, viewer]);
    expect(fixture.read).toHaveBeenCalledTimes(1);expect(fixture.error).not.toHaveBeenCalled();
  });
  it('a Workspace or connection-origin change hides the previous scope immediately and never borrows its cache key', async () => {
    await mobileSurfaceCache.write(surfaceAddress(fixture.origin, viewer, '/workspace/:id', { workspaceId: workspace }), dto(), isWorkspaceView);
    await act(async () => {tree = create(/*#__PURE__*/React.createElement(Picker, null));});expect(current[0]?.workspace.id).toBe(workspace);
    const changedWorkspace = rendered.length;
    await act(async () => tree.update(/*#__PURE__*/React.createElement(Picker, { id: other })));expect(current[0]).toBeNull();expect(fixture.read).not.toHaveBeenCalled();
    expect(rendered.slice(changedWorkspace)).not.toContain(workspace);
    fixture.origin = 'https://other-synthetic.invalid';
    const changedOrigin = rendered.length;
    await act(async () => {resetClientState();tree.update(/*#__PURE__*/React.createElement(Picker, { id: workspace }));});
    expect(rendered.slice(changedOrigin).every((value) => value === null)).toBe(true);
    expect(current[0]).toBeNull();expect(fixture.read).not.toHaveBeenCalled();
  });
});
