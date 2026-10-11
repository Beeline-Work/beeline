import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAgentDetailView,
  isWorkspaceView,
  type AgentDetailView,
  type WorkspaceView,
} from '@beeline/buzz-client';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values = new Map<string, string>();
    getString(key: string) { return this.values.get(key); }
    set(key: string, value: string) { this.values.set(key, value); }
    delete(key: string) { this.values.delete(key); }
    getAllKeys() { return [...this.values.keys()]; }
  },
}));

const { resetClientState } = await import('@/sync/client-reset');
const { identityScope, recordPerson } = await import('./identity-records');
const { mobileSurfaceCache, surfaceAddress } = await import('./surface-storage');
const { currentSurfaceStamp } = await import('./surface-clock');
const records = await import('./workspace-records');

const relay = 'https://relay.test';
const viewer = 'a'.repeat(64);
const mate = 'b'.repeat(64);
const agent = 'c'.repeat(64);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const viewerIdentity = { pubkey: viewer, kind: 'human' as const, name: 'Viewer' };
const mateIdentity = { pubkey: mate, kind: 'human' as const, name: 'Mate' };
const scope = records.workspaceRecordScope(relay, viewer, workspaceId);
const entry = surfaceAddress(relay, viewer, '/workspace/:id', { workspaceId });
const agentAddress = surfaceAddress(relay, viewer, '/workspace/:id/agents/:agentId',
  { workspaceId, agentPubkey: agent });

function workspaceView(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspace: { id: workspaceId, name: 'Studio', role: 'owner', updatedAt: 1, createdAt: 1 },
    members: [{ identity: viewerIdentity, role: 'owner' }, { identity: mateIdentity, role: 'member' }],
    agents: [{
      identity: { pubkey: agent, kind: 'agent', name: 'Arlo', handle: 'arlo' },
      role: 'member',
      model: 'Old model',
      owner: mateIdentity,
    }],
    peopleTotal: 2,
    agentTotal: 1,
    membersTruncated: false,
    agentsTruncated: false,
    viewer: { identity: viewerIdentity, role: 'owner', permissions: { send: true, manage: true } },
    watchFilters: [],
    ...overrides,
  } as WorkspaceView;
}

function detail(name: string): AgentDetailView {
  return {
    workspaceId,
    agent: { identity: { pubkey: agent, kind: 'agent', name, handle: 'arlo' }, role: 'member' },
    owner: mateIdentity,
    catalog: [{
      id: 'model', name: 'Model', category: 'model', currentValue: 'old',
      options: [{ id: 'old', name: 'Old model' }, { id: 'new', name: 'New model' }],
    }],
    selected: { model: 'new' },
  } as unknown as AgentDetailView;
}

const ids = [viewer, mate];

describe('Workspace roster records', () => {
  beforeEach(() => {
    resetClientState();
    mobileSurfaceCache.clear();
  });

  it('learns rows and totals from any writer of the shared Workspace entry', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    expect(records.workspaceRows(scope, ids).map((row) => row.identity.name)).toEqual(['Viewer', 'Mate']);
    expect(records.workspacePage(scope, '').people?.total).toBe(2);
    expect(records.workspacePage(scope, '').agents?.total).toBe(1);
  });

  it('applies one agent receipt write to the roster row every page selects', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    const before = mobileSurfaceCache.peek(entry, isWorkspaceView);
    await mobileSurfaceCache.write(agentAddress, detail('Codex'), isAgentDetailView);
    expect(records.workspaceRows(scope, [agent])[0]).toMatchObject({
      identity: { name: 'Codex' }, model: 'New model', owner: mateIdentity,
    });
    // The receipt is one write: the server entry keeps the value it was read with.
    expect(mobileSurfaceCache.peek(entry, isWorkspaceView)).toBe(before);
  });

  it('removes a member from every page and lowers each total that counted them', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    records.recordWorkspacePage(scope, { members: [workspaceView().members[1]!], agents: [], peopleTotal: 1 },
      { query: 'ma', kind: 'human', append: false, stamp: currentSurfaceStamp() });
    records.recordWorkspaceRemoval(scope, mate);
    expect(records.workspaceRows(scope, ids).map((row) => row.identity.pubkey)).toEqual([viewer]);
    expect(records.workspaceRecord(scope, mate)).toBeNull();
    expect(records.workspacePage(scope, '').people?.total).toBe(1);
    expect(records.workspacePage(scope, '').agents?.total).toBe(1);
    expect(records.workspacePage(scope, 'ma').people?.total).toBe(0);
  });

  it('keeps a removal over a Workspace read that was in flight when it landed', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    let answer!: (value: WorkspaceView) => void;
    const read = mobileSurfaceCache.fetch(entry, isWorkspaceView,
      () => new Promise<WorkspaceView>((resolve) => { answer = resolve; }));
    records.recordWorkspaceRemoval(scope, mate);
    answer(workspaceView());
    await read;
    expect(records.workspaceRecord(scope, mate)).toBeNull();
  });

  it('keeps an agent rename receipt over a Workspace read that was in flight when it landed', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    let answer!: (value: WorkspaceView) => void;
    const read = mobileSurfaceCache.fetch(entry, isWorkspaceView,
      () => new Promise<WorkspaceView>((resolve) => { answer = resolve; }));
    await mobileSurfaceCache.write(agentAddress, detail('Codex'), isAgentDetailView);
    answer(workspaceView());
    await read;
    expect(records.workspaceRecord(scope, agent)?.identity.name).toBe('Codex');
  });

  it('keeps a removal over the totals of a roster page that was in flight when it landed', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    const stamp = currentSurfaceStamp();
    records.recordWorkspaceRemoval(scope, mate);
    records.recordWorkspacePage(scope, { members: workspaceView().members, agents: [], peopleTotal: 2 },
      { query: '', kind: 'human', append: false, stamp });
    expect(records.workspaceRows(scope, ids).map((row) => row.identity.pubkey)).toEqual([viewer]);
    expect(records.workspacePage(scope, '').people?.total).toBe(1);
    expect(records.workspacePage(scope, '').agents?.total).toBe(1);
  });

  it('never lets an older page replace a newer row', () => {
    const stale = currentSurfaceStamp();
    records.recordWorkspacePage(scope, {
      members: [{ identity: { ...mateIdentity, name: 'Newer' }, role: 'admin' }], agents: [],
    }, { append: false, stamp: stale + 1 });
    records.recordWorkspacePage(scope, { members: [{ identity: mateIdentity, role: 'member' }], agents: [] },
      { append: false, stamp: stale });
    expect(records.workspaceRecord(scope, mate)).toMatchObject({ identity: { name: 'Newer' }, role: 'admin' });
  });

  it('selects a live identity change newer than the row, as member and as agent owner', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    mobileSurfaceCache.fenceViewer(relay, viewer,
      (stamp) => recordPerson(identityScope(relay, viewer), { ...mateIdentity, name: 'Mate Renamed' }, stamp));
    expect(records.workspaceRecord(scope, mate)?.identity.name).toBe('Mate Renamed');
    expect(records.workspaceOwnedAgents(scope, mate)[0]?.owner?.name).toBe('Mate Renamed');
  });

  it('drops every record on an identity or relay change', async () => {
    await mobileSurfaceCache.write(entry, workspaceView(), isWorkspaceView);
    resetClientState();
    expect(records.workspaceRecord(scope, mate)).toBeUndefined();
    expect(records.workspaceRows(scope, ids)).toEqual([]);
  });
});
