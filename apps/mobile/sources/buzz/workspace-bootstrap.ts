import type { BuzzClient, Community } from '@beeline/buzz-client';
import { seedUnmigratableRooms, unmigratableRooms } from '@beeline/buzz-client';

import {
  loadActiveCommunityId,
  loadPersonalCommunityId,
  saveActiveCommunityId,
  savePersonalCommunityId,
} from './community-storage';
import {
  loadUnmigratableRooms,
  saveUnmigratableRooms,
} from './unmigratable-rooms-cache';
import { WORKSPACE_LABEL } from './vocabulary';

export const PERSONAL_WORKSPACE_NAME = 'Personal';

type WorkspaceClient = Pick<
  BuzzClient,
  'createCommunity' | 'getCommunity' | 'listCommunities' | 'waitUntilMember'
>;

export type WorkspaceBootstrapOptions = {
  /**
   * Key-succession chain loader: predecessor pubkeys of this identity
   * (oldest first). When provided, Workspace discovery also finds — and the
   * client migrates into — everything a replaced device key held.
   */
  loadPredecessors?: () => Promise<string[]>;
  /**
   * Durable not-migratable room verdicts (DI seam for tests). Defaults to
   * the MMKV-backed `unmigratable-rooms-cache`: seeded into the buzz-client's
   * session cache before migration so a room proven unprojectable on an
   * earlier launch is skipped WITHOUT re-asserting the full projection wait,
   * and refreshed after discovery so newly-learned verdicts survive relaunch.
   */
  unmigratableVerdicts?: {
    loadAndSeed: (viewerPubkey: string) => void;
    persist: (viewerPubkey: string) => void;
  };
};

const defaultUnmigratableVerdicts = {
  loadAndSeed: (viewerPubkey: string): void => {
    seedUnmigratableRooms(loadUnmigratableRooms(viewerPubkey));
  },
  persist: (viewerPubkey: string): void => {
    saveUnmigratableRooms(viewerPubkey, unmigratableRooms());
  },
};

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
  options: WorkspaceBootstrapOptions = {},
): Promise<WorkspaceContext> {
  const predecessors = options.loadPredecessors ? await options.loadPredecessors() : [];
  const verdicts = options.unmigratableVerdicts ?? defaultUnmigratableVerdicts;
  verdicts.loadAndSeed(pubkey);
  let workspaces = await client.listCommunities(pubkey, predecessors);
  // Persist any verdict learned during THIS pass (migration + membership
  // repair both record them) so the next launch skips those rooms instantly.
  verdicts.persist(pubkey);
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
    workspaces = await client.listCommunities(pubkey, predecessors);

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
