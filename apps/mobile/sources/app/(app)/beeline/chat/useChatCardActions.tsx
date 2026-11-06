import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { connectorOfferCeremonyRoute } from '@/buzz/connector-offer-ceremony';
import { type PollDraft } from '@/components/buzz/CreatePollSheet';

type Props = [
  transport: BuzzRigTransport | null,
  viewerIsAgent: boolean,
  cacheViewerPubkey: string,
  setPermissionActionId: React.Dispatch<React.SetStateAction<string | null>>,
  decodedId: string,
  grantActionId: string | null,
  setGrantActionId: React.Dispatch<React.SetStateAction<string | null>>,
  choiceActionId: string | null,
  setChoiceActionId: React.Dispatch<React.SetStateAction<string | null>>,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  focusComposer: () => void,
  readRoom: () => void,
  createPollBusy: boolean,
  setCreatePollBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setCreatePollVisible: React.Dispatch<React.SetStateAction<boolean>>,
  activeCommunityId: string | null,
  connectorOfferActionId: string | null,
  setConnectorOfferActionId: React.Dispatch<React.SetStateAction<string | null>>,
  targetBranchActionId: string | null,
  canManageWorkspace: boolean,
  setTargetBranchNotice: React.Dispatch<React.SetStateAction<{ proposalId: string; text: string; } | null>>,
  setTargetBranchActionId: React.Dispatch<React.SetStateAction<string | null>>,
  applyRoomRepositoryResult: (result: import("@beeline/api-contract/phone").RoomRepositoryResult) => void,
];

