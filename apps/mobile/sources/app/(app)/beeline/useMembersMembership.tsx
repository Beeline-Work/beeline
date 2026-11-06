import { presentPersonInvite } from '@/components/buzz/PersonInviteSheet';
import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect } from 'react';
import { router } from 'expo-router';
import { type AgentDetailView, type Identity, type WorkspaceView } from '@beeline/buzz-client';
import { createCommunityInviteUrl, resolveCommunityInvitePublicOrigin } from '@/buzz/community-invite';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { BuzzRigTransport } from '@/sync/transport';
import { workspacePage } from '@/buzz/workspace-records';
import { MembersAction } from './members';

type Props = [
  surface: WorkspaceView | null,
  workspaceId: string | undefined,
  relayUrl: string | null,
  setWorking: React.Dispatch<React.SetStateAction<MembersAction | null>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  writeClient: () => Promise<import("@beeline/buzz-client").BuzzClient & { refreshAgentModelCatalog(workspaceId: string, agentId: string): Promise<unknown>; }>,
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setSelectedAgent: (value: AgentDetailView | null) => void,
  setPairCommand: React.Dispatch<React.SetStateAction<string | null>>,
  focused: boolean,
  requestedActionHandledRef: React.RefObject<boolean>,
  requestedAction: string | undefined,
  identity: Identity | null,
  memberQuery: string,
  setRosterQuery: React.Dispatch<React.SetStateAction<string>>,
  setRosterLoading: React.Dispatch<React.SetStateAction<boolean>>,
  readMemberPage: (input: { q?: string; kind?: "human" | "agent"; offset?: number; }) => Promise<{ query: string; stamp: number; viewer?: import("@beeline/api-contract/phone").RoomViewer; members: readonly import("@beeline/api-contract/phone").RoomViewMember[]; agents: readonly import("@beeline/api-contract/phone").WorkspaceAgentView[]; grants?: readonly import("@beeline/api-contract/phone").WorkspaceMemberGrantView[]; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; }>,
  applyMemberPage: (page: Awaited<ReturnType<(input: { q?: string; kind?: "human" | "agent"; offset?: number; }) => Promise<{ query: string; stamp: number; viewer?: import("@beeline/api-contract/phone").RoomViewer; members: readonly import("@beeline/api-contract/phone").RoomViewMember[]; agents: readonly import("@beeline/api-contract/phone").WorkspaceAgentView[]; grants?: readonly import("@beeline/api-contract/phone").WorkspaceMemberGrantView[]; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; }>>>, kind: "human" | "agent" | undefined, append: boolean) => void,
  rosterLoading: boolean,
  recordScope: string | null,
];
export function useMembersMembership([
  surface, workspaceId, relayUrl, setWorking, setError, writeClient, setPickerOpen,
  setSelectedAgent, setPairCommand, focused, requestedActionHandledRef, requestedAction, identity,
  memberQuery, setRosterQuery, setRosterLoading, readMemberPage, applyMemberPage, rosterLoading,
  recordScope,
]: Props): [
  messagePerson: (pubkey: string) => Promise<void>,
  invitePerson: () => Promise<void>,
  loadMoreMembers: (kind: "human" | "agent") => Promise<void>,
  connectAgent: () => Promise<void>,
  closePicker: () => void,
] {


  const invitePerson = async () => {
    if (!surface?.viewer.permissions.manage || !workspaceId || !relayUrl) return;
    setWorking('invite-person');
    setError(null);
    try {
      const publicInviteOrigin = resolveCommunityInvitePublicOrigin(getBuzzRuntimeConfig());
      const url = await createCommunityInviteUrl(
        await writeClient(),
        workspaceId,
        publicInviteOrigin,
      );
      await presentPersonInvite(url);
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not create person invite.`));
    } finally {
      setWorking(null);
    }
  };

  /**
   * Connecting a NEW agent: the app-minted code is the complete authorization
   * for the public connect wizard, shown inside the agent-only sheet.
   */
  const connectAgent = async () => {
    if (!surface || !workspaceId) return;
    setPickerOpen(true);
    setSelectedAgent(null);
    setPairCommand(null);
    setError(null);
    setWorking('pair-agent');
    try {
      const pairing = await (await writeClient()).createAgentPairingCode(workspaceId);
      setPairCommand(agentPairingCommand(pairing.code));
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not create agent invite.`));
    } finally {
      setWorking(null);
    }
  };

  const closePicker = () => {
    setPickerOpen(false);
    setPairCommand(null);
  };

  useEffect(() => {
    if (!focused || !surface || requestedActionHandledRef.current) return;
    if (requestedAction === 'invite') {
      if (!surface.viewer.permissions.manage) return;
      requestedActionHandledRef.current = true;
      void invitePerson();
    } else if (requestedAction === 'add-agent') {
      requestedActionHandledRef.current = true;
      void connectAgent();
    }
    // The route intent is consume-once. The handlers intentionally read the
    // current authenticated surface at that moment rather than reopening on
    // every indexed refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, requestedAction, surface]);

  useEffect(() => {
    if ((!focused) || !identity || !relayUrl || !workspaceId) return;
    const q = memberQuery.trim();
    if (!q) {
      setRosterQuery('');
      return;
    }
    let cancelled = false;
    setRosterLoading(true);
    void readMemberPage({ q })
      .then((page) => {
        if (!cancelled) applyMemberPage(page, undefined, false);
      })
      .catch((reason) => {
        if (!cancelled) setError(appErrorCopy(reason, `Could not search members.`));
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Search is a dedicated server read; identity/relay are the auth it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, memberQuery, identity, relayUrl, workspaceId]);

  const loadMoreMembers = async (kind: 'human' | 'agent') => {
    if (!surface || rosterLoading) return;

    const q = memberQuery.trim();
    const page = workspacePage(recordScope, q);
    setRosterLoading(true);
    setError(null);
    try {
      const next = await readMemberPage({
        kind,
        offset: kind === 'human' ? (page.people?.ids.length ?? 0) : (page.agents?.ids.length ?? 0),
        ...(q ? { q } : {}),
      });
      applyMemberPage(next, kind, true);
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not load more members.`));
    } finally {
      setRosterLoading(false);
    }
  };

  const messagePerson = async (pubkey: string) => {
    if (!identity || !workspaceId || pubkey === identity.publicKey) return;
    setWorking('message-person');
    setError(null);
    try {
      const room = await new BuzzRigTransport(identity).resolveDirectMessage(workspaceId, pubkey);
      navigateToRoom(router, room.channelId);
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not open message.`));
    } finally {
      setWorking(null);
    }
  };
return [
    messagePerson, invitePerson, loadMoreMembers, connectAgent, closePicker,
  ];
}
