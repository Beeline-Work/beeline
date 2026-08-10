import type { BuzzClient, Community } from '@beeline/buzz-client';

import {
  loadActiveCommunityId,
  loadPersonalCommunityId,
  saveActiveCommunityId,
  savePersonalCommunityId,
} from './community-storage';
import { WORKSPACE_LABEL } from './vocabulary';

export const PERSONAL_WORKSPACE_NAME = 'Personal';

type WorkspaceClient = Pick<
  BuzzClient,
  'createCommunity' | 'getCommunity' | 'listCommunities' | 'waitUntilMember'
>;

type WorkspaceStorage = {
  loadActiveId: (pubkey: string) => Promise<string | null>;
  loadPersonalId: (pubkey: string) => Promise<string | null>;
  saveActiveId: (pubkey: string, workspaceId: string) => Promise<void>;
  savePersonalId: (pubkey: string, workspaceId: string) => Promise<void>;
};

const defaultStorage: WorkspaceStorage = {
  loadActiveId: loadActiveCommunityId,
  loadPersonalId: loadPersonalCommunityId,
  saveActiveId: saveActiveCommunityId,
  savePersonalId: savePersonalCommunityId,
};

export type WorkspaceContext = {
  workspaces: Community[];
  activeWorkspaceId: string;
  personalWorkspaceId: string | null;
};

/**
 * Resolve the mandatory Workspace boundary for the mobile app.
 *
 * A person with no shared Workspace gets a real relay-backed personal Workspace.
 * Its ID is remembered before membership projection is awaited so a retry can
 * recover the same Workspace instead of creating a duplicate.
 */
export async function prepareWorkspaceContext(
  client: WorkspaceClient,
  pubkey: string,
  requestedWorkspaceId?: string,
  storage: WorkspaceStorage = defaultStorage,
): Promise<WorkspaceContext> {
  let workspaces = await client.listCommunities();
  let personalWorkspaceId = await storage.loadPersonalId(pubkey);

  if (workspaces.length === 0) {
    let personalWorkspace = personalWorkspaceId
      ? await client.getCommunity(personalWorkspaceId)
      : null;

    if (!personalWorkspace) {
      personalWorkspaceId = await client.createCommunity(PERSONAL_WORKSPACE_NAME);
      await storage.savePersonalId(pubkey, personalWorkspaceId);
    }

    const personalId = personalWorkspaceId;
    if (!personalId) throw new Error(`Personal ${WORKSPACE_LABEL} could not be created.`);

    await client.waitUntilMember(personalId, pubkey);
    workspaces = await client.listCommunities();

    if (!workspaces.some((workspace) => workspace.communityId === personalId)) {
      personalWorkspace = await client.getCommunity(personalId);
      if (!personalWorkspace) {
        throw new Error(`Personal ${WORKSPACE_LABEL} was created but could not be loaded.`);
      }
      workspaces = [personalWorkspace];
    }
  }

  const storedWorkspaceId = await storage.loadActiveId(pubkey);
  const requested = requestedWorkspaceId === 'standalone' ? undefined : requestedWorkspaceId;
  const activeWorkspaceId =
    [requested, storedWorkspaceId, personalWorkspaceId].find(
      (candidate): candidate is string =>
        Boolean(candidate) &&
        workspaces.some((workspace) => workspace.communityId === candidate),
    ) ?? workspaces[0]?.communityId;

  if (!activeWorkspaceId) {
    throw new Error(`No ${WORKSPACE_LABEL} is available for this identity.`);
  }

  await storage.saveActiveId(pubkey, activeWorkspaceId);
  return { workspaces, activeWorkspaceId, personalWorkspaceId };
}
