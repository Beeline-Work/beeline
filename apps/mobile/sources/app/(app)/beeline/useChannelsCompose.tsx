import { appErrorCopy } from '@/buzz/app-error-copy';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { deckLanding } from '@/buzz/deck-landing';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import { type RoomDeckComposeAction } from '@/components/buzz/RoomDeckComposeMenu';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatListView } from '@beeline/buzz-client';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect } from 'react';

type Props = [
  confirmedWorkspaceCount: number | null,
  error: string | null,
  chatList: ChatListView | null,
  transport: BuzzRigTransport,
  activeCommunityId: string,
  pairingBusy: boolean,
  viewerIsAgent: boolean,
  setAgentConnectVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setPairCommand: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setPairingError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setPairingBusy: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  canManageWorkspace: boolean,
  setMemberPickerVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setShowCreateRoom: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
];
export function useChannelsCompose([
  confirmedWorkspaceCount, error, chatList, transport, activeCommunityId, pairingBusy,
  viewerIsAgent, setAgentConnectVisible, setPairCommand, setPairingError, setPairingBusy,
  canManageWorkspace, setMemberPickerVisible, setShowCreateRoom,
]: Props): [
  landing: import("@/buzz/deck-landing").DeckLanding,
  closeAgentConnect: () => void,
  connectAgent: () => Promise<void>,
  copyPairCommand: (command: string) => Promise<void>,
  compose: (action: RoomDeckComposeAction) => void,
] {


  const landing = deckLanding({
    workspaces:
      confirmedWorkspaceCount !== null
        ? { status: 'ready', count: confirmedWorkspaceCount }
        : error
          ? { status: 'failed' }
          : { status: 'pending' },
    chats: chatList ? 'ready' : error ? 'failed' : 'pending',
  });
  const noWorkspace = landing.kind === 'choice';
  useEffect(() => {
    if (noWorkspace) router.replace('/beeline/community');
  }, [noWorkspace]);

  const connectAgent = useCallback(async () => {
    if (!transport || !activeCommunityId || pairingBusy || viewerIsAgent) return;
    setAgentConnectVisible(true);
    setPairCommand(null);
    setPairingError(null);
    setPairingBusy(true);
    try {
      const pairing = await (
        await transport.ensureClient()
      ).createAgentPairingCode(activeCommunityId);
      setPairCommand(agentPairingCommand(pairing.code));
    } catch (reason) {
      setPairingError(appErrorCopy(reason, `Could not create agent invite.`));
    } finally {
      setPairingBusy(false);
    }
  }, [activeCommunityId, pairingBusy, transport, viewerIsAgent]);

  const closeAgentConnect = useCallback(() => {
    setAgentConnectVisible(false);
    setPairCommand(null);
    setPairingError(null);
  }, []);

  const copyPairCommand = useCallback(async (command: string) => {
    await (await import('expo-clipboard')).setStringAsync(command);
  }, []);

  const compose = useCallback(
    (action: RoomDeckComposeAction) => {
      if (!canManageWorkspace && (action === 'room' || action === 'invite')) return;
      runRoomDeckComposeAction(action, {
        communityId: activeCommunityId,
        openMessagePicker: () => setMemberPickerVisible(true),
        openRoomCreator: () => setShowCreateRoom(true),
        invitePerson: () =>
          router.push({
            pathname: '/beeline/members',
            params: {
              ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
              action: 'invite',
            },
          } as never),
        navigate: (target) => router.push(target as Href),
      });
    },
    [activeCommunityId, canManageWorkspace],
  );
return [
    landing, closeAgentConnect, connectAgent, copyPairCommand, compose,
  ];
}
