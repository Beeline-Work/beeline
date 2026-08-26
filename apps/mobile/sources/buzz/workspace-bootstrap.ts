import type { BuzzClient, Community } from '@beeline/buzz-client';
import { seedUnmigratableRooms, unmigratableRooms } from '@beeline/buzz-client';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import {
  clearPersonalCommunityId,
  loadActiveCommunityId,
  loadPersonalCommunityId,
  reconcileStoredWorkspaceSelection,
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
   * Viewer-scoped Workspace metadata already proven by an earlier successful
   * read. Only a complete, first-pass non-empty discovery replaces this set;
   * an error, partial/confirming answer, or phantom empty may never erase it
   * or reopen the Personal creation door.
   */
  knownWorkspaces?: readonly Community[];
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
  /**
   * Let a bounded caller accept discovery before any durable selection write.
   * The returned `commitSelection` must be awaited only after that caller's
   * timeout/generation gate succeeds.
   */
  deferSelectionPersistence?: boolean;
};

function mergeWorkspaceKnowledge(
  known: readonly Community[],
  discovered: readonly Community[],
): Community[] {
  const merged = new Map(known.map((workspace) => [workspace.communityId, workspace]));
  for (const workspace of discovered) {
    merged.set(workspace.communityId, {
      ...merged.get(workspace.communityId),
      ...workspace,
    });
  }
  return [...merged.values()];
}

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
  saveActiveId: (pubkey: string, workspaceId: string | null) => Promise<void>;
  savePersonalId: (pubkey: string, workspaceId: string) => Promise<void>;
  clearPersonalId: (pubkey: string) => Promise<void>;
};

/** One in-flight personal-Workspace creation per human key.
 *
 * Production evidence (captain's key, 2026-08-26): three distinct "Personal"
 * Workspaces were created 3–5 seconds apart, all signed by the phone's key,
 * because concurrent/abandoned bootstrap attempts each saw empty discovery
 * and each fell into the create fallback independently. Creation is the one
 * irreversible data door here, so concurrent and retried onboardings share a
 * single flight keyed by pubkey instead of racing.
 */
const personalCreationFlights = new Map<string, Promise<string>>();

/**
 * The durable cross-session identity of one human's Personal Workspace: a
 * UUID-shaped sha256 over (purpose domain ‖ pubkey). Because the relay's
 * kind:9007 create carries this exact id in `h`/`community`, every retry,
 * abandoned bootstrap, and second device converges on the SAME record — an
 * ambiguous create outcome is resolved by reading this coordinate back
 * (authoritative reconcile) instead of minting another Workspace. This is
 * the invariant carrier itself, not a parallel checker: creation goes
 * through `createCommunity(..., { communityId })` with THIS value.
 */