export function useChatCardActions([
  transport, viewerIsAgent, cacheViewerPubkey, setPermissionActionId, decodedId, grantActionId,
  setGrantActionId, choiceActionId, setChoiceActionId, roomSurface, focusComposer, readRoom,
  createPollBusy, setCreatePollBusy, setCreatePollVisible, activeCommunityId,
  connectorOfferActionId, setConnectorOfferActionId, targetBranchActionId, canManageWorkspace,
  setTargetBranchNotice, setTargetBranchActionId, applyRoomRepositoryResult,
]: Props): [
  handleWritePermission: (message: ChatDisplayMessage, decision: "allow" | "deny") => Promise<void>,
  handleConfirmTargetBranch: (message: ChatDisplayMessage) => Promise<void>,
  handleGrantDecision: (grantId: string, decision: "always" | "once" | "deny") => Promise<void>,
  handleChoiceAnswer: (choiceId: string, optionId: string, note?: string) => Promise<void>,
  handleChoiceSkip: (choiceId: string) => Promise<void>,
  handleAcceptConnectorOffer: (offerId: string, connectorType: string) => Promise<void>,
  continueConnectorOffer: (offerId: string, connectorType: string, pairedConnectorId: string, reconnect: boolean) => Promise<void>,
  openWorkbench: () => void,
  handleCreatePoll: (draft: PollDraft) => Promise<boolean>,
] {


  const handleWritePermission = useCallback(
    async (message: ChatDisplayMessage, decision: 'allow' | 'deny') => {
      const permission = message.writePermission;
      if (
        !transport ||
        !permission ||
        !permission.repository ||
        permission.status !== 'pending' ||
        viewerIsAgent ||
        (permission.purpose === 'squire-spending' && permission.ownerPubkey !== cacheViewerPubkey)
      )
        return;
      setPermissionActionId(permission.permissionId);
      try {
        await transport.respondToWritePermission(
          decodedId,
          permission.permissionId,
          permission.requestId,
          permission.agentPubkey,
          decision,
          permission.repository,
        );
        void Haptics.notificationAsync(
          decision === 'allow'
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
      } catch (err) {
        console.warn('Write permission response failed:', err);
      } finally {
        setPermissionActionId(null);
      }
    },
    [cacheViewerPubkey, decodedId, transport, viewerIsAgent],
  );


  /**
   * Answer a grant card. The server holds the authority (agent owner or a
   * Workspace manager, and the owner alone for a host MCP route) and refuses
   * anyone else; the card re-reads from the indexed Room, so nothing is
   * decided on the phone. A refusal leaves the card pending, so its reason is
   * shown: a visible control must act or explain itself.
   */
  const handleGrantDecision = useCallback(
    async (grantId: string, decision: 'always' | 'once' | 'deny') => {
      if (viewerIsAgent || grantActionId) return;
      setGrantActionId(grantId);
      try {
        await monolithPhoneOperation('decideAgentGrant', { grantId, decision });
        void Haptics.notificationAsync(
          decision === 'deny'
            ? Haptics.NotificationFeedbackType.Warning
            : Haptics.NotificationFeedbackType.Success,
        );
      } catch (err) {
        Modal.alert('Could not answer', phoneOperationFailureReason(err));
      } finally {
        setGrantActionId(null);
      }
    },
    [grantActionId, viewerIsAgent],
  );


  const handleChoiceAnswer = useCallback(
    async (choiceId: string, optionId: string, note?: string) => {
      if (viewerIsAgent || choiceActionId) return;
      setChoiceActionId(choiceId);
      try {
        await monolithPhoneOperation('answerChoice', {
          choiceId,
          optionId,
          ...(note ? { note } : {}),
        });
        const picked = roomSurface?.messages.find(message => message.choice?.choiceId === choiceId)?.choice;
        if (picked?.options.find(option => option.optionId === optionId)?.label === 'Something else') focusComposer();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        readRoom();
        console.warn('Choice answer failed:', err);
        Modal.alert('Could not answer', phoneOperationFailureReason(err));
      } finally {
        setChoiceActionId(null);
      }
    },
    [choiceActionId, viewerIsAgent, roomSurface, focusComposer],
  );


  const handleChoiceSkip = useCallback(
    async (choiceId: string) => {
      if (viewerIsAgent || choiceActionId) return;
      setChoiceActionId(choiceId);
      try {
        await monolithPhoneOperation('skipChoice', { choiceId });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch (err) {
        console.warn('Choice skip failed:', err);
        Modal.alert('Could not skip', phoneOperationFailureReason(err));
      } finally {
        setChoiceActionId(null);
      }
    },
    [choiceActionId, viewerIsAgent],
  );


  const handleCreatePoll = useCallback(
    async (draft: PollDraft) => {
      if (createPollBusy) return false;
      setCreatePollBusy(true);
      try {
        await monolithPhoneOperation('createRoomPoll', { roomId: decodedId, ...draft });
        setCreatePollVisible(false);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return true;
      } catch (err) {
        Modal.alert('Could not create poll', phoneOperationFailureReason(err));
        return false;
      } finally {
        setCreatePollBusy(false);
      }
    },
    [createPollBusy, decodedId],
  );


  const openConnectorOfferCeremony = useCallback(
    (offerId: string, connectorType: string, pairedConnectorId: string, roomId = decodedId, directSignIn = false) => {
      router.push(
        connectorOfferCeremonyRoute({
          workspaceId: activeCommunityId ?? '',
          viewerId: cacheViewerPubkey,
          roomId,
          offerId,
          connectorType,
          pairedConnectorId,
          directSignIn,
        }) as Href,
      );
    },
    [activeCommunityId, cacheViewerPubkey, decodedId],
  );


  const continueConnectorOffer = useCallback(
    async (offerId: string, connectorType: string, pairedConnectorId: string, reconnect: boolean) => {
      try {
        if (reconnect) await monolithPhoneOperation('acceptConnectorOffer', { offerId });
        openConnectorOfferCeremony(offerId, connectorType, pairedConnectorId, decodedId, reconnect);
      } catch (err) {
        Modal.alert('Could not open sign-in', phoneOperationFailureReason(err));
      }
    },
    [openConnectorOfferCeremony, decodedId],
  );


  /**
   * Start a connector-offer ceremony. The server holds the authority, pairs
   * the offering helper, and returns its row; the phone immediately routes
   * that row through the existing Workbench install + sign-in screens. The
   * card and paused agent settle only when the helper reports connected.
   */
  const handleAcceptConnectorOffer = useCallback(
    async (offerId: string, connectorType: string) => {
      if (viewerIsAgent || connectorOfferActionId) return;
      setConnectorOfferActionId(offerId);
      try {
        const accepted = await monolithPhoneOperation('acceptConnectorOffer', { offerId });
        // A wallet offer settles in the acceptance itself: there is no
        // install or sign-in ceremony to open.
        if (accepted.status !== 'accepted') {
          openConnectorOfferCeremony(offerId, connectorType, accepted.connectorId, accepted.roomId);
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        Modal.alert('Could not connect', phoneOperationFailureReason(err));
      } finally {
        setConnectorOfferActionId(null);
      }
    },
    [connectorOfferActionId, openConnectorOfferCeremony, viewerIsAgent],
  );


  /** The settled offer card's door to the Workbench page (Q3: one of its three remaining paths). */
  const openWorkbench = useCallback(() => {
    router.push({
      pathname: '/beeline/settings/workbench',
      params: {
        ...(activeCommunityId ? { workspaceId: activeCommunityId } : {}),
        ...(cacheViewerPubkey ? { viewerId: cacheViewerPubkey } : {}),
      },
    } as Href);
  }, [activeCommunityId, cacheViewerPubkey]);


  /**
   * Confirm a proposed target-branch change.
   *
   * The republished Room→repository event is signed by THIS viewer, so a
   * non-admin is refused here with a plain sentence rather than being allowed
   * to publish an event every reader would silently ignore. The SDK
   * (`setRoomTargetBranch`) and every reader re-check the role independently —
   * this guard is the clear answer, not the boundary.
   */
  const handleConfirmTargetBranch = useCallback(
    async (message: ChatDisplayMessage) => {
      const proposal = message.targetBranchProposal;
      if (!transport || !proposal || targetBranchActionId) return;
      if (viewerIsAgent || !canManageWorkspace) {
        setTargetBranchNotice({
          proposalId: proposal.proposalId,
          text: 'Only a workspace manager can change the target branch.',
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }
      setTargetBranchActionId(proposal.proposalId);
      setTargetBranchNotice(null);
      try {
        const result = await transport.roomTargetBranchSet(decodedId, proposal.to);
        applyRoomRepositoryResult(result);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        setTargetBranchNotice({
          proposalId: proposal.proposalId,
          text: appErrorCopy(err),
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setTargetBranchActionId(null);
      }
    },
    [applyRoomRepositoryResult, canManageWorkspace, decodedId, targetBranchActionId, transport, viewerIsAgent],
  );
  return [
    handleWritePermission, handleConfirmTargetBranch, handleGrantDecision, handleChoiceAnswer,
    handleChoiceSkip, handleAcceptConnectorOffer, continueConnectorOffer, openWorkbench,
    handleCreatePoll,
  ];
}
