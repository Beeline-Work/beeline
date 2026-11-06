import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect } from 'react';
import { router } from 'expo-router';
import { isAgentDetailView, isWorkspaceView, type AgentDetailView, type Identity } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { recordWorkspacePage } from '@/buzz/workspace-records';
import { watchWorkspace } from '@/buzz/workspace-watch';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { ModelAxisKind } from './members';

type Props = [
  identity: Identity | null,
  relayUrl: string | null,
  recordScope: string | null,
  setRosterQuery: React.Dispatch<React.SetStateAction<string>>,
  workspaceId: string | undefined,
  focused: boolean,
  profileAgentId: string | undefined,
  setIdentity: React.Dispatch<React.SetStateAction<Identity | null>>,
  setRelayUrl: React.Dispatch<React.SetStateAction<string | null>>,
  focusedRef: React.RefObject<boolean>,
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>,
  readWorkspaceRef: React.RefObject<(() => Promise<void>) | null>,
  agentRequestGenerationRef: React.RefObject<number>,
  retryGeneration: number,
  setSelectedAgent: (value: AgentDetailView | null) => void,
  setEditingAgentSoul: React.Dispatch<React.SetStateAction<boolean>>,
  setOpenModelAxis: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  setModelAppliesNote: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  setYoloError: React.Dispatch<React.SetStateAction<string | null>>,
  setAccessError: React.Dispatch<React.SetStateAction<string | null>>,
  setLocalAgentId: React.Dispatch<React.SetStateAction<string | null>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  profileRetryGeneration: number,
];
export function useMembersReads([
  identity, relayUrl, recordScope, setRosterQuery, workspaceId, focused, profileAgentId,
  setIdentity, setRelayUrl, focusedRef, setWorkspaceError, readWorkspaceRef,
  agentRequestGenerationRef, retryGeneration, setSelectedAgent, setEditingAgentSoul,
  setOpenModelAxis, setModelAppliesNote, setYoloError, setAccessError, setLocalAgentId, setError,
  profileRetryGeneration,
]: Props): [
  writeClient: () => Promise<import("@beeline/buzz-client").BuzzClient & { refreshAgentModelCatalog(workspaceId: string, agentId: string): Promise<unknown>; }>,
  readMemberPage: (input: { q?: string; kind?: "human" | "agent"; offset?: number; }) => Promise<{ query: string; stamp: number; viewer?: import("@beeline/api-contract/phone").RoomViewer; members: readonly import("@beeline/api-contract/phone").RoomViewMember[]; agents: readonly import("@beeline/api-contract/phone").WorkspaceAgentView[]; grants?: readonly import("@beeline/api-contract/phone").WorkspaceMemberGrantView[]; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; }>,
  applyMemberPage: (page: Awaited<ReturnType<(input: { q?: string; kind?: "human" | "agent"; offset?: number; }) => Promise<{ query: string; stamp: number; viewer?: import("@beeline/api-contract/phone").RoomViewer; members: readonly import("@beeline/api-contract/phone").RoomViewMember[]; agents: readonly import("@beeline/api-contract/phone").WorkspaceAgentView[]; grants?: readonly import("@beeline/api-contract/phone").WorkspaceMemberGrantView[]; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; }>>>, kind: "human" | "agent" | undefined, append: boolean) => void,
  closeAgentSettings: () => void,
] {


  const writeClient = async () => {
    if (!identity || !relayUrl) throw new Error('Workspace connection unavailable');
    const client = await new BuzzRigTransport(identity).ensureClient();
    return client as typeof client & {
      refreshAgentModelCatalog(workspaceId: string, agentId: string): Promise<unknown>;
    };
  };

  const applyMemberPage = (
    page: Awaited<ReturnType<typeof readMemberPage>>,
    kind: 'human' | 'agent' | undefined,
    append: boolean,
  ) => {
    if (recordScope)
      recordWorkspacePage(recordScope, page, {
        query: page.query,
        kind,
        append,
        stamp: page.stamp,
      });
    setRosterQuery(page.query);
  };

  const readMemberPage = async (input: {
    q?: string;
    kind?: 'human' | 'agent';
    offset?: number;
  }) => {
    if (!identity || !relayUrl || !workspaceId) throw new Error('Workspace connection unavailable');
    // A removal or receipt recorded while this page is in flight is newer than it.
    const stamp = currentSurfaceStamp();
    const page = await new RoomViewClient({ baseUrl: relayUrl, identity }).workspaceMembers(
      workspaceId,
      input,
    );
    return { ...page, query: input.q ?? '', stamp };
  };

  useEffect(() => {
    if (!focused || !workspaceId) return;
    let cancelled = false;
    let stopWatch: (() => void) | undefined;
    let readWorkspace: (() => Promise<void>) | undefined;
    void (async () => {
      const [nextIdentity, nextRelayUrl] = await Promise.all([
        loadBuzzIdentity(),
        getEffectiveRelayUrl(),
      ]);
      if (!nextIdentity) {
        router.replace('/beeline/onboarding');
        return;
      }
      const address = surfaceAddress(nextRelayUrl, nextIdentity.publicKey, '/workspace/:id', {
        workspaceId,
      });
      const cached = await mobileSurfaceCache.read(address, isWorkspaceView);
      if (cancelled) return;
      if ((profileAgentId && !cached)) {
        // A direct profile open needs both authority and detail, but one wire
        // response writes the two existing keyed entries for later visits.
        const profile = await monolithPhoneOperation('readAgentProfile', {
          workspaceId,
          agentId: profileAgentId,
        });
        if (cancelled) return;
        await Promise.all([
          mobileSurfaceCache.write(address, profile.workspace, isWorkspaceView),
          mobileSurfaceCache.write(
            surfaceAddress(nextRelayUrl, nextIdentity.publicKey, '/workspace/:id/agents/:agentId', {
              workspaceId,
              agentPubkey: profileAgentId,
            }),
            profile.agent,
            isAgentDetailView,
          ),
        ]);
      }
      if (cancelled) return;
      setIdentity((current) =>
        current?.publicKey === nextIdentity.publicKey ? current : nextIdentity,
      );
      setRelayUrl(nextRelayUrl);

      // Every Members instance (the list under an agent profile included)
      // paints the one shared entry; rows and totals read the shared records,
      // which hear every write of this entry.
      const http = new RoomViewClient({ baseUrl: nextRelayUrl, identity: nextIdentity });
      readWorkspace = async () => {
        if (cancelled) return;
        try {
          if (!focusedRef.current) return;
          const value = await mobileSurfaceCache.fetch(address, isWorkspaceView, () =>
            http.workspace(workspaceId),
          );
          if (cancelled) return;

          // Null: a newer write or an eviction overtook the read; the entry
          // listener already painted whatever is current.
          if (!value) return;
          setWorkspaceError(null);
        } catch (reason) {
          if (!cancelled) setWorkspaceError(appErrorCopy(reason));
        }
      };
      readWorkspaceRef.current = readWorkspace;
      const watch = watchWorkspace(
        nextIdentity,
        nextRelayUrl,
        workspaceId,
        () => void readWorkspace?.(),
        (reason) => setWorkspaceError(appErrorCopy(reason)),
      );
      stopWatch = watch.release;
      await watch.ready;
      if (cancelled) return;
      if ((!profileAgentId)) await readWorkspace();
    })().catch((reason) => {
      if (!cancelled) setWorkspaceError(appErrorCopy(reason));
    });
    return () => {
      cancelled = true;
      agentRequestGenerationRef.current += 1;
      stopWatch?.();
      readWorkspaceRef.current = null;
      setRosterQuery('');
    };
  }, [focused, retryGeneration, workspaceId, profileAgentId]);

  const closeAgentSettings = () => {
    agentRequestGenerationRef.current += 1;
    setSelectedAgent(null);
    setEditingAgentSoul(false);
    setOpenModelAxis(null);
    setModelAppliesNote(null);
    setYoloError(null);
    setAccessError(null);
  };

  const openAgent = async (agentPubkey: string) => {
    if (!identity || !relayUrl || !workspaceId) return;
    const generation = ++agentRequestGenerationRef.current;
    setLocalAgentId(agentPubkey);
    setOpenModelAxis(null);
    setModelAppliesNote(null);
    setEditingAgentSoul(false);
    setError(null);
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
      workspaceId,
      agentPubkey,
    });
    // A cached profile shows at once; the server read below still replaces it.
    const cached = await mobileSurfaceCache.read(address, isAgentDetailView).catch(() => undefined);
    try {
      if (generation !== agentRequestGenerationRef.current) return;
      const value = await new RoomViewClient({ baseUrl: relayUrl, identity }).agent(
        workspaceId,
        agentPubkey,
      );
      if (generation !== agentRequestGenerationRef.current) return;
      await mobileSurfaceCache.write(address, value, isAgentDetailView);
    } catch (reason) {
      // Keep a readable cached profile rather than replacing it with an error.
      if (generation === agentRequestGenerationRef.current && (!cached || profileRetryGeneration > 0))
        setError(appErrorCopy(reason));
    }
  };

  useEffect(() => {
    if ((!focused) || !profileAgentId || !identity || !relayUrl || !workspaceId) return;
    void openAgent(profileAgentId);
    return () => {
      agentRequestGenerationRef.current += 1;
    };
  }, [focused, profileAgentId, identity, relayUrl, workspaceId, profileRetryGeneration]);
return [
    writeClient, readMemberPage, applyMemberPage, closeAgentSettings,
  ];
}
