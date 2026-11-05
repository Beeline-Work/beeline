import { DesktopRoomListToggle } from '@/components/buzz/DesktopRoomListToggle';
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { type RoomRepository, type ChatListItem } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { CHANGES_LABEL, CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { openExternalUrl } from '@/utils/open-external-url';
import { RoomRepositorySubtitle } from '@/components/buzz/RoomRepositorySubtitle';
import { cornerHeaderAgent } from '@/buzz/corner-display-state';
import { roomRepoChipLabel } from '@/buzz/room-repo-picker';
import { requestMessageJump } from '@/buzz/transcript-scroll-controller';
import { roomCornersHref } from '@/buzz/corner-navigation';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { CornerGlyph } from '@/components/buzz/CornerGlyph';
import { OverflowGlyph } from '@/components/buzz/OverflowGlyph';
import { CornerHeaderAgentText, HeaderIdentitySlot, HeaderMetaCaps, HeaderMetaRow } from '@/components/buzz/HeaderLadder';
import { ChannelHeaderTitle } from '@/components/buzz/ChannelHeaderTitle';
import type { ChannelHeaderKind } from '@/buzz/channel-header-title';
import { type CornerOpenAttempt } from '@/buzz/open-random-corner';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { DirectMessageHeaderIdentity } from '@/components/buzz/DirectMessageHeaderIdentity';
import { styles } from './chat-surface-styles';
import { HEADER_EDGE_HIT_SLOP, HEADER_MARK_SIZE } from './chat-surface-values';

type Props = {
  insets: import("react-native-safe-area-context/lib/typescript/src/SafeArea.types").EdgeInsets;
  isCorner: boolean;
  desktopExperience: boolean;
  isDesktop: boolean;
  cornerReturnTarget: "corners" | "room-list" | undefined;
  handleBack: () => void;
  cornerOwnerPubkey: string | undefined;
  cornerOwnerDisplay: import("@/buzz/agent-display").AgentDisplayIdentity | null | undefined;
  cornerOwnerWorking: boolean;
  isDirectMessage: boolean;
  isReadOnlyDirectMessage: boolean;
  dmPeerPubkey: string | undefined;
  dmPeerIdentity: import("@beeline/api-contract/phone").RoomViewIdentity | undefined;
  directMessageListItem: ChatListItem | null;
  dmPeerAgentDisplay: import("@/buzz/agent-display").AgentDisplayIdentity | undefined;
  dmPeerProfile: { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; } | undefined;
  displayRoomName: string;
  displayHeaderTitle: string | null;
  headerTitleKind: ChannelHeaderKind;
  canRenameTitle: boolean;
  startRenameFromTitle: () => void;
  setRoomActionsVisible: (visible: boolean) => void | undefined;
  handleOpenGitHubEvent: (url: string) => void;
  roomRepository: RoomRepository | null;
  cornerHeaderWord: string | undefined;
  cornerHeaderDisplay: import("@/buzz/corner-display-state").CornerDisplayState | undefined;
  cornerHeaderSource: import("@/buzz/corner-display-state").CornerDisplayItem | undefined;
  viewerPubkey: string | undefined;
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>;
  jumpToTranscriptMessage: (messageId: string) => void;
  dmHeaderPresence: string;
  parentChannelId: string | undefined;
  handleOpenRandomCorner: (attempt?: CornerOpenAttempt) => Promise<void>;
  decodedId: string;
  viewerIsAgent: boolean;
  isArchived: boolean;
  setCornerActionsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>;
  setDmActionsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setRenameEditing: React.Dispatch<React.SetStateAction<boolean>>;
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>;
};

export function ChatSurfaceHeaderView({
  insets,
  isCorner,
  desktopExperience,
  isDesktop,
  cornerReturnTarget,
  handleBack,
  cornerOwnerPubkey,
  cornerOwnerDisplay,
  cornerOwnerWorking,
  isDirectMessage,
  isReadOnlyDirectMessage,
  dmPeerPubkey,
  dmPeerIdentity,
  directMessageListItem,
  dmPeerAgentDisplay,
  dmPeerProfile,
  displayRoomName,
  displayHeaderTitle,
  headerTitleKind,
  canRenameTitle,
  startRenameFromTitle,
  setRoomActionsVisible,
  handleOpenGitHubEvent,
  roomRepository,
  cornerHeaderWord,
  cornerHeaderDisplay,
  cornerHeaderSource,
  viewerPubkey,
  scrollController,
  jumpToTranscriptMessage,
  dmHeaderPresence,
  parentChannelId,
  handleOpenRandomCorner,
  decodedId,
  viewerIsAgent,
  isArchived,
  setCornerActionsVisible,
  setMembershipError,
  setDmActionsVisible,
  setRenameEditing,
  setRenameError,
}: Props) {
  return (<View
            style={[styles.header, { minHeight: insets.top + 60, paddingTop: insets.top + 8 }]}
            testID={isCorner ? 'corner-session-header' : undefined}
          >
            {desktopExperience && <DesktopRoomListToggle />}
            {(!isDesktop || isCorner) && (
              <TouchableOpacity
                accessibilityLabel={
                  isCorner && cornerReturnTarget === 'corners'
                    ? `Back to this ${ROOM_LABEL}’s ${CHANGES_LABEL}`
                    : isCorner && cornerReturnTarget !== 'room-list'
                      ? 'Back'
                      : 'Back to Rooms'
                }
                accessibilityRole="button"
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onPress={handleBack}
                style={styles.backButton}
                testID="chat-back"
              >
                <ChevronGlyph
                  color={isCorner ? styles.cornerBackText.color : styles.backText.color}
                  direction="left"
                  size={CHEVRON_BACK_SIZE}
                  testID="chat-back-glyph"
                />
              </TouchableOpacity>
            )}
            {/*
            The corner's opener, stated here once and never repeated on a
            message. A reviewer or helper holding a live turn in the corner
            never swaps this mark or the name under it: their work is
            attributed in the transcript, and the state word reads
            `reviewing` while it runs.
          */}
            {isCorner && cornerOwnerPubkey && (
              <HeaderIdentitySlot testID="corner-header-agent">
                <IdentityMark
                  kind="agent"
                  seed={cornerOwnerDisplay?.avatarSeed ?? cornerOwnerPubkey}
                  avatarUrl={cornerOwnerDisplay?.avatarUrl}
                  face={cornerOwnerDisplay?.face}
                  name={cornerOwnerDisplay?.name ?? 'Agent'}
                  size={26}
                  alive={cornerOwnerWorking}
                />
              </HeaderIdentitySlot>
            )}
            <DirectMessageHeaderIdentity
              isDirectMessage={isDirectMessage}
              readOnly={isReadOnlyDirectMessage}
              peerPubkey={dmPeerPubkey}
              connectorAvatarUrl={
                dmPeerIdentity?.avatar ?? directMessageListItem?.directMessage?.peer.avatar
              }
              kind={dmPeerAgentDisplay || dmPeerIdentity?.kind === 'agent' ? 'agent' : 'human'}
              seed={dmPeerAgentDisplay?.avatarSeed}
              avatarUrl={
                dmPeerAgentDisplay?.avatarUrl ??
                dmPeerIdentity?.avatar ??
                directMessageListItem?.directMessage?.peer.avatar ??
                dmPeerProfile?.avatar
              }
              face={dmPeerAgentDisplay?.face ?? dmPeerIdentity?.face ?? dmPeerProfile?.face}
              name={displayRoomName}
            />
            <View style={styles.headerCenter}>
              {displayHeaderTitle === null ? (
                // The channel's own name has not landed yet. Neither "Room" nor
                // a corner slug would be true, so show neither.
                <View
                  accessibilityLabel="Loading name"
                  style={[styles.channelNameSkeleton, isCorner && styles.cornerChannelNameSkeleton]}
                  testID="chat-title-skeleton"
                />
              ) : (
                <ChannelHeaderTitle
                  kind={headerTitleKind}
                  numberOfLines={1}
                  onLongPress={canRenameTitle ? startRenameFromTitle : undefined}
                  onPress={
                    !isCorner && !isDirectMessage ? () => setRoomActionsVisible(true) : undefined
                  }
                  title={displayHeaderTitle}
                />
              )}
              {!isCorner && (
                <RoomRepositorySubtitle
                  onOpenUrl={handleOpenGitHubEvent}
                  repositoryName={roomRepoChipLabel(roomRepository)}
                />
              )}
              {isCorner ? (
                <HeaderMetaRow>
                  <CornerHeaderAgentText
                    name={cornerOwnerDisplay?.name ?? 'Agent'}
                    stateWord={cornerHeaderWord}
                    state={cornerHeaderDisplay?.status}
                    headerSuffix={cornerHeaderDisplay?.headerSuffix}
                    waitingReason={cornerHeaderSource?.reason}
                    blocker={cornerHeaderSource?.blocker}
                    viewerId={viewerPubkey}
                    onReasonPress={cornerHeaderSource?.blocker?.url ? () => {
                      void openExternalUrl(cornerHeaderSource.blocker!.url!);
                    } : cornerHeaderSource?.itemId ? () => {
                      requestMessageJump(scrollController, cornerHeaderSource.itemId!, jumpToTranscriptMessage);
                    } : undefined}
                    style={[
                      styles.cornerHeaderAgent,
                      cornerHeaderDisplay?.status === 'working'
                        ? styles.cornerHeaderWorking
                        : cornerHeaderDisplay?.status === 'review'
                          ? styles.cornerHeaderReview
                          : cornerHeaderDisplay?.status === 'archived'
                            ? styles.cornerHeaderArchived
                            : styles.cornerHeaderWaiting,
                    ]}
                  />
                </HeaderMetaRow>
              ) : isDirectMessage ? (
                <HeaderMetaCaps testID="room-header-meta">{dmHeaderPresence}</HeaderMetaCaps>
              ) : null}
            </View>
            {/* Membership still consumes no header width: the Members row lives
              in the Room and corner overflow sheets. The desktop work pane
              does not carry it. The trailing slot is the Room's corners door —
              now the ONE active-corner affordance, since the pinned line above
              the composer is gone. A lone brass `◇` a few pixels from the
              overflow dots read as decoration on the menu rather than as a
              destination of its own, so the door is NAMED, the way every rail
              command is: the mark states the kind, the word states where it
              goes, and the pair's boxes touch like the Room-list chrome. */}
            {/* Desktop corners carry the parent Room's door too, so its long
              press opens a sibling corner as it does in the Room. */}
            {(!parentChannelId || desktopExperience) && !isDirectMessage && (
              <TouchableOpacity
                accessibilityHint="Long press to open a new corner"
                accessibilityLabel={`${ROOM_LABEL} ${CHANGES_LABEL}`}
                accessibilityRole="button"
                delayLongPress={450}
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onLongPress={() => void handleOpenRandomCorner()}
                onPress={() => router.push(roomCornersHref(parentChannelId ?? decodedId))}
                style={styles.roomCornersButton}
                testID="room-corners-menu"
              >
                <CornerGlyph
                  color={styles.roomCornersGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="room-corners-glyph"
                />
              </TouchableOpacity>
            )}
            {isCorner && !viewerIsAgent && !isArchived && (
              <TouchableOpacity
                accessibilityLabel={`${CORNER_LABEL} actions`}
                accessibilityRole="button"
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onPress={() => setCornerActionsVisible(true)}
                style={styles.roomActionsButton}
                testID="corner-actions-menu"
              >
                <OverflowGlyph
                  color={styles.roomActionsGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="corner-actions-glyph"
                />
              </TouchableOpacity>
            )}
            {isDirectMessage &&
              !viewerIsAgent &&
              !isArchived && (
                <TouchableOpacity
                  accessibilityLabel="Conversation actions"
                  accessibilityRole="button"
                  hitSlop={HEADER_EDGE_HIT_SLOP}
                  onPress={() => {
                    setMembershipError(null);
                    setDmActionsVisible(true);
                  }}
                  style={styles.roomActionsButton}
                  testID="dm-actions-menu"
                >
                  <OverflowGlyph
                    color={styles.roomActionsGlyph.color}
                    size={HEADER_MARK_SIZE}
                    testID="dm-actions-glyph"
                  />
                </TouchableOpacity>
              )}
            {!parentChannelId && !isDirectMessage && !viewerIsAgent && !isArchived && (
              <TouchableOpacity
                accessibilityLabel={`${ROOM_LABEL} actions`}
                accessibilityRole="button"
                hitSlop={HEADER_EDGE_HIT_SLOP}
                onPress={() => {
                  setMembershipError(null);
                  setRenameEditing(false);
                  setRenameError(null);
                  setRoomActionsVisible(true);
                }}
                style={styles.roomClusteredActionsButton}
                testID="room-actions-menu"
              >
                <OverflowGlyph
                  color={styles.roomActionsGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="room-actions-glyph"
                />
              </TouchableOpacity>
            )}
            {isArchived && (
              <View style={styles.archivedBadge}>
                <Text style={styles.archivedBadgeText}>archived</Text>
              </View>
            )}
          </View>);
}
