import { describe, expect, it, vi } from 'vitest';

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
