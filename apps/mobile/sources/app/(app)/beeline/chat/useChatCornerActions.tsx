import React, { useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { fallbackMemberHandle, fallbackMemberName } from '@/buzz/member-display';
import { cornerHref } from '@/buzz/corner-navigation';
import { formatForwardedMessage } from '@/buzz/message-forward';
import { newCornerOpenAttempt, openRandomNamedCorner, type CornerOpenAttempt } from '@/buzz/open-random-corner';
import { alertCornerOpenFailure } from '@/buzz/room-list-new-corner';
import { cornerOpenTappedAgain } from '@/buzz/corner-open-status';
import { forwardMessageToNewCorner } from '@/buzz/message-corner-forward';

type Props = [
  canRenameTitle: boolean,
  renameTextDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  storedRoomName: string,
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>,
  setRenameEditing: React.Dispatch<React.SetStateAction<boolean>>,
  isCorner: boolean,
  setRoomActionsVisible: (visible: boolean) => void | undefined,
  openingRandomCorner: boolean,
  isArchived: boolean,
  viewerIsAgent: boolean,
  transport: BuzzRigTransport | null,
  setOpeningRandomCorner: React.Dispatch<React.SetStateAction<boolean>>,
  parentChannelId: string | undefined,
  decodedId: string,
  desktopExperience: boolean,
  openDesktopCorner: (roomId: string, cornerId: string) => void,
  setForwardCornerPrompt: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>,
  forwardCornerPrompt: ChatDisplayMessage | null,
  displayRoomName: string,
];

export function useChatCornerActions([
  canRenameTitle, renameTextDraft, storedRoomName, setRenameError, setRenameEditing, isCorner,
  setRoomActionsVisible, openingRandomCorner, isArchived, viewerIsAgent, transport,
  setOpeningRandomCorner, parentChannelId, decodedId, desktopExperience, openDesktopCorner,
  setForwardCornerPrompt, forwardCornerPrompt, displayRoomName,
]: Props): [
  startRenameFromTitle: () => void,
  handleForwardToNewCorner: (message: ChatDisplayMessage) => void,
  handleOpenRandomCorner: (attempt?: CornerOpenAttempt) => Promise<void>,
  confirmForwardToNewCorner: (retry?: { target: ChatDisplayMessage; attempt: CornerOpenAttempt; }) => Promise<void>,
] {


  const startRenameFromTitle = useCallback(() => {
    if (!canRenameTitle) return;
    renameTextDraft.initialize(storedRoomName);
    setRenameError(null);
    setRenameEditing(true);
    if (!isCorner) setRoomActionsVisible(true);
  }, [canRenameTitle, isCorner, storedRoomName, renameTextDraft]);


  const handleOpenRandomCorner = useCallback(async (attempt?: CornerOpenAttempt) => {
    if (openingRandomCorner) return cornerOpenTappedAgain();
    if (isArchived || viewerIsAgent) return;
    if (!transport) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Modal.alert(
        `Could not open ${CORNER_LABEL}`,
        `A new ${CORNER_LABEL} could not be opened while Rooms are loading. Try again.`,
      );
      return;
    }
    setOpeningRandomCorner(true);
    const current = attempt ?? newCornerOpenAttempt();
    try {
      await openRandomNamedCorner({
        attempt: current,
        createCorner: (roomId, title, cornerId) =>
          transport.createHumanCorner(roomId, title, undefined, true, cornerId),
        // Inside a corner the new corner is a sibling under the parent Room.
        roomId: parentChannelId ?? decodedId,
        openCorner: (cornerId, title) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (desktopExperience) openDesktopCorner(parentChannelId ?? decodedId, cornerId);
          else router.push(cornerHref(cornerId, parentChannelId ?? decodedId, title));
        },
      });
    } catch (err) {
      alertCornerOpenFailure(err, parentChannelId ?? decodedId, () => void handleOpenRandomCorner(current));
    } finally {
      setOpeningRandomCorner(false);
    }
  }, [
    decodedId,
    desktopExperience,
    isArchived,
    openDesktopCorner,
    openingRandomCorner,
    parentChannelId,
    transport,
    viewerIsAgent,
  ]);


  /**
   * Mobile swipe-right asks first, through the shared bottom sheet — the same
   * presentation Room creation uses. The sheet holds the message while it is
   * open; declining creates nothing.
   */
  const handleForwardToNewCorner = useCallback(
    (message: ChatDisplayMessage) => {
      if (openingRandomCorner || isArchived || viewerIsAgent || desktopExperience) return;
      if (!transport) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Modal.alert(
          `Could not open ${CORNER_LABEL}`,
          `A new ${CORNER_LABEL} could not be opened while Rooms are loading. Try again.`,
        );
        return;
      }
      void Haptics.selectionAsync();
      setForwardCornerPrompt(message);
    },
    [desktopExperience, isArchived, openingRandomCorner, transport, viewerIsAgent],
  );


  const confirmForwardToNewCorner = useCallback(async (
    retry?: { target: ChatDisplayMessage; attempt: CornerOpenAttempt },
  ) => {
    const target = retry?.target ?? forwardCornerPrompt;
    if (!target) return;
    if (openingRandomCorner || isArchived || viewerIsAgent || desktopExperience) return;
    if (!transport) return;
    setForwardCornerPrompt(null);
    setOpeningRandomCorner(true);
    const attempt = retry?.attempt ?? newCornerOpenAttempt();
    try {
      await forwardMessageToNewCorner({
        attempt,
        confirm: async () => true,
        forwardText: formatForwardedMessage(
          target.text,
          displayRoomName,
          target.authorIdentity ?? {
            name: target.pubkey ? fallbackMemberName(target.pubkey) : 'SOMEONE',
            ...(target.pubkey ? { handle: fallbackMemberHandle(target.pubkey) } : {}),
          },
          { roomId: decodedId, messageId: target.relayId ?? target.id },
        ),
        sourceMessageId: target.relayId ?? target.id,
        createCorner: (roomId, title, sourceMessageId, cornerId) =>
          transport.createHumanCorner(roomId, title, sourceMessageId, true, cornerId),
        // Inside a corner the new corner is a sibling under the parent Room.
        roomId: parentChannelId ?? decodedId,
        openCorner: (cornerId, title) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (desktopExperience) openDesktopCorner(parentChannelId ?? decodedId, cornerId);
          else router.push(cornerHref(cornerId, parentChannelId ?? decodedId, title));
        },
      });
    } catch (err) {
      alertCornerOpenFailure(
        err,
        parentChannelId ?? decodedId,
        () => void confirmForwardToNewCorner({ target, attempt }),
      );
    } finally {
      setOpeningRandomCorner(false);
    }
  }, [
    decodedId,
    desktopExperience,
    displayRoomName,
    forwardCornerPrompt,
    isArchived,
    openDesktopCorner,
    openingRandomCorner,
    parentChannelId,
    transport,
    viewerIsAgent,
  ]);
  return [
    startRenameFromTitle, handleForwardToNewCorner, handleOpenRandomCorner,
    confirmForwardToNewCorner,
  ];
}
