import { IndexRow } from '@/components/buzz/IndexRow';
import { type MutableRefObject } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { router, type Href } from 'expo-router';
import { Modal } from '@/modal';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { openExternalUrl } from '@/utils/open-external-url';
import { type RoomSurfaceSessionBindings, type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
import { CornerStatusLine } from '@/components/buzz/CornerStatusLine';
import { RoomActionsBackground } from '@/components/buzz/RoomRepositoryChoice';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { RoomReviewerSurfaceNotice } from '@/components/buzz/RoomReviewerActions';
import { ChannelHeaderTitle } from '@/components/buzz/ChannelHeaderTitle';
import { VoiceCallCard } from '@/components/buzz/VoiceCallCard';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { useChatRoute } from './useChatRoute';
import { useChatScrollState } from './useChatScrollState';
import { useChatComposerRefs } from './useChatComposerRefs';
import { useChatRoomSession } from './useChatRoomSession';
import { useChatComposerDraft } from './useChatComposerDraft';
import { useChatActionState } from './useChatActionState';
import { useChatDesktopLayout } from './useChatDesktopLayout';
import { useChatRoomPresentation } from './useChatRoomPresentation';
import { useChatTranscriptHistory } from './useChatTranscriptHistory';
import { useChatRoster } from './useChatRoster';
import { useChatComposerSuggestions } from './useChatComposerSuggestions';
import { useChatHeader } from './useChatHeader';
import { useChatTranscriptProjection } from './useChatTranscriptProjection';
import { useChatTranscriptWindow } from './useChatTranscriptWindow';
import { useChatDesktopScroll } from './useChatDesktopScroll';
import { useChatTranscriptLanding } from './useChatTranscriptLanding';
import { useChatTurnPresentation } from './useChatTurnPresentation';
import { useChatMessageActions } from './useChatMessageActions';
import { useChatComposerSend } from './useChatComposerSend';
import { useChatComposerAttachments } from './useChatComposerAttachments';
import { useChatCardActions } from './useChatCardActions';
import { useChatMembershipActions } from './useChatMembershipActions';
import { useChatCornerActions } from './useChatCornerActions';
import { useChatRepositories } from './useChatRepositories';
import { useChatNavigation } from './useChatNavigation';
import { useChatComposerCommands } from './useChatComposerCommands';
import { useChatTranscriptRenderer } from './useChatTranscriptRenderer';
import { styles } from './chat-surface-styles';
import { ChatSurfaceHeaderView as ChatSurfaceHeader } from './ChatSurfaceHeader';
import { ChatSurfaceTranscript } from './ChatSurfaceTranscript';
import { ChatSurfaceComposer } from './ChatSurfaceComposer';
import { ChatSurfaceWorkPane } from './ChatSurfaceWorkPane';
import { ChatSurfaceOverlays } from './ChatSurfaceOverlays';



export function BuzzChatSurface({
  session,
  bindingsRef,
}: {
  session: UseRoomSurfaceSessionResult;
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>;
}) {
  const [
    sendPreview, decodedId, navigation, desktopExperience, desktopAvailableWidth,
    routeParentChannelId, allowOlderHistoryRef, routeChannelTitle, routeCommunityId, profileKind,
    profileAgentId, setProfileKind, setProfileAgentId, messageAnchorId, notificationResponseId,
    notificationMessageId, notificationTarget, insets, cornerReturnTarget, isDesktop,
    readOnlyFooterInset,
  ] = useChatRoute([

  ]);
  const [
    transcriptWindowIdRef, scrollController, handledNotificationAnchorRef, flatListRef, phoneRowKey,
    PhoneTranscriptCell, phoneScrollList,
  ] = useChatScrollState([
    sendPreview, () => desktopScrollNodeRef, () => desktopRowNodesRef, () => desktopTranscript,
    () => transcriptMessagesRef, () => transcriptHostIdsRef, () => messageJumpCanScrollTo,
    () => foldedMessages, () => revealTranscriptThrough, () => transcriptHistoryStatus,
    () => loadOlderTranscriptMessages, () => transcriptJump, () => endTranscriptJump,
    () => heldLandingFromOldestRef, () => phoneContentHeightRef, () => phoneScrollOffsetRef,
    () => heldLandingShortRef, () => phoneListHeightRef, () => raiseSourceLandingFlash,
    () => messageAnchorIdRef, () => raiseArrivalFlash, () => anchoredSegmentActive,
  ]);
  const [
    inputTextRef, composerRef, roomMessageProjector, selectedAgentMentionsRef, selectedMentionsRef,
    sendInFlightRef, composerInputRevisionRef,
  ] = useChatComposerRefs([

  ]);
  const [
    userPubkey, outbox, transport, roomSurface, roomClient, firstUnreadMessageId, isFocused,
    messageRecordScope, liveOverlays, heartbeatPresences, presenceNow, presenceReconnectGrace,
    setSessionTransport, advanceReadCursor, liveDraftStore, readRoom, setPresenceNow,
    applyRoomMessageResult, applyPendingAgentCommands, acknowledgeReadMark,
    applyRoomRepositoryResult, applyRoomName, clearRoomRepository, transcriptHydrationFailed,
    transcriptHydrationError, retryHydration, applyRoomReviewer, pushMuteWorking, togglePushMute,
    pushMuted,
  ] = useChatRoomSession([
    decodedId, () => setMembershipError, navigation, session,
  ]);
  const [
    inputText, setDesktopDeliveryState, setInputText, setInputSelection, setDismissedMentionKey,
    desktopWorkPaneRef, setDesktopWorkPane, desktopWorkPaneContent, inputSelection,
    dismissedMentionKey, agentCommandsByScope, agentFastModeByScope, agentCanLoginByScope,
    setAgentCommandsByScope, setAgentCanLoginByScope, setAgentFastModeByScope, optimisticDeletes,
    optimisticReactions, dismissedSlashText, setHighlightedSlashVerbIndex, composerHeight,
    setReplyTarget, reactingRef, optimisticReactionsRef, setOptimisticReactions, showReportToast,
    setOptimisticDeletes, setMessageActionsTarget, setForwardTarget, setForwardRooms,
    setForwardError, forwardTarget, forwardBusyRoomId, setForwardBusyRoomId, composerDraft,
    replyTarget, pendingAttachmentsRef, setSending, attachmentUploader, activeComposerDraftRef,
    setComposerInputRevision, setComposerHeight, replacePendingAttachments, setCornerProposalAction,
    pendingAttachments, setAttachmentPickerVisible, setHighlightedMentionIndex, addingMembers,
    setAddingMembers, setRoomRepoListLoading, setRoomRepoError, setShowRoomRepoPicker,
    setRoomRepoNotice, roomRepoBusy, setRoomRepoBusy, roomRepoListLoading, roomRepoError,
    roomRepoNotice, showRoomRepoPicker, sending, setDismissedSlashText, highlightedSlashVerbIndex,
    failedOutboxIds, cornerProposalAction, turnChromeTopInset, setTurnChromeTopInset,
    highlightedMentionIndex, desktopDeliveryState, composerInputRevision, reportToast,
    attachmentPickerVisible, messageActionsTarget, forwardError, forwardRooms,
  ] = useChatComposerDraft([
    decodedId, userPubkey, desktopExperience, desktopAvailableWidth, outbox, transport,
  ]);
  const [
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
  ] = useChatActionState([
    decodedId, userPubkey, roomSurface, inputTextRef, inputText, setDesktopDeliveryState,
    setInputText, setInputSelection, setDismissedMentionKey, composerRef,
  ]);
  const [
    chatListKey, isArchived, isCorner, activeCommunityId, surfaceParentId, parentChannelId,
    resolvedChannelName, commitDesktopWorkPane, desktopWorkRoomId, cacheViewerPubkey,
    workspaceRoster, channelKind, openWorkspaceRoster, roomRepoCandidates, githubScope,
    chatListRelayUrl, githubInstallations, desktopWorkPaneMounted, displayedDesktopWorkPaneContent,
  ] = useChatDesktopLayout([
    desktopWorkPaneRef, setDesktopWorkPane, desktopExperience, desktopAvailableWidth, decodedId,
    userPubkey, roomSurface, routeParentChannelId, isDirectMessage, desktopWorkPaneContent,
    roomClient, firstUnreadMessageId, allowOlderHistoryRef, routeChannelTitle, routeCommunityId,
    participantPickerVisible, rosterVisible, setMembershipError, profileKind, profileAgentId,
  ]);
  const [
    revealTranscriptThrough, transcriptHistoryStatus, transcriptJump, endTranscriptJump,
    serverTailRows, serverHistoryRows, transcriptWindowId, historyAttached, resetTranscriptHistory,
    visibleMessageCount, cornerTask, loadOlderHistory, retryOlderHistory, jumpToTranscriptMessage,
    transcriptNewerStatus, retryNewerTranscriptMessages, workspaceChats, viewerPubkey,
    roomRepository, viewerIsAgent, canManageWorkspace, fillTranscript, transcriptFillStatus,
    transcriptPositions, loadNewerTranscriptMessages, loadLatestTranscriptMessages, voice,
    workspaceChatList, captureUntaggedSend, roomRepositoryResolved, canRenameTitle,
    openDesktopCorner, handleOpenChannelReference, handleOpenMention, channelReferenceIndex,
    handleOpenProfile, hintMessageIds, channelReferenceKey, communities,
  ] = useChatRoomPresentation([
    chatListKey, decodedId, roomSurface, userPubkey, isFocused, isDirectMessage, isArchived,
    isCorner, activeCommunityId, surfaceParentId, roomRepoAccessIssue, setCornerOpenRepoPrompt,
    parentChannelId, resolvedChannelName, routeChannelTitle, commitDesktopWorkPane,
    desktopExperience, desktopWorkRoomId, roomClient, cacheViewerPubkey, setProfileKind,
    setProfileAgentId, transport,
  ]);
  const [
    transcriptHostIdsRef, foldedMessages, loadOlderTranscriptMessages, anchoredSegmentActive,
    conversationIdentities, durableMessages, unprojectedMessages, combinedMessages, arrivalMessages,
    unreadLine, transcriptArrivalObservation, addMessages, removeOptimistic, reconcileOptimistic,
    openCurrentBrief, arrivingCardIds, transcriptCardMotionStore, firstNewMessageId,
    cornerObjectiveText, openRoomWorkflowRun, roomWorkflowRun, roomOtherLiveRuns,
    transcriptHistoryLine, transcriptForwardLine, loadOlderTranscriptIfReaderAsked,
  ] = useChatTranscriptHistory([
    messageRecordScope, decodedId, serverTailRows, serverHistoryRows, cacheViewerPubkey,
    roomMessageProjector, roomSurface, liveOverlays, transcriptWindowIdRef, transcriptWindowId,
    historyAttached, bindingsRef, resetTranscriptHistory, outbox, userPubkey, isCorner,
    firstUnreadMessageId, visibleMessageCount, cornerTask, resolvedChannelName, loadOlderHistory,
    allowOlderHistoryRef, retryOlderHistory, transcriptJump, scrollController,
    jumpToTranscriptMessage, transcriptNewerStatus, retryNewerTranscriptMessages,
    transcriptHistoryStatus,
  ]);
  const [
    roomParticipants, agentPresences, describedRoomParticipants, participantsHydrated,
    personProfileByPubkey, agentByPubkey, roomAgents, participantPickerCandidates,
    roomMemberPubkeys, agentProfileModelByPubkey, speakerRoleByPubkey, composerTagHandles,
    speechHints, roomMemberByPubkey, visibleRosterMembers, roomParticipantTotal,
    participantPickerWorkspacePeers,
  ] = useChatRoster([
    roomSurface, conversationIdentities, durableMessages, resolvedChannelName, userPubkey,
    workspaceRoster, participantPickerKind, heartbeatPresences,
  ]);
  const [
    directMessageListItem, isReadOnlyDirectMessage, messages, activeAgentTurns,
    pendingCornerRequest, pendingTargetBranchProposal, currentSlashQuery, mentionSlash,
    mentionSlashAgentPubkey, mentionAgentCommands, agentTurnMarkers, activeAgentTurn, starPrompt,
    activeMention, activeChannel, mentionAgentCommandScope, mentionAgentLacksCommands,
    mentionMenuVisible, mentionSuggestions, channelMenuVisible, channelSuggestions, suggestionCount,
    mentionMenuKey, channelMenuKey, memberManagement,
  ] = useChatComposerSuggestions([
    roomParticipants, agentPresences, presenceNow, inputSelection, inputText,
    describedRoomParticipants, composerFocused, dismissedMentionKey, isDirectMessage,
    parentChannelId, decodedId, roomClient, workspaceChats, roomSurface, presenceReconnectGrace,
    unprojectedMessages, participantsHydrated, rosterVisible, participantPickerVisible,
    viewerPubkey, agentCommandsByScope, agentFastModeByScope, agentCanLoginByScope,
    combinedMessages, roomRepository, activeCommunityId, setAgentCommandsByScope,
    setAgentCanLoginByScope, setAgentFastModeByScope,
  ]);
  const [
    emptyLedgerVariant, displayRoomName, roomName, firstRoomAgent, startCornerMessage,
    focusComposer, starterPrompts, starterIntro, storedRoomName, headerTitleKind,
    displayHeaderTitle, dmPeerPubkey, dmPeerIdentity, dmPeerAgentDisplay, dmPeerProfile,
    dmHeaderPresence, headerTitle, closeAgentConnect, connectAgent, copyPairCommand,
  ] = useChatHeader([
    parentChannelId, roomSurface, resolvedChannelName, isCorner, channelKind, decodedId,
    isDirectMessage, userPubkey, directMessage, personProfileByPubkey, directMessageListItem,
    agentByPubkey, presenceNow, workspaceRoster, isReadOnlyDirectMessage, composerRef, inputTextRef,
    selectedAgentMentionsRef, selectedMentionsRef, setInputText, setInputSelection,
    activeCommunityId, agentPairBusy, viewerIsAgent, setAgentConnectVisible, setAgentPairCommand,
    setAgentPairError, setAgentPairBusy, transport, setSessionTransport, canManageWorkspace,
    setMembershipError, setParticipantPickerKind, openWorkspaceRoster, setParticipantPickerVisible,
  ]);
  const [
    desktopTranscript, transcriptMessagesRef, transcriptMessages, visibleMessages,
    cornerAgentPubkey, dismissComposerKeyboard, speakerWorking, continuedAttributionIds,
    cornerOwnerPubkey, cornerOwnerDisplay, cornerOwnerWorking, cornerHeaderWord,
    cornerHeaderDisplay, cornerHeaderSource, emptyLedger,
  ] = useChatTranscriptProjection([
    isCorner, parentChannelId, decodedId, isArchived, roomClient, messages, agentByPubkey,
    roomSurface, activeAgentTurns, participantsHydrated, optimisticDeletes, optimisticReactions,
    desktopExperience, viewerIsAgent, emptyLedgerVariant, isDirectMessage, displayRoomName,
    roomName, firstRoomAgent, startCornerMessage, focusComposer, starterPrompts, starterIntro,
  ]);
  const [
    desktopScrollNodeRef, heldLandingFromOldestRef, phoneContentHeightRef, phoneScrollOffsetRef,
    heldLandingShortRef, phoneListHeightRef, observeVisibleMessages, chronologicalMessagesRef,
    newMessageHasObservedVisibility, newestTranscriptMessageId, desktopContentObserverRef,
    desktopContentNodeRef, observeTailPinned, applyComposerPrefill, composerPrefillRef, slashVerbs,
    phoneUnderfill, detachedFillMeasuredRef, holdPhoneLanding, newMessageBadgeCount,
    newestJumpDiscShown, slashMenuVisible, paletteItemCount,
  ] = useChatTranscriptWindow([
    anchoredSegmentActive, scrollController, fillTranscript, foldedMessages, desktopTranscript,
    transcriptMessages, roomClient, cacheViewerPubkey, transcriptFillStatus, visibleMessageCount,
    visibleMessages, viewerIsAgent, userPubkey, agentByPubkey, isDirectMessage, decodedId,
    roomSurface, selectedAgentMentionsRef, selectedMentionsRef, inputTextRef, setInputText,
    setInputSelection, arrivalMessages, unreadLine, transcriptArrivalObservation, isCorner,
    canManageWorkspace, pendingCornerRequest, pendingTargetBranchProposal, targetBranchActionId,
    currentSlashQuery, mentionSlash, composerFocused, mentionSlashAgentPubkey, dismissedSlashText,
    inputText, mentionAgentCommands, setHighlightedSlashVerbIndex,
  ]);
  const [
    desktopRowNodesRef, messageJumpCanScrollTo, raiseSourceLandingFlash, messageAnchorIdRef,
    raiseArrivalFlash, restoreDesktopReadingAnchor, handleOpenCode, handleOpenMessageSource,
    arrivalFlashMessageId, sourceLandingFlashMessageId, setDesktopScrollNode, handleDesktopScroll,
    setDesktopContentNode, getDesktopRowRefCallback, observeVisibleTranscriptMessages,
  ] = useChatDesktopScroll([
    desktopScrollNodeRef, scrollController, messageAnchorId, decodedId, desktopTranscript,
    transcriptJump, transcriptPositions, observeVisibleMessages, advanceReadCursor,
    chronologicalMessagesRef, anchoredSegmentActive, isFocused, newMessageHasObservedVisibility,
    newestTranscriptMessageId, visibleMessages, transcriptMessagesRef, transcriptMessages,
    combinedMessages, revealTranscriptThrough, desktopContentObserverRef, desktopContentNodeRef,
    observeTailPinned, loadNewerTranscriptMessages, loadOlderTranscriptMessages,
  ]);
  const [
    landAtOwnSend, observePhoneTailOffset, landAtNewestMessage,
  ] = useChatTranscriptLanding([
    scrollController, observeTailPinned, desktopTranscript, restoreDesktopReadingAnchor,
    transcriptMessages, transcriptJump, isCorner, firstUnreadMessageId, messageAnchorId, decodedId,
    loadLatestTranscriptMessages, liveDraftStore, voice, foldedMessages, notificationResponseId,
    notificationMessageId, notificationTarget, handledNotificationAnchorRef, transcriptHostIdsRef,
    messageJumpCanScrollTo, roomClient, cacheViewerPubkey, roomSurface, jumpToTranscriptMessage,
    anchoredSegmentActive, transcriptNewerStatus, desktopScrollNodeRef, loadNewerTranscriptMessages,
  ]);
  const [
    bylineOpeners, answerByMessageId, visibleMessageById, immediatelyPrecedingVisibleMessageById,
    composerAck, settledTurn, stoppingThisTurn, handleStopTurn, composerBottomInsetStyle,
    keyboardHeight,
  ] = useChatTurnPresentation([
    visibleMessages, pendingAck, agentTurnMarkers, setPendingAck, receivedSteer, activeAgentTurn,
    setReceivedSteer, isCorner, roomSurface, viewerPubkey, conversationIdentities, agentByPubkey,
    insets, composerHeight, scrollController, decodedId, readRoom, desktopExperience,
    setDesktopDeliveryState, agentPresences, setPresenceNow, presenceNow,
  ]);
  const [
    replyTargetForMessage, beginForward, beginReply, openMessageActions, handleReactToMessage,
    handleBookmarkMessage, handleReportMessage, dismissOutboxMessage, messageIsBookmarked,
    canDeleteMessage, handleDeleteMessage, forwardToRoom,
  ] = useChatMessageActions([
    agentByPubkey, personProfileByPubkey, chronologicalMessagesRef, decodedId, setReplyTarget,
    applyComposerPrefill, inputTextRef, composerPrefillRef, setDismissedMentionKey,
    scrollController, composerRef, reactingRef, optimisticReactionsRef, setOptimisticReactions,
    applyRoomMessageResult, starPrompt, messageRecordScope, showReportToast, canManageWorkspace,
    setOptimisticDeletes, setMessageActionsTarget, workspaceChatList, roomClient, activeCommunityId,
    setForwardTarget, setForwardRooms, setForwardError, chatListKey, forwardTarget,
    forwardBusyRoomId, setForwardBusyRoomId, transport, displayRoomName, outbox,
  ]);
  const [
    handleSend, handleCornerProposalDecision,
  ] = useChatComposerSend([
    composerDraft, inputTextRef, replyTarget, pendingAttachmentsRef, sendInFlightRef, isArchived,
    roomParticipants, selectedMentionsRef, captureUntaggedSend, selectedAgentMentionsRef,
    roomAgents, isCorner, outbox, desktopTranscript, setReceivedSteer, setPendingAck, setSending,
    desktopExperience, setDesktopDeliveryState, roomSurface, userPubkey, sendPreview,
    scrollController, landAtOwnSend, addMessages, isDirectMessage, roomRepository,
    roomRepositoryResolved, roomRepoAccessIssue, setCornerOpenRepoPrompt, activeCommunityId,
    roomRepoCandidates, transport, githubScope, setSessionTransport, removeOptimistic,
    attachmentUploader, decodedId, reconcileOptimistic, activeComposerDraftRef,
    composerInputRevisionRef, composerRef, setComposerInputRevision, setComposerHeight,
    setInputSelection, replacePendingAttachments, setReplyTarget, applyRoomMessageResult,
    applyPendingAgentCommands, activeAgentTurn, acknowledgeReadMark, isFocused, parentChannelId,
    cacheViewerPubkey, cornerAgentPubkey, agentPresences, presenceNow, presenceReconnectGrace,
    agentByPubkey, replyTargetForMessage, setCornerProposalAction,
  ]);
  const [
    selectMention, selectChannel, chooseAttachment, pickDocument, pickPhoto, pasteImage,
  ] = useChatComposerAttachments([
    pendingAttachments, replacePendingAttachments, setAttachmentPickerVisible, activeMention,
    inputTextRef, selectedAgentMentionsRef, selectedMentionsRef, setInputText, setInputSelection,
    setDismissedMentionKey, setHighlightedMentionIndex, composerRef, activeChannel,
  ]);
  const [
    handleWritePermission, handleConfirmTargetBranch, handleGrantDecision, handleChoiceAnswer,
    handleChoiceSkip, handleAcceptConnectorOffer, continueConnectorOffer, openWorkbench,
    handleCreatePoll,
  ] = useChatCardActions([
    transport, viewerIsAgent, cacheViewerPubkey, setPermissionActionId, decodedId, grantActionId,
    setGrantActionId, choiceActionId, setChoiceActionId, roomSurface, focusComposer, readRoom,
    createPollBusy, setCreatePollBusy, setCreatePollVisible, activeCommunityId,
    connectorOfferActionId, setConnectorOfferActionId, targetBranchActionId, canManageWorkspace,
    setTargetBranchNotice, setTargetBranchActionId, applyRoomRepositoryResult,
  ]);
  const [
    closeRoomActions, handleConnectAgent, handleRemoveRoomMember, handleRenameRoom,
    handleRoomLifecycle, handleAddRoomMembers, handleInvitePerson,
  ] = useChatMembershipActions([
    transport, activeCommunityId, canManageWorkspace, addingMembers, participantPickerCandidates,
    roomMemberPubkeys, setAddingMembers, setMembershipError, decodedId, setParticipantPickerVisible,
    userPubkey, setMembershipActionPubkey, memberInviteBusy, setMemberInviteBusy,
    setSessionTransport, setRosterVisible, setRoomActionsVisible, roomLifecycleBusy,
    setRoomLifecycleBusy, displayRoomName, roomSurface, readRoom, renameBusy, setRenameEditing,
    setRenameError, renameDraft, isCorner, canRenameTitle, setRenameBusy, renameTextDraft,
    applyRoomName,
  ]);
  const [
    startRenameFromTitle, handleForwardToNewCorner, handleOpenRandomCorner,
    confirmForwardToNewCorner,
  ] = useChatCornerActions([
    canRenameTitle, renameTextDraft, storedRoomName, setRenameError, setRenameEditing, isCorner,
    setRoomActionsVisible, openingRandomCorner, isArchived, viewerIsAgent, transport,
    setOpeningRandomCorner, parentChannelId, decodedId, desktopExperience, openDesktopCorner,
    setForwardCornerPrompt, forwardCornerPrompt, displayRoomName,
  ]);
  const [
    handleReconnectRoomRepository, handleAddGitHubAccount, handleAskOwnerGrant,
    handleCreateGitHubRepository, handleManageGitHubInstallation, handleSelectRoomRepoCandidate,
    roomRepoOptions,
  ] = useChatRepositories([
    transport, activeCommunityId, githubScope, setRoomRepoListLoading, setRoomRepoError,
    chatListRelayUrl, userPubkey, setShowRoomRepoPicker, decodedId, setRoomRepoNotice, roomRepoBusy,
    setRoomRepoBusy, uncoveredOwnersRef, setOwnerGrant, applyRoomRepositoryResult,
    setCornerOpenRepoPrompt, parentChannelId, roomRepository, clearRoomRepository,
    canManageWorkspace, roomSurface, roomRepoCandidates, githubInstallations, roomRepoListLoading,
    roomRepoError, roomRepoNotice, showRoomRepoPicker, closeRoomActions, roomRepoAccessIssue,
    setRoomRepoAccessIssue,
  ]);
  const [
    handleCloseCorner, openCorner, handleBack, handleCommunitySelect, handleDesktopDrop,
    handleDesktopPaste, expandDesktopCorner, closeDesktopWorkPane,
  ] = useChatNavigation([
    liveDraftStore, navigation, parentChannelId, cornerReturnTarget, transport, decodedId, readRoom,
    desktopExperience, openDesktopCorner, commitDesktopWorkPane, desktopWorkRoomId, focusComposer,
    profileAgentId, setProfileAgentId, desktopWorkPaneMounted, sending, pendingAttachments,
    replacePendingAttachments,
  ]);
  const [
    rowActions, handleOpenGitHubEvent, handleOpenSystemIdentity, handleCopyLedgerMessage,
    dismissSlashMenu, runSlashVerb, selectAgentCommand, selectHighlightedPaletteItem,
    handleSelectLedgerMessage,
  ] = useChatComposerCommands([
    inputTextRef, setInputText, setInputSelection, setComposerHeight, setDismissedSlashText,
    setHighlightedSlashVerbIndex, composerRef, inputText, mentionSlashAgentPubkey,
    mentionAgentCommandScope, agentFastModeByScope, activeCommunityId, setAgentFastModeByScope,
    transport, setSessionTransport, decodedId, setCreatePollVisible, canManageWorkspace,
    pendingCornerRequest, handleWritePermission, startRenameFromTitle, handleCloseCorner,
    pendingTargetBranchProposal, handleConfirmTargetBranch, handleConnectAgent, setMembershipError,
    setParticipantPickerKind, openWorkspaceRoster, setParticipantPickerVisible,
    highlightedSlashVerbIndex, mentionAgentCommands, slashVerbs, handleSend, beginForward,
    handleForwardToNewCorner, handleOpenChannelReference, handleOpenMention, cacheViewerPubkey,
  ]);
  const [
    renderItem,
  ] = useChatTranscriptRenderer([
    viewerIsAgent, canManageWorkspace, permissionActionId, grantActionId, choiceActionId,
    connectorOfferActionId, appSignInActionId, targetBranchActionId, roomRepository,
    participantsHydrated, personProfileByPubkey, agentProfileModelByPubkey, agentByPubkey,
    roomParticipants, decodedId, cacheViewerPubkey, roomName, rowActions, openCorner,
    handleGrantDecision, desktopExperience, handleChoiceAnswer, handleChoiceSkip,
    setAppSignInActionId, activeCommunityId, handleAcceptConnectorOffer, setConnectorOfferActionId,
    continueConnectorOffer, openWorkbench, isCorner, handleOpenGitHubEvent, targetBranchNotice,
    setTargetBranchActionId, handleOpenSystemIdentity, openCurrentBrief, replyTargetForMessage,
    isReadOnlyDirectMessage, channelReferenceIndex, handleOpenCode, handleOpenMessageSource,
    handleOpenProfile, dismissComposerKeyboard, beginReply, handleCopyLedgerMessage,
    openMessageActions, handleReactToMessage, handleBookmarkMessage, handleReportMessage,
    isDirectMessage, isArchived, handleCornerProposalDecision, dismissOutboxMessage, isDesktop,
    bylineOpeners, hintMessageIds, failedOutboxIds, outbox, speakerWorking, answerByMessageId,
    cornerProposalAction, speakerRoleByPubkey, visibleMessageById, channelReferenceKey,
    visibleMessages, continuedAttributionIds, immediatelyPrecedingVisibleMessageById,
    arrivingCardIds, transcriptCardMotionStore, firstNewMessageId, arrivalFlashMessageId,
    sourceLandingFlashMessageId,
  ]);

  if (!roomSurface) {
    if (transcriptHydrationFailed) {
      return (
        <View style={[styles.container, { paddingTop: insets.top }]} testID="room-hydration-error">
          <View style={styles.hydrationErrorHeader}>
            {(!isDesktop || isCorner) && (
              <TouchableOpacity
                accessibilityLabel="Back to Rooms"
                onPress={handleBack}
                style={styles.backButton}
                testID="chat-back"
              >
                <ChevronGlyph
                  color={styles.backText.color}
                  direction="left"
                  size={CHEVRON_BACK_SIZE}
                  testID="chat-back-glyph"
                />
              </TouchableOpacity>
            )}
            <View style={styles.headerCenter}>
              <ChannelHeaderTitle
                kind={headerTitleKind}
                title={displayHeaderTitle ?? routeChannelTitle ?? ROOM_LABEL}
              />
            </View>
          </View>
          <View style={styles.hydrationFailureInset}>
            {transcriptHydrationError && <IndexRow inset="flush" title={transcriptHydrationError} action="Retry" onPress={retryHydration} testID="room-read-error" />}
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <SurfaceGlyphLoader testID="room-surface-loader" />
        <Text style={styles.loadingText}>
          LOADING {(isCorner ? CORNER_LABEL : ROOM_LABEL).toUpperCase()}
        </Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleCommunitySelect}
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      viewerPubkey={userPubkey || undefined}
      viewerAvatarUrl={personProfileByPubkey.get(userPubkey)?.avatar}
    >
      <RoomActionsBackground style={styles.desktopConversationFrame} ref={conversationFrameRef}>
        <View style={styles.container}>
          {/* Header. No surface of its own — the chrome sits on the same
            obsidian as the transcript, parted only by a hairline. */}
          <ChatSurfaceHeader
  insets={insets}
  isCorner={isCorner}
  desktopExperience={desktopExperience}
  isDesktop={isDesktop}
  cornerReturnTarget={cornerReturnTarget}
  handleBack={handleBack}
  cornerOwnerPubkey={cornerOwnerPubkey}
  cornerOwnerDisplay={cornerOwnerDisplay}
  cornerOwnerWorking={cornerOwnerWorking}
  isDirectMessage={isDirectMessage}
  isReadOnlyDirectMessage={isReadOnlyDirectMessage}
  dmPeerPubkey={dmPeerPubkey}
  dmPeerIdentity={dmPeerIdentity}
  directMessageListItem={directMessageListItem}
  dmPeerAgentDisplay={dmPeerAgentDisplay}
  dmPeerProfile={dmPeerProfile}
  displayRoomName={displayRoomName}
  displayHeaderTitle={displayHeaderTitle}
  headerTitleKind={headerTitleKind}
  canRenameTitle={canRenameTitle}
  startRenameFromTitle={startRenameFromTitle}
  setRoomActionsVisible={setRoomActionsVisible}
  handleOpenGitHubEvent={handleOpenGitHubEvent}
  roomRepository={roomRepository}
  cornerHeaderWord={cornerHeaderWord}
  cornerHeaderDisplay={cornerHeaderDisplay}
  cornerHeaderSource={cornerHeaderSource}
  viewerPubkey={viewerPubkey}
  scrollController={scrollController}
  jumpToTranscriptMessage={jumpToTranscriptMessage}
  dmHeaderPresence={dmHeaderPresence}
  parentChannelId={parentChannelId}
  handleOpenRandomCorner={handleOpenRandomCorner}
  decodedId={decodedId}
  viewerIsAgent={viewerIsAgent}
  isArchived={isArchived}
  setCornerActionsVisible={setCornerActionsVisible}
  setMembershipError={setMembershipError}
  setDmActionsVisible={setDmActionsVisible}
  setRenameEditing={setRenameEditing}
  setRenameError={setRenameError}
/>

          {!isCorner && !isDirectMessage && (() => {
            const call = workspaceChats.find(chat => chat.room.id === decodedId)?.voiceCall;
            return call && !call.endedAt ? <VoiceCallCard call={call} viewer={viewerPubkey}
              joined={voice.call?.id === call.id} connecting={voice.connecting} onJoin={() => void voice.join()} /> : null;
          })()}

          <RoomReviewerSurfaceNotice
            allowAutoMerge={roomRepository?.allowAutoMerge}
            canManage={canManageWorkspace}
            isCorner={isCorner}
            reviewerAgentId={roomSurface?.room.reviewerAgentId}
          />

          <KeyboardAvoidingView
            style={styles.keyboardBody}
            behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
          >
            {/* What the corner is for, held under the header for its whole life:
            the human's own request, inscribed rather than framed. The header
            carries a short corner name, so without this the objective survives
            only until the first message lands. */}
            {isCorner && (
              <CornerObjectiveLine
                objective={cornerObjectiveText}
                onOpenBrief={openCurrentBrief}
                onOpenWorkflow={openRoomWorkflowRun}
                workflow={roomWorkflowRun}
                otherLiveRuns={roomOtherLiveRuns}
              />
            )}

            {/* The corner's PR state, inscribed above the transcript: one line
            that links to GitHub, where review and merge happen. */}
            {isCorner && (
              <View style={styles.cornerStatusInset}>
                <CornerStatusLine
                  lifecycle={roomSurface?.cornerLifecycle}
                  archived={isArchived}
                  onOpenPullRequest={(url) => {
                    void openExternalUrl(url).catch(() => {
                      Modal.alert('Could not open pull request', 'Open the PR from GitHub instead.');
                    });
                  }}
                />
              </View>
            )}

            <ChatSurfaceTranscript
  desktopTranscript={desktopTranscript}
  setDesktopScrollNode={setDesktopScrollNode}
  handleDesktopScroll={handleDesktopScroll}
  scrollController={scrollController}
  setDesktopContentNode={setDesktopContentNode}
  transcriptMessages={transcriptMessages}
  emptyLedger={emptyLedger}
  transcriptHistoryLine={transcriptHistoryLine}
  getDesktopRowRefCallback={getDesktopRowRefCallback}
  renderItem={renderItem}
  transcriptForwardLine={transcriptForwardLine}
  sendPreview={sendPreview}
  flatListRef={flatListRef}
  phoneRowKey={phoneRowKey}
  PhoneTranscriptCell={PhoneTranscriptCell}
  isArchived={isArchived}
  composerAck={composerAck}
  settledTurn={settledTurn}
  anchoredSegmentActive={anchoredSegmentActive}
  phoneScrollOffsetRef={phoneScrollOffsetRef}
  observePhoneTailOffset={observePhoneTailOffset}
  transcriptPositions={transcriptPositions}
  loadNewerTranscriptMessages={loadNewerTranscriptMessages}
  observeVisibleTranscriptMessages={observeVisibleTranscriptMessages}
  allowOlderHistoryRef={allowOlderHistoryRef}
  phoneListHeightRef={phoneListHeightRef}
  phoneUnderfill={phoneUnderfill}
  detachedFillMeasuredRef={detachedFillMeasuredRef}
  holdPhoneLanding={holdPhoneLanding}
  phoneScrollList={phoneScrollList}
  loadOlderTranscriptIfReaderAsked={loadOlderTranscriptIfReaderAsked}
  starPrompt={starPrompt}
  loadOlderTranscriptMessages={loadOlderTranscriptMessages}
  desktopExperience={desktopExperience}
  turnChromeTopInset={turnChromeTopInset}
  isCorner={isCorner}
  newMessageBadgeCount={newMessageBadgeCount}
  newestJumpDiscShown={newestJumpDiscShown}
  landAtNewestMessage={landAtNewestMessage}
/>

            {/* P2: Archived channels are read-only */}
            {isArchived ? (
              <View style={[styles.archivedInputBar, readOnlyFooterInset]}>
                <Text
                  style={[styles.archivedInputText, isCorner && styles.cornerArchivedInputText]}
                >
                  {parentChannelId ? 'Corner' : ROOM_LABEL} archived (read-only)
                </Text>
              </View>
            ) : (
              <ChatSurfaceComposer
  desktopExperience={desktopExperience}
  setTurnChromeTopInset={setTurnChromeTopInset}
  composerAck={composerAck}
  stoppingThisTurn={stoppingThisTurn}
  handleStopTurn={handleStopTurn}
  settledTurn={settledTurn}
  transcriptHydrationFailed={transcriptHydrationFailed}
  transcriptHydrationError={transcriptHydrationError}
  retryHydration={retryHydration}
  isReadOnlyDirectMessage={isReadOnlyDirectMessage}
  readOnlyFooterInset={readOnlyFooterInset}
  composerBottomInsetStyle={composerBottomInsetStyle}
  slashMenuVisible={slashMenuVisible}
  mentionSlashAgentPubkey={mentionSlashAgentPubkey}
  agentByPubkey={agentByPubkey}
  slashVerbs={slashVerbs}
  currentSlashQuery={currentSlashQuery}
  mentionSlash={mentionSlash}
  highlightedSlashVerbIndex={highlightedSlashVerbIndex}
  dismissSlashMenu={dismissSlashMenu}
  runSlashVerb={runSlashVerb}
  mentionAgentCommands={mentionAgentCommands}
  mentionAgentLacksCommands={mentionAgentLacksCommands}
  selectAgentCommand={selectAgentCommand}
  mentionMenuVisible={mentionMenuVisible}
  highlightedMentionIndex={highlightedMentionIndex}
  keyboardHeight={keyboardHeight}
  mentionSuggestions={mentionSuggestions}
  selectMention={selectMention}
  personProfileByPubkey={personProfileByPubkey}
  channelMenuVisible={channelMenuVisible}
  channelSuggestions={channelSuggestions}
  selectChannel={selectChannel}
  activeChannel={activeChannel}
  cornerOpenRepoPrompt={cornerOpenRepoPrompt}
  roomRepoAccessIssue={roomRepoAccessIssue}
  handleReconnectRoomRepository={handleReconnectRoomRepository}
  setCornerOpenRepoPrompt={setCornerOpenRepoPrompt}
  canManageWorkspace={canManageWorkspace}
  decodedId={decodedId}
  roomRepoBusy={roomRepoBusy}
  roomRepoCandidates={roomRepoCandidates}
  githubInstallations={githubInstallations}
  roomRepoError={roomRepoError}
  roomRepoNotice={roomRepoNotice}
  ownerGrant={ownerGrant}
  handleAddGitHubAccount={handleAddGitHubAccount}
  handleAskOwnerGrant={handleAskOwnerGrant}
  handleCreateGitHubRepository={handleCreateGitHubRepository}
  handleManageGitHubInstallation={handleManageGitHubInstallation}
  handleSelectRoomRepoCandidate={handleSelectRoomRepoCandidate}
  desktopDeliveryState={desktopDeliveryState}
  isDirectMessage={isDirectMessage}
  roomSurface={roomSurface}
  isCorner={isCorner}
  voice={voice}
  composerRef={composerRef}
  replyTarget={replyTarget}
  setReplyTarget={setReplyTarget}
  composerTagHandles={composerTagHandles}
  pendingAttachments={pendingAttachments}
  attachmentUploader={attachmentUploader}
  sending={sending}
  replacePendingAttachments={replacePendingAttachments}
  transport={transport}
  speechHints={speechHints}
  inputText={inputText}
  composerInputRevision={composerInputRevision}
  composerInputRevisionRef={composerInputRevisionRef}
  composerHeight={composerHeight}
  composerFocused={composerFocused}
  chooseAttachment={chooseAttachment}
  handleDesktopDrop={handleDesktopDrop}
  handleDesktopPaste={handleDesktopPaste}
  inputTextRef={inputTextRef}
  setInputText={setInputText}
  setComposerHeight={setComposerHeight}
  setComposerFocused={setComposerFocused}
  selectHighlightedPaletteItem={selectHighlightedPaletteItem}
  paletteItemCount={paletteItemCount}
  setHighlightedSlashVerbIndex={setHighlightedSlashVerbIndex}
  suggestionCount={suggestionCount}
  handleSend={handleSend}
  setHighlightedMentionIndex={setHighlightedMentionIndex}
  setDismissedMentionKey={setDismissedMentionKey}
  mentionMenuKey={mentionMenuKey}
  channelMenuKey={channelMenuKey}
  setInputSelection={setInputSelection}
/>
            )}
          </KeyboardAvoidingView>
          {reportToast}
        </View>
<ChatSurfaceWorkPane
  profileAgentId={profileAgentId}
  desktopExperience={desktopExperience}
  activeCommunityId={activeCommunityId}
  profileKind={profileKind}
  setProfileAgentId={setProfileAgentId}
  decodedId={decodedId}
  desktopWorkPaneMounted={desktopWorkPaneMounted}
  desktopWorkPaneContent={desktopWorkPaneContent}
  roomClient={roomClient}
  channelReferenceIndex={channelReferenceIndex}
  handleOpenChannelReference={handleOpenChannelReference}
  displayedDesktopWorkPaneContent={displayedDesktopWorkPaneContent}
  openDesktopCorner={openDesktopCorner}
  desktopWorkRoomId={desktopWorkRoomId}
  expandDesktopCorner={expandDesktopCorner}
  closeDesktopWorkPane={closeDesktopWorkPane}
/>
      </RoomActionsBackground>

<ChatSurfaceOverlays
  attachmentPickerVisible={attachmentPickerVisible}
  setAttachmentPickerVisible={setAttachmentPickerVisible}
  pickDocument={pickDocument}
  pickPhoto={pickPhoto}
  desktopExperience={desktopExperience}
  pasteImage={pasteImage}
  setMessageActionsTarget={setMessageActionsTarget}
  messageActionsTarget={messageActionsTarget}
  handleReactToMessage={handleReactToMessage}
  messageIsBookmarked={messageIsBookmarked}
  handleBookmarkMessage={handleBookmarkMessage}
  handleReportMessage={handleReportMessage}
  handleCopyLedgerMessage={handleCopyLedgerMessage}
  handleSelectLedgerMessage={handleSelectLedgerMessage}
  decodedId={decodedId}
  beginReply={beginReply}
  beginForward={beginForward}
  canDeleteMessage={canDeleteMessage}
  handleDeleteMessage={handleDeleteMessage}
  setForwardCornerPrompt={setForwardCornerPrompt}
  confirmForwardToNewCorner={confirmForwardToNewCorner}
  forwardCornerPrompt={forwardCornerPrompt}
  forwardBusyRoomId={forwardBusyRoomId}
  forwardError={forwardError}
  setForwardTarget={setForwardTarget}
  setForwardRooms={setForwardRooms}
  setForwardError={setForwardError}
  forwardToRoom={forwardToRoom}
  forwardRooms={forwardRooms}
  forwardTarget={forwardTarget}
  insets={insets}
  roomSurface={roomSurface}
  isDirectMessage={isDirectMessage}
  roomMemberByPubkey={roomMemberByPubkey}
  membershipActionPubkey={membershipActionPubkey}
  membershipError={membershipError}
  visibleRosterMembers={visibleRosterMembers}
  setMembershipError={setMembershipError}
  setParticipantPickerKind={setParticipantPickerKind}
  openWorkspaceRoster={openWorkspaceRoster}
  setParticipantPickerVisible={setParticipantPickerVisible}
  closeRoster={closeRoster}
  handleRemoveRoomMember={handleRemoveRoomMember}
  handleOpenProfile={handleOpenProfile}
  speakerWorking={speakerWorking}
  parentChannelId={parentChannelId}
  personProfileByPubkey={personProfileByPubkey}
  userPubkey={userPubkey}
  memberManagement={memberManagement}
  renameBusy={renameBusy}
  closeRoomActions={closeRoomActions}
  canRenameTitle={canRenameTitle}
  startRenameFromTitle={startRenameFromTitle}
  displayRoomName={displayRoomName}
  roomActionsRef={roomActionsRef}
  roomRepoOptions={roomRepoOptions}
  conversationFrameRef={conversationFrameRef}
  isCorner={isCorner}
  renameEditing={renameEditing}
  setRenameDraft={setRenameDraft}
  setRenameError={setRenameError}
  handleRenameRoom={handleRenameRoom}
  renameDraft={renameDraft}
  setRenameEditing={setRenameEditing}
  roomRepository={roomRepository}
  canManageWorkspace={canManageWorkspace}
  applyRoomReviewer={applyRoomReviewer}
  pushMuteWorking={pushMuteWorking}
  togglePushMute={togglePushMute}
  pushMuted={pushMuted}
  roomParticipantTotal={roomParticipantTotal}
  participantsHydrated={participantsHydrated}
  setRoomActionsVisible={setRoomActionsVisible}
  setRosterVisible={setRosterVisible}
  activeCommunityId={activeCommunityId}
  roomLifecycleBusy={roomLifecycleBusy}
  handleRoomLifecycle={handleRoomLifecycle}
  renameError={renameError}
  setDmActionsVisible={setDmActionsVisible}
  dmActionsVisible={dmActionsVisible}
  viewerIsAgent={viewerIsAgent}
  headerTitle={headerTitle}
  cornerOwnerDisplay={cornerOwnerDisplay}
  cornerActionsVisible={cornerActionsVisible}
  transport={transport}
  setCornerActionsVisible={setCornerActionsVisible}
  handleBack={handleBack}
  readRoom={readRoom}
  addingMembers={addingMembers}
  memberInviteBusy={memberInviteBusy}
  participantPickerCandidates={participantPickerCandidates}
  participantPickerKind={participantPickerKind}
  participantPickerWorkspacePeers={participantPickerWorkspacePeers}
  handleAddRoomMembers={handleAddRoomMembers}
  handleConnectAgent={handleConnectAgent}
  handleInvitePerson={handleInvitePerson}
  agentPairBusy={agentPairBusy}
  agentConnectVisible={agentConnectVisible}
  agentPairError={agentPairError}
  closeAgentConnect={closeAgentConnect}
  connectAgent={connectAgent}
  copyPairCommand={copyPairCommand}
  agentPairCommand={agentPairCommand}
  createPollVisible={createPollVisible}
  createPollBusy={createPollBusy}
  setCreatePollVisible={setCreatePollVisible}
  handleCreatePoll={handleCreatePoll}
/>
    </BuzzCommunityShell>
  );
}
