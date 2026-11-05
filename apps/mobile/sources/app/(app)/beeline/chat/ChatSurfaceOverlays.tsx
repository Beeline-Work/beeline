import { appErrorCopy } from '@/buzz/app-error-copy';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { CornerActionsSheet } from '@/components/buzz/CornerActionsSheet';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import React from 'react';
import { View, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type RoomRepository, type MessageReactionEmoji } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, roomNameEntry, validRoomSlug } from '@/buzz/room-name';
import { formatRoomParticipantTotal } from '@/buzz/room-participants';
import { MemberPickerSheet, type MemberPickerCandidate } from '@/components/buzz/MemberPickerSheet';
import { agentActivityReplyExcerpt, canBeginReply } from '@/buzz/message-reply';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { type ForwardTarget } from '@/buzz/message-forward';
import { AttachmentPickerSheet } from '@/components/buzz/AttachmentPickerSheet';
import { ForwardMessagePickerSheet } from '@/components/buzz/ForwardMessagePickerSheet';
import { ForwardCornerSheet } from '@/components/buzz/ForwardCornerSheet';
import { MessageReactionStrip } from '@/components/buzz/MessageReactionStrip';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from '@/components/buzz/HullActionSheet';
import { RoomActionsSheet, type RoomActionsSheetHandle, type RoomRepositoryOptions } from '@/components/buzz/RoomRepositoryChoice';
import { RoomReviewerActions } from '@/components/buzz/RoomReviewerActions';
import { HullDialog, HullDialogInput } from '@/components/buzz/HullDialog';
import { type CornerOpenAttempt } from '@/buzz/open-random-corner';
import { RoomRosterSheet, type RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';
import { CreatePollSheet, type PollDraft } from '@/components/buzz/CreatePollSheet';
import { RoomMemberOption } from './chat-surface-values';
import { styles } from './chat-surface-styles';

type Props = {
  attachmentPickerVisible: boolean;
  setAttachmentPickerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  pickDocument: () => Promise<void>;
  pickPhoto: () => Promise<void>;
  desktopExperience: boolean;
  pasteImage: () => Promise<void>;
  setMessageActionsTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>;
  messageActionsTarget: ChatDisplayMessage | null;
  handleReactToMessage: (message: ChatDisplayMessage, emoji: MessageReactionEmoji) => Promise<void>;
  messageIsBookmarked: (message: ChatDisplayMessage) => boolean;
  handleBookmarkMessage: (message: ChatDisplayMessage) => Promise<void>;
  handleReportMessage: (message: ChatDisplayMessage) => Promise<void>;
  handleCopyLedgerMessage: (text: string) => void;
  handleSelectLedgerMessage: (text: string) => void;
  decodedId: string;
  beginReply: (message: ChatDisplayMessage) => void;
  beginForward: (message: ChatDisplayMessage) => Promise<void>;
  canDeleteMessage: (message: ChatDisplayMessage) => boolean;
  handleDeleteMessage: (message: ChatDisplayMessage) => Promise<void>;
  setForwardCornerPrompt: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>;
  confirmForwardToNewCorner: (retry?: { target: ChatDisplayMessage; attempt: CornerOpenAttempt; }) => Promise<void>;
  forwardCornerPrompt: ChatDisplayMessage | null;
  forwardBusyRoomId: string | null;
  forwardError: string | null;
  setForwardTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>;
  setForwardRooms: React.Dispatch<React.SetStateAction<readonly ForwardTarget[] | null>>;
  setForwardError: React.Dispatch<React.SetStateAction<string | null>>;
  forwardToRoom: (target: ForwardTarget) => Promise<void>;
  forwardRooms: readonly ForwardTarget[] | null;
  forwardTarget: ChatDisplayMessage | null;
  insets: import("react-native-safe-area-context/lib/typescript/src/SafeArea.types").EdgeInsets;
  roomSurface: NonNullable<import("@beeline/api-contract/phone").RoomView | null>;
  isDirectMessage: boolean;
  roomMemberByPubkey: Map<string, { pubkey: string; role: "owner" | "admin" | "member" | "spectator"; }>;
  membershipActionPubkey: string | null;
  membershipError: string | null;
  visibleRosterMembers: RoomRosterParticipant[];
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>;
  setParticipantPickerKind: React.Dispatch<React.SetStateAction<"agent" | "person" | null>>;
  openWorkspaceRoster: () => void;
  setParticipantPickerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  closeRoster: () => void;
  handleRemoveRoomMember: (participant: RoomMemberOption) => Promise<void>;
  handleOpenProfile: (agentId: string, kind?: "human" | "agent") => void;
  speakerWorking: Readonly<Record<string, true>>;
  parentChannelId: string | undefined;
  personProfileByPubkey: Map<string, { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; }>;
  userPubkey: string;
  memberManagement: { canOpenRoster: boolean; rosterVisible: boolean; pickerVisible: boolean; };
  renameBusy: boolean;
  closeRoomActions: () => void;
  canRenameTitle: boolean;
  startRenameFromTitle: () => void;
  displayRoomName: string;
  roomActionsRef: React.RefObject<RoomActionsSheetHandle | null>;
  roomRepoOptions: RoomRepositoryOptions;
  conversationFrameRef: React.RefObject<View | null>;
  isCorner: boolean;
  renameEditing: boolean;
  setRenameDraft: (update: string | ((previous: string) => string)) => void;
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>;
  handleRenameRoom: () => Promise<void>;
  renameDraft: string;
  setRenameEditing: React.Dispatch<React.SetStateAction<boolean>>;
  roomRepository: RoomRepository | null;
  canManageWorkspace: boolean;
  applyRoomReviewer: (reviewerAgentId: string | undefined) => void;
  pushMuteWorking: boolean;
  togglePushMute: () => Promise<void>;
  pushMuted: boolean;
  roomParticipantTotal: number;
  participantsHydrated: boolean;
  setRoomActionsVisible: (visible: boolean) => void | undefined;
  setRosterVisible: React.Dispatch<React.SetStateAction<boolean>>;
  activeCommunityId: string | null;
  roomLifecycleBusy: boolean;
  handleRoomLifecycle: (action: "delete" | "leave") => Promise<void>;
  renameError: string | null;
  setDmActionsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  dmActionsVisible: boolean;
  viewerIsAgent: boolean;
  headerTitle: string | null;
  cornerOwnerDisplay: import("@/buzz/agent-display").AgentDisplayIdentity | null | undefined;
  cornerActionsVisible: boolean;
  transport: BuzzRigTransport | null;
  setCornerActionsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  handleBack: () => void;
  readRoom: () => void;
  addingMembers: boolean;
  memberInviteBusy: boolean;
  participantPickerCandidates: MemberPickerCandidate[] | null;
  participantPickerKind: "agent" | "person" | null;
  participantPickerWorkspacePeers: number;
  handleAddRoomMembers: (pubkeys: string[]) => Promise<void>;
  handleConnectAgent: () => void;
  handleInvitePerson: () => Promise<void>;
  agentPairBusy: boolean;
  agentConnectVisible: boolean;
  agentPairError: string | null;
  closeAgentConnect: () => void;
  connectAgent: () => Promise<void>;
  copyPairCommand: (command: string) => Promise<void>;
  agentPairCommand: string | null;
  createPollVisible: boolean;
  createPollBusy: boolean;
  setCreatePollVisible: React.Dispatch<React.SetStateAction<boolean>>;
  handleCreatePoll: (draft: PollDraft) => Promise<boolean>;
};
export function ChatSurfaceOverlays({
  attachmentPickerVisible,
  setAttachmentPickerVisible,
  pickDocument,
  pickPhoto,
  desktopExperience,
  pasteImage,
  setMessageActionsTarget,
  messageActionsTarget,
  handleReactToMessage,
  messageIsBookmarked,
  handleBookmarkMessage,
  handleReportMessage,
  handleCopyLedgerMessage,
  handleSelectLedgerMessage,
  decodedId,
  beginReply,
  beginForward,
  canDeleteMessage,
  handleDeleteMessage,
  setForwardCornerPrompt,
  confirmForwardToNewCorner,
  forwardCornerPrompt,
  forwardBusyRoomId,
  forwardError,
  setForwardTarget,
  setForwardRooms,
  setForwardError,
  forwardToRoom,
  forwardRooms,
  forwardTarget,
  insets,
  roomSurface,
  isDirectMessage,
  roomMemberByPubkey,
  membershipActionPubkey,
  membershipError,
  visibleRosterMembers,
  setMembershipError,
  setParticipantPickerKind,
  openWorkspaceRoster,
  setParticipantPickerVisible,
  closeRoster,
  handleRemoveRoomMember,
  handleOpenProfile,
  speakerWorking,
  parentChannelId,
  personProfileByPubkey,
  userPubkey,
  memberManagement,
  renameBusy,
  closeRoomActions,
  canRenameTitle,
  startRenameFromTitle,
  displayRoomName,
  roomActionsRef,
  roomRepoOptions,
  conversationFrameRef,
  isCorner,
  renameEditing,
  setRenameDraft,
  setRenameError,
  handleRenameRoom,
  renameDraft,
  setRenameEditing,
  roomRepository,
  canManageWorkspace,
  applyRoomReviewer,
  pushMuteWorking,
  togglePushMute,
  pushMuted,
  roomParticipantTotal,
  participantsHydrated,
  setRoomActionsVisible,
  setRosterVisible,
  activeCommunityId,
  roomLifecycleBusy,
  handleRoomLifecycle,
  renameError,
  setDmActionsVisible,
  dmActionsVisible,
  viewerIsAgent,
  headerTitle,
  cornerOwnerDisplay,
  cornerActionsVisible,
  transport,
  setCornerActionsVisible,
  handleBack,
  readRoom,
  addingMembers,
  memberInviteBusy,
  participantPickerCandidates,
  participantPickerKind,
  participantPickerWorkspacePeers,
  handleAddRoomMembers,
  handleConnectAgent,
  handleInvitePerson,
  agentPairBusy,
  agentConnectVisible,
  agentPairError,
  closeAgentConnect,
  connectAgent,
  copyPairCommand,
  agentPairCommand,
  createPollVisible,
  createPollBusy,
  setCreatePollVisible,
  handleCreatePoll,
}: Props) { return <>
      <AttachmentPickerSheet
        visible={attachmentPickerVisible}
        onClose={() => setAttachmentPickerVisible(false)}
        onPickDocument={() => void pickDocument()}
        onPickPhoto={() => void pickPhoto()}
        onPickPasted={desktopExperience ? undefined : () => void pasteImage()}
      />

      <HullActionSheetModal
        accessibilityLabel="Close message actions"
        onClose={() => setMessageActionsTarget(null)}
        testID="message-actions-sheet"
        title="Message"
        visible={Boolean(messageActionsTarget)}
      >
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          // The reaction entry point is the emoji scroll itself — the sheet's
          // top cell, with no React row and nothing to expand above it.
          <MessageReactionStrip
            onReact={(emoji) => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleReactToMessage(target, emoji);
            }}
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel={
              messageIsBookmarked(messageActionsTarget) ? 'Remove bookmark' : 'Bookmark message'
            }
            label={messageIsBookmarked(messageActionsTarget) ? 'Remove bookmark' : 'Bookmark'}
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleBookmarkMessage(target);
            }}
            testID="message-bookmark-action"
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel="Report an issue with this message"
            label="Report issue"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleReportMessage(target);
            }}
            testID="message-report-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Copy message text"
            label="Copy"
            onPress={() => {
              handleCopyLedgerMessage(
                messageActionsTarget.isAgentActivity
                  ? agentActivityReplyExcerpt(messageActionsTarget)
                  : messageActionsTarget.text,
              );
              setMessageActionsTarget(null);
            }}
            testID="message-copy-action"
          />
        ) : null}
        {messageActionsTarget ? (
          <HullActionSheetRow
            accessibilityLabel="Select message text"
            label="Select"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) {
                handleSelectLedgerMessage(
                  target.isAgentActivity ? agentActivityReplyExcerpt(target) : target.text,
                );
              }
            }}
            testID="message-select-action"
          />
        ) : null}
        {messageActionsTarget && canBeginReply(messageActionsTarget, decodedId) ? (
          <HullActionSheetRow
            accessibilityLabel="Reply to message"
            label="Reply"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) beginReply(target);
            }}
            testID="message-reply-action"
          />
        ) : null}
        {messageActionsTarget && !messageActionsTarget.isAgentActivity ? (
          <HullActionSheetRow
            accessibilityLabel="Forward message"
            label="Forward"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void beginForward(target);
            }}
            testID="message-forward-action"
          />
        ) : null}
        {messageActionsTarget && canDeleteMessage(messageActionsTarget) ? (
          <HullActionSheetRow
            accessibilityLabel="Delete message"
            destructive
            label="Delete"
            onPress={() => {
              const target = messageActionsTarget;
              setMessageActionsTarget(null);
              if (target) void handleDeleteMessage(target);
            }}
            testID="message-delete-action"
          />
        ) : null}
        <HullActionSheetCancel
          onPress={() => setMessageActionsTarget(null)}
          testID="message-actions-close"
        />
      </HullActionSheetModal>

      <ForwardCornerSheet
        onClose={() => setForwardCornerPrompt(null)}
        onOpen={() => void confirmForwardToNewCorner()}
        visible={Boolean(forwardCornerPrompt)}
      />

      <ForwardMessagePickerSheet
        draftContext={decodedId}
        busyRoomId={forwardBusyRoomId}
        error={forwardError}
        onClose={() => {
          if (forwardBusyRoomId) return;
          setForwardTarget(null);
          setForwardRooms(null);
          setForwardError(null);
        }}
        onForward={(target) => void forwardToRoom(target)}
        targets={forwardRooms}
        visible={Boolean(forwardTarget)}
      />

      <RoomRosterSheet
        bottomInset={insets.bottom}
        canManage={roomSurface?.viewer.permissions.manage ?? false}
        isDirectMessage={isDirectMessage}
        memberByPubkey={roomMemberByPubkey}
        membershipActionPubkey={membershipActionPubkey}
        membershipError={membershipError}
        members={visibleRosterMembers}
        onAddMembers={() => {
          setMembershipError(null);
          // One counted Members section owns one add control, so the picker it
          // opens lists both kinds and carries its own invite-a-person and
          // connect-an-agent rows.
          setParticipantPickerKind(null);
          openWorkspaceRoster();setParticipantPickerVisible(true);
        }}
        onClose={closeRoster}
        onRemove={handleRemoveRoomMember}
        onOpenProfile={(participant) =>
          handleOpenProfile(participant.pubkey, participant.kind === 'agent' ? 'agent' : 'human')
        }
        workingByPubkey={speakerWorking}
        parentChannelId={parentChannelId ?? null}
        personProfileByPubkey={personProfileByPubkey}
        userPubkey={userPubkey}
        visible={memberManagement.rosterVisible}
      />

      <RoomActionsSheet
        accessibilityLabel={`Close ${ROOM_LABEL} actions`}
        dismissOnBackdrop={!renameBusy}
        onClose={closeRoomActions}
        onTitlePress={canRenameTitle ? startRenameFromTitle : undefined}
        testID="room-actions-sheet"
        title={displayRoomName}
        titleAccessibilityLabel={`Rename ${displayRoomName}`}
        titleTestID="room-actions-title"
        ref={roomActionsRef}
        repository={roomRepoOptions}
        backgroundRef={conversationFrameRef}
      >
        <>
            {!isCorner && canRenameTitle && renameEditing && (
              <View style={styles.roomRenameEditor} testID="rename-room-editor">
                <Text style={styles.roomRenameLabel}>New {ROOM_LABEL.toLowerCase()} name</Text>
                <HullDialogInput
                  accessibilityLabel={`New ${ROOM_LABEL} name`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!renameBusy}
                  onChangeText={(value) => {
                    setRenameDraft(roomNameEntry(value));
                    if (value.trim()) setRenameError(null);
                  }}
                  onSubmitEditing={() => void handleRenameRoom()}
                  returnKeyType="done"
                  selectTextOnFocus
                  style={styles.roomRenameInput}
                  testID="rename-room-input"
                  value={renameDraft}
                />
                {!validRoomSlug(renameDraft.trim()) && (
                  <Text style={styles.roomRenameLabel}>{ROOM_SLUG_HINT}</Text>
                )}
                <HullDialogActions style={styles.roomRenameControls} actions={[{ disabled: renameBusy, label: "Cancel", onPress: () => {
                      setRenameEditing(false);
                      setRenameError(null);
                    }, variant: "quiet" }, { disabled: renameBusy || !validRoomSlug(renameDraft.trim()), label: renameBusy ? 'Renaming…' : 'Save', loading: renameBusy, onPress: () => void handleRenameRoom(), testID: "apply-room-rename", variant: 'primary' }]} />
              </View>
            )}
            <RoomReviewerActions
              agents={(roomSurface?.members ?? [])
                .filter((member) => member.identity.kind === 'agent')
                .map((member) => member.identity)}
              allowAutoMerge={roomRepository?.allowAutoMerge}
              canManage={canManageWorkspace}
              hasRepository={roomRepository !== null}
              onSaved={(reviewer) => applyRoomReviewer(reviewer ?? undefined)}
              reviewerAgentId={roomSurface?.room.reviewerAgentId}
              roomId={decodedId}
              roomName={displayRoomName}
              updateRoom={(input) => monolithPhoneOperation('updateRoom', input)}
            />
            <HullActionSheetRow
              label="Mute notifications"
              accessibilityLabel={`Mute notifications in this ${ROOM_LABEL} and its ${CORNER_LABEL}s`}
              description="Tags and replies still notify you."
              disabled={pushMuteWorking}
              onPress={() => void togglePushMute()}
              toggle={{
                value: pushMuted,
                disabled: pushMuteWorking,
                onValueChange: () => void togglePushMute(),
              }}
              testID="room-push-mute"
            />
            <HullActionSheetRow
              accessibilityLabel={`View ${formatRoomParticipantTotal(roomParticipantTotal)}`}
              chevron="right"
              disabled={!memberManagement.canOpenRoster}
              label="Members"
              metadata={
                participantsHydrated ? formatRoomParticipantTotal(roomParticipantTotal) : 'Loading'
              }
              onPress={() => {
                setRoomActionsVisible(false);
                openWorkspaceRoster();setRosterVisible(true);
              }}
              testID="room-participant-roster-trigger"
            />
            {canManageWorkspace && (
              <HullActionSheetRow
                accessibilityLabel={`View ${ROOM_LABEL} schedules and subscriptions`}
                chevron="right"
                label="Schedules and subscriptions"
                onPress={() => {
                  setRoomActionsVisible(false);
                  router.push({
                    pathname: '/beeline/settings/schedules',
                    params: { roomId: decodedId, workspaceId: activeCommunityId },
                  } as unknown as Href);
                }}
                testID="room-schedules-action"
              />
            )}
            {canManageWorkspace && (
              <HullActionSheetRow
                accessibilityLabel={`Delete ${ROOM_LABEL}`}
                destructive
                disabled={roomLifecycleBusy}
                label={roomLifecycleBusy ? 'Deleting…' : `Delete ${ROOM_LABEL}`}
                onPress={() => void handleRoomLifecycle('delete')}
                testID="delete-room-action"
              />
            )}
            <HullActionSheetRow
              accessibilityLabel={`Leave ${ROOM_LABEL}`}
              destructive
              disabled={roomLifecycleBusy}
              label={roomLifecycleBusy ? 'Leaving…' : `Leave ${ROOM_LABEL}`}
              onPress={() => void handleRoomLifecycle('leave')}
              testID="leave-room-action"
            />
            {(renameError || membershipError) && (
              <View accessibilityRole="alert" style={styles.membershipError}>
                <ErrorBanner inline title={renameError ?? membershipError ?? ''} />
              </View>
            )}
        </>
      </RoomActionsSheet>

      <HullActionSheetModal
        accessibilityLabel="Close conversation actions"
        onClose={() => setDmActionsVisible(false)}
        testID="dm-actions-sheet"
        title={displayRoomName}
        visible={dmActionsVisible}
      >
        <HullActionSheetRow
          label="Mute notifications"
          accessibilityLabel="Mute notifications from this conversation"
          disabled={pushMuteWorking}
          onPress={() => void togglePushMute()}
          toggle={{
            value: pushMuted,
            disabled: pushMuteWorking,
            onValueChange: () => void togglePushMute(),
          }}
          testID="dm-push-mute"
        />
        {!viewerIsAgent && roomSurface?.viewer.permissions.send && (
          <HullActionSheetRow
            accessibilityLabel="View conversation schedules and subscriptions"
            chevron="right"
            label="Schedules and subscriptions"
            onPress={() => {
              setDmActionsVisible(false);
              router.push({
                pathname: '/beeline/settings/schedules',
                params: { roomId: decodedId, workspaceId: activeCommunityId },
              } as unknown as Href);
            }}
            testID="dm-schedules-action"
          />
        )}
        {membershipError && (
          <View accessibilityRole="alert" style={styles.membershipError}>
            <ErrorBanner inline title={membershipError} />
          </View>
        )}
        <HullActionSheetCancel
          onPress={() => setDmActionsVisible(false)}
          testID="dm-actions-close"
        />
      </HullActionSheetModal>

      <CornerActionsSheet
        title={headerTitle ?? cornerOwnerDisplay?.name ?? CORNER_LABEL}
        visible={cornerActionsVisible}
        locked={roomSurface?.cornerLocked === true}
        connected={Boolean(transport)}
        onClose={() => setCornerActionsVisible(false)}
        closeCorner={async () => {
          if (!transport) throw new Error('Still connecting. Try again in a moment.');
          await transport.closeCorner(decodedId);
        }}
        setLocked={async (locked) => {
          if (!transport) throw new Error('Still connecting. Try again in a moment.');
          await transport.setCornerLocked(decodedId, locked);
        }}
        onClosed={() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          handleBack();
        }}
        onSaved={() => readRoom()}
        onError={(error) => {
          readRoom();
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Modal.alert('Could not complete request', appErrorCopy(error));
        }}
      />

      <HullDialog
        actions={[
          {
            disabled: renameBusy,
            label: 'Cancel',
            onPress: () => {
              setRenameEditing(false);
              setRenameError(null);
            },
          },
          {
            busy: renameBusy,
            disabled: renameBusy || !renameDraft.trim(),
            label: renameBusy ? 'Renaming' : 'Apply',
            onPress: () => void handleRenameRoom(),
            testID: 'apply-corner-rename',
            variant: 'primary',
          },
        ]}
        dismissOnBackdrop={!renameBusy}
        onRequestClose={() => {
          if (renameBusy) return;
          setRenameEditing(false);
          setRenameError(null);
        }}
        testID="rename-corner-dialog"
        title={`Rename ${CORNER_LABEL}`}
        visible={isCorner && renameEditing}
      >
        <HullDialogInput
          accessibilityLabel={`New ${CORNER_LABEL} name`}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          editable={!renameBusy}
          maxLength={120}
          onChangeText={(value) => {
            setRenameDraft(roomNameEntry(value));
            if (value.trim()) setRenameError(null);
          }}
          onSubmitEditing={() => void handleRenameRoom()}
          returnKeyType="done"
          selectTextOnFocus
          testID="rename-corner-input"
          value={renameDraft}
        />
        {renameError ? (
          <ErrorBanner inline title={renameError} />
        ) : null}
      </HullDialog>

      <MemberPickerSheet
        busy={addingMembers || memberInviteBusy}
        canManage={roomSurface?.viewer.permissions.manage ?? false}
        canConnectAgent
        candidates={participantPickerCandidates}
        error={membershipError}
        kind={participantPickerKind}
        workspacePeerCount={participantPickerWorkspacePeers}
        onAdd={(pubkeys) => void handleAddRoomMembers(pubkeys)}
        onClose={() => setParticipantPickerVisible(false)}
        onConnectAgent={handleConnectAgent}
        onInvitePerson={() => void handleInvitePerson()}
        visible={memberManagement.pickerVisible}
      />
      <MemberPickerSheet
        agentConnectOnly
        busy={agentPairBusy}
        canManage={canManageWorkspace}
        canConnectAgent={!viewerIsAgent}
        candidates={undefined}
        error={agentConnectVisible ? agentPairError : null}
        onAdd={() => undefined}
        onClose={closeAgentConnect}
        onConnectAgent={() => void connectAgent()}
        onCopyPairCommand={(command) => void copyPairCommand(command)}
        onInvitePerson={() => undefined}
        pairCommand={agentPairCommand}
        testID="room-agent-connect-sheet"
        visible={agentConnectVisible}
      />
      <CreatePollSheet
        draftContext={decodedId}
        visible={createPollVisible}
        busy={createPollBusy}
        onClose={() => setCreatePollVisible(false)}
        onCreate={handleCreatePoll}
      />

</>; }
