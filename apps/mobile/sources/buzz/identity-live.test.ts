import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceListView,
  isWorkspaceView,
  type RoomView,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';

const relay = 'https://relay.test';
const viewer = 'a'.repeat(64);
const mate = 'b'.repeat(64);
const agent = 'c'.repeat(64);
const workspaceId = '11111111-1111-4111-8111-111111111111';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values = new Map<string, string>();
    getString(key: string) { return this.values.get(key); }
    set(key: string, value: string) { this.values.set(key, value); }
    delete(key: string) { this.values.delete(key); }
    getAllKeys() { return [...this.values.keys()]; }
  },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: viewer }),
  getEffectiveRelayUrl: async () => relay,
}));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({}) }));
const savedLevels: [string, string][] = [];
vi.mock('@/push/push-level-storage', () => ({
  saveStoredPushLevel: async (pubkey: string, level: string) => { savedLevels.push([pubkey, level]); },
}));
const savedNames: [string, string][] = [];
vi.mock('./person-name', () => ({
  savePreferredPersonName: async (pubkey: string, name: string) => { savedNames.push([pubkey, name]); },
}));

const { applyPersonChanged, applyWorkspaceChanged, subscribeOwnIdentityChange } = await import('./identity-live');
const { IdentitySelection, identityScope } = await import('./identity-records');
const { mobileSurfaceCache, surfaceAddress } = await import('./surface-storage');
const records = await import('./workspace-records');

const header = { id: workspaceId, name: 'Studio', role: 'owner', updatedAt: 1 };
const viewerIdentity = { pubkey: viewer, kind: 'human' as const, name: 'Viewer' };
const mateIdentity = { pubkey: mate, kind: 'human' as const, name: 'Mate', handle: 'mate' };

function workspaceView(): WorkspaceView {
  return {
    workspace: { ...header, createdAt: 1 },
    members: [{ identity: viewerIdentity, role: 'owner' }, { identity: mateIdentity, role: 'member' }],
    agents: [{
      identity: { pubkey: agent, kind: 'agent', name: 'Arlo' },
      role: 'member',
      owner: mateIdentity,
    }],
    membersTruncated: false,
    agentsTruncated: false,
    viewer: { identity: viewerIdentity, role: 'owner', permissions: { send: true, manage: true } },
    watchFilters: [],
  } as unknown as WorkspaceView;
}

const listAddress = surfaceAddress(relay, viewer, '/workspaces');
const detailAddress = surfaceAddress(relay, viewer, '/workspace/:id', { workspaceId });