export function personalWorkspaceIdForPubkey(pubkey: string): string {
  const bytes = sha256(utf8ToBytes(`beeline-personal-workspace-v1:${pubkey}`));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 (name-based), UUID-shaped like the SDK's random ids
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createPersonalWorkspaceOnce(
  client: Pick<WorkspaceClient, 'createCommunity' | 'getCommunity'>,
  pubkey: string,
  storage: WorkspaceStorage,
): Promise<string> {
  const existingFlight = personalCreationFlights.get(pubkey);
  if (existingFlight) return existingFlight;
  const flight = (async () => {
    // A sibling attempt (or a previous session) may have completed between
    // this caller's discovery read and now: re-check the persisted id under
    // the flight before minting anything.
    const remembered = await storage.loadPersonalId(pubkey);
    if (remembered) return remembered;
    const deterministicId = personalWorkspaceIdForPubkey(pubkey);
    // Reconcile at the data door BEFORE creating: a prior create whose HTTP
    // response or storage save was lost has still published its record to
    // the relay under the deterministic coordinate. Reading it back adopts
    // that record; only an authoritative confirmed-absent answer may mint.
    const alreadyPublished = await client.getCommunity(deterministicId);
    if (alreadyPublished) {
      await storage.savePersonalId(pubkey, deterministicId);
      return deterministicId;
    }
    try {
      await client.createCommunity(PERSONAL_WORKSPACE_NAME, { communityId: deterministicId });
    } catch (err) {
      // The publish may have landed even though the call rejected (response
      // loss). One reconcile read decides adoption vs. genuine failure — it
      // never republishes a second create on top of a possible first.
      const landed = await client.getCommunity(deterministicId).catch(() => null);
      if (!landed) throw err;
    }
    await storage.savePersonalId(pubkey, deterministicId);
    return deterministicId;
  })();
  personalCreationFlights.set(pubkey, flight);
  flight.catch(() => undefined); // failures release the door below; nothing swallows them for callers joining this flight
  const clear = () => {
    if (personalCreationFlights.get(pubkey) === flight) personalCreationFlights.delete(pubkey);
  };
  flight.then(clear, clear);
  return flight;
}

const defaultStorage: WorkspaceStorage = {
  loadActiveId: loadActiveCommunityId,
  loadPersonalId: loadPersonalCommunityId,
  saveActiveId: saveActiveCommunityId,
  savePersonalId: savePersonalCommunityId,
  clearPersonalId: clearPersonalCommunityId,
};

export type WorkspaceContext = {
  workspaces: Community[];
  activeWorkspaceId: string;
  personalWorkspaceId: string | null;
  /** Only a complete, first-pass non-empty discovery may replace cached knowledge. */
  cacheReconciliation?: 'authoritative' | 'preserve';
  /** Present only when the caller requested a post-timeout-gate commit. */
  commitSelection?: () => Promise<void>;
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
  const knownWorkspaces = options.knownWorkspaces ?? [];
  let discoveredWorkspaces: Community[];
  let discoveryFailed = false;
  let cacheReconciliation: WorkspaceContext['cacheReconciliation'] = 'preserve';
  try {
    discoveredWorkspaces = await client.listCommunities(pubkey, predecessors);
    if (discoveredWorkspaces.length > 0) cacheReconciliation = 'authoritative';
    // Persist any verdict learned during THIS pass (migration + membership
    // repair both record them) so the next launch skips those rooms instantly.
    verdicts.persist(pubkey);
  } catch (error) {
    if (knownWorkspaces.length === 0) throw error;
    discoveryFailed = true;
    discoveredWorkspaces = [];
  }
  const storedWorkspaceId = await storage.loadActiveId(pubkey);
  const storedPersonalWorkspaceId = await storage.loadPersonalId(pubkey);
  let personalWorkspaceId = storedPersonalWorkspaceId;

  // A single empty answer is NOT authoritative absence. Production evidence:
  // a transient discovery miss took this function straight into the creation
  // fallback and minted junk "Personal" Workspaces signed by the human's own
  // key (three within eight seconds across retries). Discovery may only
  // create after a second consecutive confirmed-empty answer; anything else
  // (throw, timeout, or a partial answer confirmed non-empty) preserves local
  // knowledge and never authorizes cache eviction.
  if (!discoveryFailed && discoveredWorkspaces.length === 0) {
    try {
      const confirmation = await client.listCommunities(pubkey, predecessors);
      if (confirmation.length > 0) discoveredWorkspaces = confirmation;
    } catch (error) {
      if (knownWorkspaces.length === 0) throw error;
    }
  }

  let workspaces =
    cacheReconciliation === 'authoritative'
      ? [...discoveredWorkspaces]
      : mergeWorkspaceKnowledge(knownWorkspaces, discoveredWorkspaces);
  if (
    cacheReconciliation === 'authoritative' &&
    personalWorkspaceId &&
    !workspaces.some((workspace) => workspace.communityId === personalWorkspaceId)
  ) {
    // The Personal record is no longer server-confirmed. Do not project its
    // stale identity back into the newly reconciled Room-deck cache or let a
    // later launch treat the deleted record as an unresolved Personal claim.
    personalWorkspaceId = null;
  }

  if (workspaces.length === 0 && storedWorkspaceId) {
    const storedWorkspace = await client.getCommunity(storedWorkspaceId);
    if (!storedWorkspace) {
      throw new Error(
        `Remembered active ${WORKSPACE_LABEL} could not be loaded yet; retry instead of creating a Personal ${WORKSPACE_LABEL}.`,
      );
    }
    workspaces = [storedWorkspace];
  }

  if (workspaces.length === 0) {
    let personalWorkspace = personalWorkspaceId
      ? await client.getCommunity(personalWorkspaceId)
      : null;

    if (!personalWorkspace && personalWorkspaceId) {
      // The key already owns a remembered Personal Workspace that cannot be
      // loaded right now. That state is UNKNOWN, never absent — a partial or
      // lagging relay read looks identical to a deleted Workspace — so the
      // only safe move is to fail loudly and let the caller retry. Creating
      // here is exactly how the junk duplicates were minted.
      throw new Error(
        `Remembered Personal ${WORKSPACE_LABEL} could not be loaded yet; retry instead of creating a duplicate.`,
      );
    }

    if (!personalWorkspace) {
      personalWorkspaceId = await createPersonalWorkspaceOnce(client, pubkey, storage);
    }

    const personalId = personalWorkspaceId;
    if (!personalId) throw new Error(`Personal ${WORKSPACE_LABEL} could not be created.`);

    await client.waitUntilMember(personalId, pubkey);
    workspaces = mergeWorkspaceKnowledge(
      knownWorkspaces,
      await client.listCommunities(pubkey, predecessors),
    );

    if (!workspaces.some((workspace) => workspace.communityId === personalId)) {
      personalWorkspace = await client.getCommunity(personalId);
      if (!personalWorkspace) {
        throw new Error(`Personal ${WORKSPACE_LABEL} was created but could not be loaded.`);
      }
      workspaces = [personalWorkspace];
    }
  }

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

  let selectionCommitted = false;
  const commitSelection = async (): Promise<void> => {
    if (selectionCommitted) return;
    personalWorkspaceId = await reconcileStoredWorkspaceSelection(
      pubkey,
      workspaces,
      activeWorkspaceId,
      cacheReconciliation === 'authoritative'
        ? storedPersonalWorkspaceId
        : personalWorkspaceId,
      storage,
      cacheReconciliation,
    );
    selectionCommitted = true;
  };
  if (options.deferSelectionPersistence) {
    return {
      workspaces,
      activeWorkspaceId,
      personalWorkspaceId,
      cacheReconciliation,
      commitSelection,
    };
  }
  await commitSelection();
  return { workspaces, activeWorkspaceId, personalWorkspaceId, cacheReconciliation };
}
