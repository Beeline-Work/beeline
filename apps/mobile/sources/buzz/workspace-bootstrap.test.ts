import { beforeEach, describe, expect, it, vi } from 'vitest';

// workspace-bootstrap now seeds/persists unmigratable-room verdicts through
// the default MMKV-backed store; stub the native module like every other
// node-env test that transitively reaches it.
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
  },
}));

import { PERSONAL_WORKSPACE_NAME, prepareWorkspaceContext } from './workspace-bootstrap';

function workspace(communityId: string, name = 'Personal') {
  return { communityId, name } as any;
}

function storage(overrides: Record<string, unknown> = {}) {
  return {
    loadActiveId: vi.fn().mockResolvedValue(null),
    loadPersonalId: vi.fn().mockResolvedValue(null),
    saveActiveId: vi.fn().mockResolvedValue(undefined),
    savePersonalId: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('Workspace bootstrap', () => {
  it('creates and lands a fresh person in a real personal Workspace', async () => {
    const personal = workspace('personal-1');
    const client = {
      listCommunities: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([personal]),
      getCommunity: vi.fn(),
      createCommunity: vi.fn().mockResolvedValue('personal-1'),
      waitUntilMember: vi.fn().mockResolvedValue(undefined),
    } as any;
    const memory = storage();

    await expect(
      prepareWorkspaceContext(client, 'person-pubkey', undefined, memory),
    ).resolves.toEqual({
      workspaces: [personal],
      activeWorkspaceId: 'personal-1',
      personalWorkspaceId: 'personal-1',
    });

    expect(client.createCommunity).toHaveBeenCalledWith(PERSONAL_WORKSPACE_NAME);
    expect(memory.savePersonalId).toHaveBeenCalledWith('person-pubkey', 'personal-1');
    expect(client.waitUntilMember).toHaveBeenCalledWith('personal-1', 'person-pubkey');
    expect(memory.saveActiveId).toHaveBeenCalledWith('person-pubkey', 'personal-1');
  });

  it('recovers a remembered personal Workspace instead of creating a duplicate', async () => {
    const personal = workspace('personal-1');
    const client = {
      listCommunities: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([personal]),
      getCommunity: vi.fn().mockResolvedValue(personal),
      createCommunity: vi.fn(),
      waitUntilMember: vi.fn().mockResolvedValue(undefined),
    } as any;
    const memory = storage({ loadPersonalId: vi.fn().mockResolvedValue('personal-1') });

    const result = await prepareWorkspaceContext(client, 'person-pubkey', undefined, memory);

    expect(result.activeWorkspaceId).toBe('personal-1');
    expect(client.createCommunity).not.toHaveBeenCalled();
    expect(client.waitUntilMember).toHaveBeenCalledWith('personal-1', 'person-pubkey');
  });

  it('honors a requested existing Workspace without creating a personal one', async () => {
    const first = workspace('workspace-1', 'One');
    const requested = workspace('workspace-2', 'Two');
    const client = {
      listCommunities: vi.fn().mockResolvedValue([first, requested]),
      getCommunity: vi.fn(),
      createCommunity: vi.fn(),
      waitUntilMember: vi.fn(),
    } as any;
    const memory = storage();

    const result = await prepareWorkspaceContext(
      client,
      'person-pubkey',
      'workspace-2',
      memory,
    );

    expect(result.activeWorkspaceId).toBe('workspace-2');
    expect(client.createCommunity).not.toHaveBeenCalled();
  });
});

describe('Workspace bootstrap with key-succession predecessors', () => {
  function workspaceClient() {
    return {
      listCommunities: vi.fn().mockResolvedValue([]),
      getCommunity: vi.fn(),
      createCommunity: vi.fn(),
      waitUntilMember: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it('passes the loaded predecessor chain to every Workspace discovery read', async () => {
    const inherited = workspace('inherited-1', 'Old Rooms');
    const client = workspaceClient();
    // First discovery is empty (the successor has nothing of their own yet),
    // the re-list after personal-Workspace resolution sees the migrated rooms.
    client.listCommunities.mockResolvedValueOnce([]).mockResolvedValueOnce([inherited]);
    const memory = storage({ loadPersonalId: vi.fn().mockResolvedValue('inherited-1') });
    client.getCommunity = vi.fn().mockResolvedValue(inherited);
    const loadPredecessors = vi.fn().mockResolvedValue(['old-key-hex']);

    await prepareWorkspaceContext(client, 'successor-key', undefined, memory, {
      loadPredecessors,
    });

    expect(loadPredecessors).toHaveBeenCalledTimes(1);
    expect(client.listCommunities).toHaveBeenNthCalledWith(1, 'successor-key', [
      'old-key-hex',
    ]);
    // The re-list after personal-Workspace resolution carries the chain too.
    expect(client.listCommunities).toHaveBeenNthCalledWith(2, 'successor-key', [
      'old-key-hex',
    ]);
  });

  it('never passes a predecessor chain when no loader is given', async () => {
    const client = workspaceClient();
    client.listCommunities.mockResolvedValue([workspace('ws-1')]);

    await prepareWorkspaceContext(client, 'person-pubkey', undefined, storage());

    expect(client.listCommunities).toHaveBeenCalledWith('person-pubkey', []);
  });

  it('seeds durable unmigratable verdicts before discovery and persists after it', async () => {
    const client = workspaceClient();
    client.listCommunities.mockResolvedValue([workspace('ws-1')]);
    const verdicts = {
      loadAndSeed: vi.fn(),
      persist: vi.fn(),
    };

    await prepareWorkspaceContext(client, 'successor-key', undefined, storage(), {
      unmigratableVerdicts: verdicts,
    });

    // Seed happens BEFORE the migration-bearing read; persist AFTER, so any
    // verdict learned during this pass (migration or membership repair)
    // survives relaunch and the next launch skips those rooms instantly.
    expect(verdicts.loadAndSeed).toHaveBeenCalledWith('successor-key');
    expect(verdicts.persist).toHaveBeenCalledWith('successor-key');
    expect(verdicts.loadAndSeed.mock.invocationCallOrder[0]).toBeLessThan(
      client.listCommunities.mock.invocationCallOrder[0],
    );
    expect(client.listCommunities.mock.invocationCallOrder[0]).toBeLessThan(
      verdicts.persist.mock.invocationCallOrder[0],
    );
  });

  it('does not persist verdicts when discovery itself fails', async () => {
    const client = workspaceClient();
    client.listCommunities.mockRejectedValue(new Error('relay down'));
    const verdicts = { loadAndSeed: vi.fn(), persist: vi.fn() };

    await expect(
      prepareWorkspaceContext(client, 'successor-key', undefined, storage(), {
        unmigratableVerdicts: verdicts,
      }),
    ).rejects.toThrow('relay down');

    expect(verdicts.loadAndSeed).toHaveBeenCalled();
    expect(verdicts.persist).not.toHaveBeenCalled();
  });
});