describe('live Workspace and person changes', () => {
  beforeEach(async () => {
    mobileSurfaceCache.clear();
    savedLevels.length = 0;
    savedNames.length = 0;
    await mobileSurfaceCache.write(listAddress, {
      workspaces: [header], viewer: viewerIdentity, truncated: false, watchFilters: [],
    } as unknown as WorkspaceListView, isWorkspaceListView);
    await mobileSurfaceCache.write(detailAddress, workspaceView(), isWorkspaceView);
  });

  it('repaints the rail and settings copies of a renamed Workspace at once', async () => {
    const painted: string[] = [];
    const stop = mobileSurfaceCache.subscribe(listAddress, () => {
      painted.push(mobileSurfaceCache.peek(listAddress, isWorkspaceListView)!.workspaces[0]!.name);
    });
    await applyWorkspaceChanged({ id: workspaceId, name: 'Atelier', avatar: 'https://relay.test/w.png' });
    stop();
    expect(painted).toEqual(['Atelier']);
    expect(mobileSurfaceCache.peek(listAddress, isWorkspaceListView)!.workspaces[0])
      .toMatchObject({ name: 'Atelier', avatar: 'https://relay.test/w.png', role: 'owner' });
    expect(mobileSurfaceCache.peek(detailAddress, isWorkspaceView)!.workspace)
      .toMatchObject({ name: 'Atelier', avatar: 'https://relay.test/w.png', createdAt: 1 });
  });

  it('renames a person as member, agent owner and roster record, but not anyone else', async () => {
    const scope = records.workspaceRecordScope(relay, viewer, workspaceId);
    const untouched = mobileSurfaceCache.peek(detailAddress, isWorkspaceView)!.members[0];
    await applyPersonChanged({ ...mateIdentity, name: 'Mate Renamed', face: 'fox' });
    const view = mobileSurfaceCache.peek(detailAddress, isWorkspaceView)!;
    expect(view.members[1]!.identity).toEqual({ ...mateIdentity, name: 'Mate Renamed', face: 'fox' });
    expect(view.agents[0]!.owner).toEqual({ ...mateIdentity, name: 'Mate Renamed', face: 'fox' });
    expect(view.members[0]).toBe(untouched);
    expect(records.workspaceRecord(scope, mate)?.identity.name).toBe('Mate Renamed');
    expect(savedNames).toEqual([]);
    expect(savedLevels).toEqual([]);
  });

  it('lets an open Room read before the change select its members and bylines', async () => {
    const readAt = mobileSurfaceCache.now();
    const room = {
      members: [{ identity: mateIdentity, role: 'member' }],
      messages: [{ id: 'm1', author: mateIdentity, text: 'hi', reactions: [{ members: [mateIdentity] }] }],
      viewer: { identity: viewerIdentity, role: 'owner' },
    } as unknown as RoomView;
    await applyPersonChanged({ ...mateIdentity, name: 'Mate Again' });
    const selected = new IdentitySelection(identityScope(relay, viewer), readAt).roomView(room);
    expect(selected.members[0]!.identity.name).toBe('Mate Again');
    expect(selected.messages[0]!.author.name).toBe('Mate Again');
    expect(selected.messages[0]!.reactions![0]!.members![0]!.name).toBe('Mate Again');
    expect(selected.viewer).toBe(room.viewer);
    // A Room read after the change already carries the server's answer.
    const later = new IdentitySelection(identityScope(relay, viewer), mobileSurfaceCache.now()).roomView(room);
    expect(later).toBe(room);
  });

  it('fences a Workspace read in flight when the change lands, and keeps a later read', async () => {
    let answer!: (value: WorkspaceView) => void;
    const inFlight = mobileSurfaceCache.fetch(detailAddress, isWorkspaceView,
      () => new Promise<WorkspaceView>((resolve) => { answer = resolve; }));
    await applyPersonChanged({ ...mateIdentity, name: 'Mate Renamed' });
    answer(workspaceView());
    expect((await inFlight)!.members[1]!.identity.name).toBe('Mate Renamed');
    const later = workspaceView();
    await mobileSurfaceCache.fetch(detailAddress, isWorkspaceView, async () => ({
      ...later,
      members: [later.members[0]!, { ...later.members[1]!, identity: { ...mateIdentity, name: 'Server Name' } }],
    }));
    expect(mobileSurfaceCache.peek(detailAddress, isWorkspaceView)!.members[1]!.identity.name).toBe('Server Name');
  });

  it('applies a Workspace rename to an entry restored from storage afterwards', async () => {
    mobileSurfaceCache.clear();
    await applyWorkspaceChanged({ id: workspaceId, name: 'Atelier' });
    const restored = await mobileSurfaceCache.read(listAddress, isWorkspaceListView);
    expect(restored!.workspaces[0]!.name).toBe('Atelier');
  });

  it('refreshes the viewer\'s own name and push level from another device', async () => {
    const heard: string[] = [];
    const stop = subscribeOwnIdentityChange((person) => heard.push(person.name));
    await applyPersonChanged({ ...viewerIdentity, name: 'Me Elsewhere' }, 'off');
    stop();
    expect(heard).toEqual(['Me Elsewhere']);
    expect(savedNames).toEqual([[viewer, 'Me Elsewhere']]);
    expect(savedLevels).toEqual([[viewer, 'off']]);
    expect(mobileSurfaceCache.peek(listAddress, isWorkspaceListView)!.viewer.name).toBe('Me Elsewhere');
  });
});
