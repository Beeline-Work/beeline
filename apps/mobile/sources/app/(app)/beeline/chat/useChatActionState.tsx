import { focusComposerSelection } from '@/buzz/composer-selection';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { View, TextInput, Platform } from 'react-native';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { activeMentionAtCursor } from '@/buzz/room-participants';
import { type OwnerGrantNeeded } from '@/components/buzz/OwnerGrantNeededCard';
import { type RoomActionsSheetHandle } from '@/components/buzz/RoomRepositoryChoice';
import { takeCornerComposerDraft } from '@/buzz/message-corner-forward';

type Props = [
  decodedId: string,
  userPubkey: string,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  inputTextRef: React.RefObject<string>,
  inputText: string,
  setDesktopDeliveryState: React.Dispatch<React.SetStateAction<"failed" | "sending" | "delivered" | null>>,
  setInputText: (update: string | ((previous: string) => string)) => void,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  setDismissedMentionKey: React.Dispatch<React.SetStateAction<string | null>>,
  composerRef: React.RefObject<TextInput | null>,
];

export function useChatActionState([
  decodedId, userPubkey, roomSurface, inputTextRef, inputText, setDesktopDeliveryState,
  setInputText, setInputSelection, setDismissedMentionKey, composerRef,
]: Props): [
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>,
  isDirectMessage: boolean,
  participantPickerVisible: boolean,
  rosterVisible: boolean,
  roomRepoAccessIssue: { fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null,
  setCornerOpenRepoPrompt: React.Dispatch<React.SetStateAction<boolean>>,
  participantPickerKind: "agent" | "person" | null,
  composerFocused: boolean,
  directMessage: import("@beeline/api-contract/phone").RoomDirectMessageView | null,
  agentPairBusy: boolean,
  setAgentConnectVisible: React.Dispatch<React.SetStateAction<boolean>>,
  setAgentPairCommand: React.Dispatch<React.SetStateAction<string | null>>,
  setAgentPairError: React.Dispatch<React.SetStateAction<string | null>>,
  setAgentPairBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setParticipantPickerKind: React.Dispatch<React.SetStateAction<"agent" | "person" | null>>,
  setParticipantPickerVisible: React.Dispatch<React.SetStateAction<boolean>>,
  targetBranchActionId: string | null,
  pendingAck: { sentAt: number; requestId?: string; } | null,
  setPendingAck: React.Dispatch<React.SetStateAction<{ sentAt: number; requestId?: string; } | null>>,
  receivedSteer: { agentPubkey: string; turnRequestId: string; receivedAt: number; } | null,
  setReceivedSteer: React.Dispatch<React.SetStateAction<{ agentPubkey: string; turnRequestId: string; receivedAt: number; } | null>>,
  setPermissionActionId: React.Dispatch<React.SetStateAction<string | null>>,
  grantActionId: string | null,
  setGrantActionId: React.Dispatch<React.SetStateAction<string | null>>,
  choiceActionId: string | null,
  setChoiceActionId: React.Dispatch<React.SetStateAction<string | null>>,
  createPollBusy: boolean,
  setCreatePollBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setCreatePollVisible: React.Dispatch<React.SetStateAction<boolean>>,
  connectorOfferActionId: string | null,
  setConnectorOfferActionId: React.Dispatch<React.SetStateAction<string | null>>,
  setTargetBranchNotice: React.Dispatch<React.SetStateAction<{ proposalId: string; text: string; } | null>>,
  setTargetBranchActionId: React.Dispatch<React.SetStateAction<string | null>>,
  setMembershipActionPubkey: React.Dispatch<React.SetStateAction<string | null>>,
  memberInviteBusy: boolean,
  setMemberInviteBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setRosterVisible: React.Dispatch<React.SetStateAction<boolean>>,
  setRoomActionsVisible: (visible: boolean) => void | undefined,
  roomLifecycleBusy: boolean,
  setRoomLifecycleBusy: React.Dispatch<React.SetStateAction<boolean>>,
  renameBusy: boolean,
  setRenameEditing: React.Dispatch<React.SetStateAction<boolean>>,
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>,
  renameDraft: string,
  setRenameBusy: React.Dispatch<React.SetStateAction<boolean>>,
  renameTextDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  openingRandomCorner: boolean,
  setOpeningRandomCorner: React.Dispatch<React.SetStateAction<boolean>>,
  setForwardCornerPrompt: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>,
  forwardCornerPrompt: ChatDisplayMessage | null,
  uncoveredOwnersRef: React.RefObject<Set<string>>,
  setOwnerGrant: React.Dispatch<React.SetStateAction<OwnerGrantNeeded | null>>,
  setRoomRepoAccessIssue: React.Dispatch<React.SetStateAction<{ fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null>>,
  permissionActionId: string | null,
  appSignInActionId: string | null,
  setAppSignInActionId: React.Dispatch<React.SetStateAction<string | null>>,
  targetBranchNotice: { proposalId: string; text: string; } | null,
  conversationFrameRef: React.RefObject<View | null>,
  setCornerActionsVisible: React.Dispatch<React.SetStateAction<boolean>>,
  setDmActionsVisible: React.Dispatch<React.SetStateAction<boolean>>,
  cornerOpenRepoPrompt: boolean,
  ownerGrant: OwnerGrantNeeded | null,
  setComposerFocused: React.Dispatch<React.SetStateAction<boolean>>,
  membershipActionPubkey: string | null,
  membershipError: string | null,
  closeRoster: () => void,
  roomActionsRef: React.RefObject<RoomActionsSheetHandle | null>,
  renameEditing: boolean,
  setRenameDraft: (update: string | ((previous: string) => string)) => void,
  renameError: string | null,
  dmActionsVisible: boolean,
  cornerActionsVisible: boolean,
  agentConnectVisible: boolean,
  agentPairError: string | null,
  agentPairCommand: string | null,
  createPollVisible: boolean,
] {

  // Typed "the App does not cover this repository yet" state: rendered as a
  // share-with-owner CTA, never an error wall. `uncoveredOwners` feeds the
  // paste-flow plan so a foreign repo plans the share path instead of a
  // doomed self-connect.
  const [ownerGrant, setOwnerGrant] = useState<OwnerGrantNeeded | null>(null);

  const uncoveredOwnersRef = useRef<Set<string>>(new Set());

  const [cornerOpenRepoPrompt, setCornerOpenRepoPrompt] = useState(false);

  const [roomRepoAccessIssue, setRoomRepoAccessIssue] = useState<{
    fullName: string;
    reason: 'revoked' | 'not_granted';
    installationId?: number;
  } | null>(null);

  const [rosterVisible, setRosterVisible] = useState(false);

  const closeRoster = useCallback(() => setRosterVisible(false), []);

  const roomActionsRef = useRef<RoomActionsSheetHandle>(null);

  const conversationFrameRef = useRef<View>(null);

  const setRoomActionsVisible = useCallback(
    (visible: boolean) => roomActionsRef.current?.setVisible(visible),
    [],
  );

  const [cornerActionsVisible, setCornerActionsVisible] = useState(false);

  const [dmActionsVisible, setDmActionsVisible] = useState(false);

  const [renameEditing, setRenameEditing] = useState(false);

  const [renameDraft, setRenameDraft, renameTextDraft] = useTextDraft(
    `rename:${decodedId}`,
    '',
    userPubkey || null,
  );

  const [renameBusy, setRenameBusy] = useState(false);

  const [renameError, setRenameError] = useState<string | null>(null);

  const [openingRandomCorner, setOpeningRandomCorner] = useState(false);

  const [forwardCornerPrompt, setForwardCornerPrompt] = useState<ChatDisplayMessage | null>(null);

  const [participantPickerVisible, setParticipantPickerVisible] = useState(false);

  const [participantPickerKind, setParticipantPickerKind] = useState<'person' | 'agent' | null>(
    null,
  );

  const [membershipError, setMembershipError] = useState<string | null>(null);

  const [memberInviteBusy, setMemberInviteBusy] = useState(false);

  const [agentConnectVisible, setAgentConnectVisible] = useState(false);

  const [agentPairCommand, setAgentPairCommand] = useState<string | null>(null);

  const [agentPairBusy, setAgentPairBusy] = useState(false);

  const [agentPairError, setAgentPairError] = useState<string | null>(null);

  const [membershipActionPubkey, setMembershipActionPubkey] = useState<string | null>(null);

  const [roomLifecycleBusy, setRoomLifecycleBusy] = useState(false);

  const directMessage = roomSurface?.directMessage ?? null;

  // Hoisted above the pane handlers that need it in their dependency arrays.
  const isDirectMessage = Boolean(directMessage);

  const [composerFocused, setComposerFocused] = useState(false);

  const [createPollVisible, setCreatePollVisible] = useState(false);

  const [createPollBusy, setCreatePollBusy] = useState(false);

  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);

  const [grantActionId, setGrantActionId] = useState<string | null>(null);

  const [connectorOfferActionId, setConnectorOfferActionId] = useState<string | null>(null);

  const [appSignInActionId, setAppSignInActionId] = useState<string | null>(null);

  const [choiceActionId, setChoiceActionId] = useState<string | null>(null);

  /** Proposal currently being confirmed, and the last refusal/failure text. */
  const [targetBranchActionId, setTargetBranchActionId] = useState<string | null>(null);

  const [targetBranchNotice, setTargetBranchNotice] = useState<{
    proposalId: string;
    text: string;
  } | null>(null);

  // Armed the instant a message this client believes addresses an agent is
  // sent, so the composer never shows dead air waiting on the real WORKING
  // receipt (API write + pickup + receipt + refetch). See
  // `selectComposerAckState`.
  const [pendingAck, setPendingAck] = useState<{ sentAt: number; requestId?: string } | null>(null);

  const [receivedSteer, setReceivedSteer] = useState<{
    agentPubkey: string;
    turnRequestId: string;
    receivedAt: number;
  } | null>(null);


  useLayoutEffect(() => {
    inputTextRef.current = inputText;
  }, [inputText]);

  useEffect(() => {
    setDesktopDeliveryState(null);
  }, [decodedId, userPubkey]);


  const stagedComposerFocusRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    // A corner opened by a swipe-right forward arrives with that forward ready
    // in its composer and the cursor after it.
    const staged = takeCornerComposerDraft(decodedId);
    if (staged === undefined) return;
    const selection = { start: staged.length, end: staged.length };
    inputTextRef.current = staged;
    setInputText(staged);
    setInputSelection(selection);
    // The forward ends with the author's @handle; the cursor after it should
    // not reopen the mention menu.
    const mention = activeMentionAtCursor(staged, staged.length);
    setDismissedMentionKey(mention ? `${staged}:${mention.start}:${mention.end}` : null);
    stagedComposerFocusRef.current = selection;
  }, [decodedId]);


  const composerMounted = Boolean(roomSurface);

  useEffect(() => {
    // The composer mounts only once the new corner has loaded, so the staged
    // forward's cursor waits for it.
    const fullSelection = stagedComposerFocusRef.current;
    if (!composerMounted || !fullSelection) return;
    stagedComposerFocusRef.current = null;
    scheduleAnimationFrame(() => {
      focusComposerSelection(composerRef.current, fullSelection, Platform.OS);
    });
  }, [composerMounted, decodedId]);
  return [
    setMembershipError, isDirectMessage, participantPickerVisible, rosterVisible,
    roomRepoAccessIssue, setCornerOpenRepoPrompt, participantPickerKind, composerFocused,
    directMessage, agentPairBusy, setAgentConnectVisible, setAgentPairCommand, setAgentPairError,
    setAgentPairBusy, setParticipantPickerKind, setParticipantPickerVisible, targetBranchActionId,
    pendingAck, setPendingAck, receivedSteer, setReceivedSteer, setPermissionActionId,
    grantActionId, setGrantActionId, choiceActionId, setChoiceActionId, createPollBusy,
    setCreatePollBusy, setCreatePollVisible, connectorOfferActionId, setConnectorOfferActionId,
    setTargetBranchNotice, setTargetBranchActionId, setMembershipActionPubkey, memberInviteBusy,
    setMemberInviteBusy, setRosterVisible, setRoomActionsVisible, roomLifecycleBusy,
    setRoomLifecycleBusy, renameBusy, setRenameEditing, setRenameError, renameDraft, setRenameBusy,
    renameTextDraft, openingRandomCorner, setOpeningRandomCorner, setForwardCornerPrompt,
    forwardCornerPrompt, uncoveredOwnersRef, setOwnerGrant, setRoomRepoAccessIssue,
    permissionActionId, appSignInActionId, setAppSignInActionId, targetBranchNotice,
    conversationFrameRef, setCornerActionsVisible, setDmActionsVisible, cornerOpenRepoPrompt,
    ownerGrant, setComposerFocused, membershipActionPubkey, membershipError, closeRoster,
    roomActionsRef, renameEditing, setRenameDraft, renameError, dmActionsVisible,
    cornerActionsVisible, agentConnectVisible, agentPairError, agentPairCommand, createPollVisible,
  ];
}
