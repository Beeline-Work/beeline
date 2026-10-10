import { describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceListView,
  isWorkspaceView,
  type AgentDetailView,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { patchWorkspaceAgent, syncWorkspaceListEntry } from './workspace-surface';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values = new Map<string, string>();
    getString(key: string) { return this.values.get(key); }
    set(key: string, value: string) { this.values.set(key, value); }
    delete(key: string) { this.values.delete(key); }
    getAllKeys() { return [...this.values.keys()]; }
  },
}));

const relay = 'https://relay.test';
const viewer = 'a'.repeat(64);
const agentPubkey = 'b'.repeat(64);
const ownerPubkey = 'c'.repeat(64);
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Studio',
  role: 'owner' as const,
  updatedAt: 1,
  createdAt: 1,
};
const viewerIdentity = { pubkey: viewer, kind: 'human' as const, name: 'Viewer' };

function workspaceView(): WorkspaceView {
  return {
    workspace,
    members: [{ identity: viewerIdentity, role: 'owner' }],
    agents: [{
      identity: { pubkey: agentPubkey, kind: 'agent', name: 'Arlo', handle: 'arlo' },
      role: 'member',
      model: 'Old model',
    }],
    peopleTotal: 1,
    agentTotal: 1,
    membersTruncated: false,
    agentsTruncated: false,
    viewer: { identity: viewerIdentity, role: 'owner', permissions: { send: true, manage: true } },
    watchFilters: [],
  } as unknown as WorkspaceView;
}

function detail(name: string): AgentDetailView {
  return {
    workspaceId: workspace.id,
    agent: { identity: { pubkey: agentPubkey, kind: 'agent', name, handle: 'arlo' }, role: 'member' },
    owner: { pubkey: ownerPubkey, kind: 'human', name: 'Owner' },
    catalog: [{
      id: 'model', name: 'Model', category: 'model', currentValue: 'old',
      options: [{ id: 'old', name: 'Old model' }, { id: 'new', name: 'New model' }],
    }],
    selected: { model: 'new' },
  } as unknown as AgentDetailView;
}

describe('shared Workspace surface', () => {
  const address = surfaceAddress(relay, viewer, '/workspace/:id', { workspaceId: workspace.id });

  it('patches an agent receipt into the entry every reader subscribes to', async () => {
    expect(isWorkspaceView(workspaceView())).toBe(true);
    await mobileSurfaceCache.write(address, workspaceView(), isWorkspaceView);
    const seen: string[] = [];
    const stop = mobileSurfaceCache.subscribe(address, () => {
      const agent = mobileSurfaceCache.peek(address, isWorkspaceView)?.agents[0];
      if (agent) seen.push(`${agent.identity.name}/${agent.model}/${agent.owner?.name}`);
    });
    await patchWorkspaceAgent(relay, viewer, workspace.id, agentPubkey, detail('Codex'));
    stop();
    expect(seen).toEqual(['Codex/New model/Owner']);
  });

  it('removes an agent and lowers the total', async () => {
    await mobileSurfaceCache.write(address, workspaceView(), isWorkspaceView);
    await patchWorkspaceAgent(relay, viewer, workspace.id, agentPubkey, null);
    const next = mobileSurfaceCache.peek(address, isWorkspaceView);
    expect(next?.agents).toEqual([]);
    expect(next?.agentTotal).toBe(0);
  });

  it('copies a renamed Workspace into the rail list', async () => {
    const listAddress = surfaceAddress(relay, viewer, '/workspaces');
    const list = {
      workspaces: [{ id: workspace.id, name: 'Studio', role: 'owner', updatedAt: 1 }],
      viewer: viewerIdentity,
      truncated: false,
      watchFilters: [],
    } as unknown as WorkspaceListView;
    await mobileSurfaceCache.write(listAddress, list, isWorkspaceListView);
    let painted: string | undefined;
    const stop = mobileSurfaceCache.subscribe(listAddress, () => {
      painted = mobileSurfaceCache.peek(listAddress, isWorkspaceListView)?.workspaces[0]?.name;
    });
    await syncWorkspaceListEntry(relay, viewer, { ...workspace, name: 'Atelier' });
    stop();
    expect(painted).toBe('Atelier');
  });
});
