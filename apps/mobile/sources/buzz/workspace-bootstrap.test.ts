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

import {
  PERSONAL_WORKSPACE_NAME,
  personalWorkspaceIdForPubkey,
  prepareWorkspaceContext,
} from './workspace-bootstrap';

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
    const personalId = personalWorkspaceIdForPubkey('person-pubkey');
    const personal = workspace(personalId);
    const client = {
      // Two consecutive confirmed-empty discovery answers are required before
      // the creation door may fire; the third read is the post-create re-list.
      listCommunities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([personal]),
      getCommunity: vi.fn().mockResolvedValue(null),
      createCommunity: vi.fn().mockResolvedValue(personalId),
      waitUntilMember: vi.fn().mockResolvedValue(undefined),
    } as any;
    const memory = storage();

    await expect(
      prepareWorkspaceContext(client, 'person-pubkey', undefined, memory),
    ).resolves.toEqual({
      workspaces: [personal],
      activeWorkspaceId: personalId,
      personalWorkspaceId: personalId,
    });

    expect(client.createCommunity).toHaveBeenCalledWith(PERSONAL_WORKSPACE_NAME, {
      communityId: personalId,
    });
    expect(memory.savePersonalId).toHaveBeenCalledWith('person-pubkey', personalId);
    expect(client.waitUntilMember).toHaveBeenCalledWith(personalId, 'person-pubkey');
    expect(memory.saveActiveId).toHaveBeenCalledWith('person-pubkey', personalId);
  });

  it('recovers a remembered personal Workspace instead of creating a duplicate', async () => {
    const personal = workspace('personal-1');
    const client = {
      listCommunities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([personal]),
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
    expect(client.createCommunity).not.toHaveBeenCalled();
  });
});

describe('the personal-Workspace creation door never fires on unconfirmed absence', () => {
  function quietClient() {
    return {
      listCommunities: vi.fn(),
      getCommunity: vi.fn(),
      createCommunity: vi.fn(),
      waitUntilMember: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it('a single empty discovery answer never creates; a confirming non-empty re-read wins', async () => {
    // Production shape (captain's key, 2026-08-26): one transient discovery
    // miss took bootstrap straight into creation and minted junk "Personal"
    // Workspaces signed by the human key.
    const tubing = workspace('tubing-1', 'Tubing Crew');
    const client = quietClient();
    client.listCommunities
      .mockResolvedValueOnce([]) // the partial/unconfirmed miss
      .mockResolvedValueOnce([tubing]); // the confirming re-read

    const result = await prepareWorkspaceContext(client, 'person-pubkey', undefined, storage());

    expect(result.activeWorkspaceId).toBe('tubing-1');
    expect(result.personalWorkspaceId).toBeNull();
    expect(client.createCommunity).not.toHaveBeenCalled();
  });

  it('a remembered-but-unloadable personal Workspace refuses creation instead of duplicating', async () => {
    const client = quietClient();
    client.listCommunities.mockResolvedValue([]);
    client.getCommunity.mockResolvedValue(null); // partial read OR deleted: unknown either way
    const memory = storage({ loadPersonalId: vi.fn().mockResolvedValue('personal-old') });

    await expect(
      prepareWorkspaceContext(client, 'person-pubkey', undefined, memory),
    ).rejects.toThrow(/Remembered Personal/);

    expect(client.createCommunity).not.toHaveBeenCalled();
  });

  it('never creates when the deterministic reconcile read is unavailable', async () => {
    const client = quietClient();
    client.listCommunities.mockResolvedValue([]);
    client.getCommunity.mockRejectedValue(new Error('exact read failed'));

    await expect(
      prepareWorkspaceContext(client, 'person-pubkey', undefined, storage()),
    ).rejects.toThrow('exact read failed');

    expect(client.createCommunity).not.toHaveBeenCalled();
  });

  it('creates exactly once when two concurrent onboardings race in one process', async () => {
    const deterministicId = personalWorkspaceIdForPubkey('person-pubkey');
    const published = workspace(deterministicId);
    const client = quietClient();
    // Two confirmed-empty discovery reads per racing caller, then the
    // post-create re-list sees the minted record.
    client.listCommunities
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([published]);
    client.getCommunity.mockResolvedValue(null);
    client.createCommunity.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => setTimeout(() => resolve(deterministicId), 10)),
    );

    const [a, b] = await Promise.all([
      prepareWorkspaceContext(client, 'person-pubkey', undefined, storage()),
      prepareWorkspaceContext(client, 'person-pubkey', undefined, storage()),
    ]);

    expect(client.createCommunity).toHaveBeenCalledTimes(1);
    expect(client.createCommunity).toHaveBeenCalledWith(PERSONAL_WORKSPACE_NAME, {
      communityId: deterministicId,
    });
    expect(a.activeWorkspaceId).toBe(deterministicId);
    expect(b.activeWorkspaceId).toBe(deterministicId);
  });

  it('reconciles a rejected create response when the deterministic record landed', async () => {
    const deterministicId = personalWorkspaceIdForPubkey('person-pubkey');
    const published = workspace(deterministicId);
    const client = quietClient();
    client.listCommunities
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([published]);
    client.getCommunity.mockResolvedValueOnce(null).mockResolvedValueOnce(published);
    client.createCommunity.mockRejectedValue(new Error('publish response lost'));

    const result = await prepareWorkspaceContext(client, 'person-pubkey', undefined, storage());

    expect(result.activeWorkspaceId).toBe(deterministicId);
    expect(client.createCommunity).toHaveBeenCalledTimes(1);
  });

  it('converges lost persistence onto the already-published record across an app restart', async () => {
    // Session 1: the create publishes to the relay, but the persisted id is
    // lost. Session 2 is a fresh module registry — no shared
    // in-flight state survives — so only the durable deterministic id can
    // converge the retry onto the same record instead of minting a twin.
    const deterministicId = personalWorkspaceIdForPubkey('person-pubkey');
    const lostResponseStorage = storage({
      savePersonalId: vi.fn().mockRejectedValue(new Error('storage write lost')),
    });
    const firstClient = quietClient();
    firstClient.listCommunities.mockResolvedValue([]);
    firstClient.getCommunity.mockResolvedValue(null);
    firstClient.createCommunity.mockResolvedValue(deterministicId);

    await expect(
      prepareWorkspaceContext(firstClient, 'person-pubkey', undefined, lostResponseStorage),
    ).rejects.toThrow('storage write lost');
    expect(firstClient.createCommunity).toHaveBeenCalledTimes(1);
    expect(firstClient.createCommunity).toHaveBeenCalledWith(PERSONAL_WORKSPACE_NAME, {
      communityId: deterministicId,
    });

    vi.resetModules();
    const { prepareWorkspaceContext: freshSession } = await import('./workspace-bootstrap');
    const published = workspace(deterministicId);
    const secondClient = quietClient();
    secondClient.listCommunities
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([published]); // post-adoption re-list sees the record
    secondClient.getCommunity.mockResolvedValue(published); // authoritative reconcile hit

    const result = await freshSession(secondClient, 'person-pubkey', undefined, storage());

    expect(result.activeWorkspaceId).toBe(deterministicId);
    expect(result.personalWorkspaceId).toBe(deterministicId);
    expect(secondClient.createCommunity).not.toHaveBeenCalled();
  });
});
