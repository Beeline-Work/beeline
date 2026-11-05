import { useChannelsRouteState } from './useChannelsRouteState';
import { useChannelsPresentation } from './useChannelsPresentation';
import { useChannelsRequestedActions } from './useChannelsRequestedActions';
import { useChannelsRoomActions } from './useChannelsRoomActions';
import { useChannelsSubscriptions } from './useChannelsSubscriptions';
import { useChannelsNavigation } from './useChannelsNavigation';
import { useChannelsRepositories } from './useChannelsRepositories';
import { useChannelsCompose } from './useChannelsCompose';
import { EmptyState } from '@/components/buzz/EmptyState';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { IndexRow } from '@/components/buzz/IndexRow';
import { invalidatesWorkspaceList } from '@/buzz/workspace-list-invalidation';
import { TrayGlyph } from '@/components/buzz/TrayGlyph';
import { takePendingBrowserShare } from '@/buzz/pending-browser-share';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { useTextDraft } from '@/buzz/use-text-draft';
import { useRoomSearch } from '@/buzz/use-room-search';
import { useScopedCallbacks } from '@/buzz/use-stable';
import {
  useNeedsYouCount,
} from '@/buzz/needs-you-store';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';

import { acquireChatList, type ChatListHandle } from '@/buzz/chat-list-store';
import { saveActiveCommunityId, saveLastViewedChannel, watchActiveCommunityId } from '@/buzz/community-storage';
import { cornerHref, navigateToRoom } from '@/buzz/corner-navigation';
import { useCornerDropdowns } from '@/buzz/corner-dropdowns';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { loadPendingInvite } from '@/buzz/pending-invite';
import { deckLanding } from '@/buzz/deck-landing';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import {
  filterConversations,
  roomListCounts,
  useRoomPins,
  useRoomListFilter,
} from '@/buzz/room-list-preferences';
import { openRoomListCorner } from '@/buzz/room-list-new-corner';
import { cornerOpenTappedAgain } from '@/buzz/corner-open-status';
import type { CornerOpenAttempt } from '@/buzz/open-random-corner';
import { roomListSections, roomRowName } from '@/buzz/room-list-row';
import { useRoomListGestures } from '@/buzz/use-room-list-gestures';
import { leaveRoomWithConfirmation } from '@/buzz/room-leave';
import { validRoomSlug } from '@/buzz/room-name';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import { inviteOnlyForRepository, type RepoCandidate } from '@/buzz/room-repo-picker';
import { workspaceRailItem, type WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress, restoreStoredSurface } from '@/buzz/surface-storage';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell, CommunityDrawerTrigger, CommunitySwitcherTrigger } from '@/components/buzz/CommunityRail';
import { ConversationRow } from '@/components/buzz/ConversationRow';
import { DesktopRoomCorners } from '@/components/buzz/DesktopRoomCorners';
import { DirectMessagePickerSheet } from '@/components/buzz/DirectMessagePickerSheet';
import { ExitGlyph } from '@/components/buzz/ExitGlyph';
import { MemberPickerSheet } from '@/components/buzz/MemberPickerSheet';
import { Button } from '@/components/buzz/Button';
import { reconnectNow } from '@/sync/transport/live-connection';
import { clientResetGeneration } from '@/sync/client-reset';
import { InlineRow } from '@/components/buzz/IndexRow';
import { NewRoomDialog } from '@/components/buzz/NewRoomDialog';
import {
  type RoomDeckComposeAction,
} from '@/components/buzz/RoomDeckComposeMenu';
import { RoomDeckLoadingView } from '@/components/buzz/RoomDeckLoadingView';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { RoomListToolbar } from '@/components/buzz/RoomListToolbar';
import { MessageSearchResults } from '@/components/buzz/MessageSearchResults';
import { messageSearchHref, useMessageSearch } from '@/buzz/use-message-search';
import { readGitHubAccess, updateGitHubAccess, useGitHubAccess } from '@/buzz/github-access-surface';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { MembersAgentsGlyph } from '@/components/buzz/MembersAgentsGlyph';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { RoomViewClient, isRoomViewTimeoutError } from '@/sync/transport/room-view-client';
import { useIsDesktop } from '@/utils/responsive';
import {
  isChatListView,
  isWorkspaceListView,
  isWorkspaceView,
  type ChatListItem,
  type ChatListView,
  type Identity,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams, usePathname, type Href } from 'expo-router';
import { startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  SectionList,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { afterFirstFrame, FirstContentDrawContext, isInitialLandingNavigationSuppressed, isInitialLandingResolved, markInitialLandingResolved } from '@/navigation/initial-landing';
import { isPersonNameOnboardingPending } from '@/buzz/person-name';
import { initialAuthUrl } from '@/auth/desktop-auth-session';
import { deliverDesktopDeepLink } from '@/auth/desktop-deep-link';
import { parseCommunityInviteToken } from '@/buzz/community-invite';
import { parseReviewSecret } from '@/buzz/review-link';
import { subscribeClientReset } from '@/sync/client-reset';

export const AGE_TICK_MS = 60_000;
const COMPOSE_FAB_CLEARANCE = 80;
const LOBBY_LIST_BOTTOM_SPACING = 24;
const ROW_HEIGHT = 64;
const LEAVE_TILE_HIT_SLOP = { top: 18, bottom: 18, left: 8, right: 8 };

type EmptyRoomActionsProps = {
  canAddRoom: boolean;
  canConnectAgent: boolean;
  onAddRoom: () => void;
  onConnectAgent: () => void;
  desktop?: boolean;
  testID?: string;
};

/** The first Workspace view: quiet orientation, then two restrained actions. */
function EmptyRoomActions({
  canAddRoom,
  canConnectAgent,
  desktop = false,
  onAddRoom,
  onConnectAgent,
  testID = 'room-list-empty',
}: EmptyRoomActionsProps) {
  return (
    <View style={[styles.empty, desktop && styles.desktopEmpty]} testID={testID}>
      <Text style={styles.emptyTitle}>No Rooms yet</Text>
      <Text style={styles.emptyCopy}>
        A Room holds one repository and the people and agents working on it.
      </Text>
      <View style={styles.emptyActionList}>
        {canAddRoom && (
          <Button
            accessibilityLabel="Add a Room"
            label="Start a Room"
            onPress={onAddRoom}
            testID="empty-add-room"
            variant="brass"
          />
        )}
        {canConnectAgent && (
          <Button
            accessibilityLabel="Connect an agent"
            label="Connect an agent"
            onPress={onConnectAgent}
            testID="empty-connect-agent"
            variant="secondary"
          />
        )}
      </View>
    </View>
  );
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function workspaceMembers(view: WorkspaceView | null): WorkspaceMemberDisplayItem[] {
  if (!view) return [];
  return [...view.members, ...view.agents]
    .filter((member) => member.identity.pubkey !== view.viewer.identity.pubkey)
    .map((member) => ({
      peerPubkey: member.identity.pubkey,
      peerName: member.identity.name,
      peerKind: member.identity.kind === 'agent' ? 'agent' : 'person',
      ...(member.identity.avatar ? { avatarUrl: member.identity.avatar } : {}),
      ...(member.identity.face ? { face: member.identity.face } : {}),
      ...(member.identity.kind === 'human' ? { role: member.role } : {}),
    }));
}

export type DeckSession = { identity: Identity; relayUrl: string; workspaceId: string | null };

export default function SavedRoomDeck() {
  const insets = useSafeAreaInsets();
  const rootRoute = useRef(usePathname() === '/').current;
  const rootLanding = useRef(rootRoute && !isInitialLandingResolved()).current;
  const requestedWorkspaceId = firstParam(useLocalSearchParams<{ communityId?: string | string[] }>().communityId);
  const notifyDraw = useContext(FirstContentDrawContext);
  const [session, setSession] = useState<DeckSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let stopWorkspace: (() => void) | undefined;
    const restore = async () => {
      stopWorkspace?.();
      setSession(null);
      setError(null);
      const [identity, relayUrl, url, naming] = await Promise.all([
        loadBuzzIdentity(),
        getEffectiveRelayUrl(),
        rootLanding ? initialAuthUrl().catch(() => null) : null,
        rootRoute ? isPersonNameOnboardingPending() : false,
      ]);
      if (cancelled) return;
      const mayRedirect = !rootLanding || !isInitialLandingNavigationSuppressed();
      if (rootLanding && url && mayRedirect) {
        if (deliverDesktopDeepLink(url, router)) return;
        const review = parseReviewSecret(url);
        const invite = parseCommunityInviteToken(url);
        if (review) {
          router.replace({ pathname: '/review/[secret]', params: { secret: review } });
          return;
        }
        if (invite) {
          router.replace({ pathname: '/join/[token]', params: { token: invite } });
          return;
        }
      }
      if (!identity || naming) {
        if (mayRedirect) router.replace('/beeline/onboarding');
        return;
      }
      stopWorkspace = watchActiveCommunityId(identity.publicKey, (workspaceId) => {
        if (cancelled) return;
        restoreStoredSurface(surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView);
        setSession({ identity, relayUrl, workspaceId });
      });
    };
    void restore().catch((reason) => {
      if (!cancelled) setError(appErrorCopy(reason));
    });
    const stopReset = subscribeClientReset(() => {
      cancelled = true;
      stopWorkspace?.();
      setSession(null);
      setRetry(value => value + 1);
    });
    return () => {
      cancelled = true;
      stopWorkspace?.();
      stopReset();
    };
  }, [rootRoute, rootLanding, retry]);
  useEffect(() => { if (session || error) markInitialLandingResolved(); }, [session, error]);
  if (error) return (
    <View
      style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}
      onLayout={notifyDraw}
      testID="room-deck-unavailable"
    >
      <IndexRow
        testID="room-deck-error-retry"
        title="Secure storage unavailable"
        description={error}
        action="Retry"
        onPress={() => setRetry(value => value + 1)}
      />
    </View>
  );
  return session ? (
    <BuzzChannels
      key={`${session.identity.publicKey}:${session.relayUrl}:${requestedWorkspaceId ?? session.workspaceId}`}
      session={session}
    />
  ) : <RoomDeckLoadingView />;
}

function BuzzChannels({ session }: { session: DeckSession }) {
  const [
    workspaceList, requestedWorkspaceId, chatList, identity, relayUrl, isDesktop, requestedNewRoom,
    handledNewRoomRequest, setShowCreateRoom, requestedNewDirectMessage, setMemberPickerVisible,
    readWorkspaceRef, chatStore, deckMissedRef, transport, setError, drawn,
    setConfirmedWorkspaceCount, deckVisible, deckFocusedRef, setDeletedWorkspaceNotice, selectedId,
    setChatList, setRefreshing, setNeedsYouSignal, retryGeneration, setAgeNow, memberPickerVisible,
    cornerDropdowns, messagingPubkey, setMessagingPubkey, githubScope, setRepoPickerError,
    setRepoAccessLoading, setShowRepoPicker, setPendingRepo, setInviteOnly, setRepoPickerNotice,
    setCreatingRepository, creatingRoom, creatingRepository, setCreatingRoom, inviteOnly,
    confirmedWorkspaceCount, error, pairingBusy, setAgentConnectVisible, setPairCommand,
    setPairingError, setPairingBusy, insets, setRetryGeneration, onLayout, refreshing,
    needsYouCount, showCreateRoom, pendingRepo, showRepoPicker, repoAccessLoading, repoCandidates,
    repoInstallations, repoPickerError, repoPickerNotice, agentConnectVisible, pairingError,
    pairCommand, deletedWorkspaceNotice, ageNow,
  ] = useChannelsRouteState([
    session,
  ]);

  const [
    viewerIsAgent, canManageWorkspace, activeCommunityId, togglePin, roomName, roomNameDraft,
    activeCommunity, communities, filter, setFilter, searchOpen, setSearchOpen, query, setQuery,
    counts, pinError, setRoomName, chatSections, messageSearch, pinned, workspaceDetail,
  ] = useChannelsPresentation([
    workspaceList, requestedWorkspaceId, chatList, identity, relayUrl,
  ]);

  const [
    refreshMissed, refreshNow,
  ] = useChannelsRequestedActions([
    isDesktop, requestedNewRoom, handledNewRoomRequest, chatList, viewerIsAgent, canManageWorkspace,
    setShowCreateRoom, requestedNewDirectMessage, setMemberPickerVisible, readWorkspaceRef,
    chatStore, activeCommunityId, deckMissedRef,
  ]);

  const [
    roomListGestures, swipeableRefs, handleLeaveRoom, handleCloseChat,
  ] = useChannelsRoomActions([
    transport, chatStore, setError,
  ]);

  useChannelsSubscriptions([
    drawn, setConfirmedWorkspaceCount, deckMissedRef, deckVisible, refreshMissed, setError,
    identity, relayUrl, deckFocusedRef, transport, setDeletedWorkspaceNotice, selectedId, chatStore,
    setChatList, setMemberPickerVisible, setRefreshing, readWorkspaceRef, setNeedsYouSignal,
    retryGeneration, setAgeNow, activeCommunityId, memberPickerVisible,
  ]);

  const [
    selectWorkspace, rowActions, handleStartDirectMessage,
  ] = useChannelsNavigation([
    identity, activeCommunityId, transport, roomListGestures, swipeableRefs, togglePin,
    cornerDropdowns, messagingPubkey, setMessagingPubkey, setMemberPickerVisible, setError,
  ]);

  const [
    createRoom, handleToggleRepoPicker, handleLoadRepositories, handleSelectNoRepository,
    handleSelectRepoCandidate, handleAddGitHubAccount, handleCreateRepository,
  ] = useChannelsRepositories([
    transport, activeCommunityId, githubScope, setRepoPickerError, relayUrl, identity,
    setRepoAccessLoading, setShowRepoPicker, setPendingRepo, setInviteOnly, setShowCreateRoom,
    setRepoPickerNotice, setCreatingRepository, roomName, creatingRoom, creatingRepository,
    canManageWorkspace, setCreatingRoom, setError, roomNameDraft, inviteOnly, chatStore,
  ]);

  const [
    landing, closeAgentConnect, connectAgent, copyPairCommand, compose,
  ] = useChannelsCompose([
    confirmedWorkspaceCount, error, chatList, transport, activeCommunityId, pairingBusy,
    viewerIsAgent, setAgentConnectVisible, setPairCommand, setPairingError, setPairingBusy,
    canManageWorkspace, setMemberPickerVisible, setShowCreateRoom,
  ]);


  if (landing.kind === 'error') {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="room-deck-unavailable">
        <InlineRow style={styles.header}>
          {!isDesktop && <CommunitySwitcherTrigger community={activeCommunity} expanded={false} />}
        </InlineRow>
        <View style={styles.failureInset}>
          <IndexRow inset="flush" title={error || 'Could not load Rooms'}  testID="room-deck-error-retry" action="Retry"
            onPress={() => { reconnectNow(); setError(null); setRetryGeneration(value => value + 1); }} />
        </View>
      </View>
    );
  }
  if (landing.kind !== 'deck' || !chatList) {
    // Choice: the create-or-join screen is the landing and the effect above
    // is replacing this one; loader: nothing has answered yet.
    return <RoomDeckLoadingView style={{ paddingTop: insets.top }} onLayout={onLayout} />;
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={selectWorkspace}
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={chatList.viewer.avatar}
      viewerFace={chatList.viewer.face}
    >
      <View
        style={[styles.container, { paddingTop: insets.top }]}
        testID={refreshing ? 'room-list-refreshing' : 'room-list-idle'}
        onLayout={onLayout}
      >
        <InlineRow style={styles.header}>
          {!isDesktop && <CommunityDrawerTrigger community={activeCommunity} />}
          {!isDesktop && activeCommunityId && (
            <View style={styles.headerActions}>
              <Button
                label=""
                iconOnly
                variant="quiet"
                accessibilityLabel="Members"
                testID="workspace-members"
                icon={<MembersAgentsGlyph size={22} color={styles.membersGlyph.color} />}
                onPress={() =>
                  router.push({
                    pathname: '/beeline/members',
                    params: { communityId: activeCommunityId },
                  } as never)
                }
              />
              <TrayGlyph
                size={22}
                color={styles.trayGlyph.color}
                cutColor={styles.trayGlyph.backgroundColor}
                testID="workspace-tray"
                needsYouCount={needsYouCount}
                filled={false}
                onPress={() =>
                  router.push({
                    pathname: '/beeline/tray',
                    params: {
                      communityId: activeCommunityId,
                      workspaceName: chatList?.workspace.name ?? '',
                    },
                  } as never)
                }
              />
            </View>
          )}
        </InlineRow>
        {!isDesktop && (
          <RoomListToolbar
            filter={filter}
            onFilter={setFilter}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
            query={query}
            onQuery={setQuery}
            counts={counts}
          />
        )}
        {pinError && <IndexRow title={pinError} />}
        <NewRoomDialog
          draftContext={activeCommunityId ?? ''}
          visible={showCreateRoom}
          roomName={roomName}
          setRoomName={setRoomName}
          inviteOnly={inviteOnly}
          setInviteOnly={setInviteOnly}
          creatingRoom={creatingRoom}
          creatingRepository={creatingRepository}
          createRoom={createRoom}
          onClose={() => setShowCreateRoom(false)}
          pendingRepo={pendingRepo}
          showRepoPicker={showRepoPicker}
          handleToggleRepoPicker={handleToggleRepoPicker}
          handleLoadRepositories={handleLoadRepositories}
          repoAccessLoading={repoAccessLoading}
          handleSelectNoRepository={handleSelectNoRepository}
          handleSelectRepoCandidate={handleSelectRepoCandidate}
          repoCandidates={repoCandidates}
          repoInstallations={repoInstallations}
          repoPickerError={repoPickerError}
          repoPickerNotice={repoPickerNotice}
          handleAddGitHubAccount={() => void handleAddGitHubAccount()}
          handleCreateRepository={handleCreateRepository}
        />
        <MemberPickerSheet
          agentConnectOnly
          busy={pairingBusy}
          canManage={canManageWorkspace}
          canConnectAgent={!viewerIsAgent}
          candidates={undefined}
          error={agentConnectVisible ? pairingError : null}
          onAdd={() => undefined}
          onClose={closeAgentConnect}
          onConnectAgent={() => void connectAgent()}
          onCopyPairCommand={(command) => void copyPairCommand(command)}
          onInvitePerson={() => undefined}
          pairCommand={pairCommand}
          testID="empty-agent-connect-sheet"
          visible={agentConnectVisible}
        />
        {!!deletedWorkspaceNotice && (
          <Button
            label={deletedWorkspaceNotice}
            variant="quiet"
            onPress={() => setDeletedWorkspaceNotice(null)}
            testID="workspace-deleted-notice"
            appearance={{ control: styles.errorBar, label: styles.error }}
          />
        )}
        {!!error && (
          <View style={styles.failureInset}>
            <IndexRow
              inset="flush"
              title={error}

              action="Retry"
              onPress={refreshNow}
            />
          </View>
        )}
        {isDesktop ? (
          chatList.chats.length === 0 ? (
            <EmptyRoomActions
              canAddRoom={!viewerIsAgent && canManageWorkspace}
              canConnectAgent={!viewerIsAgent}
              desktop
              onAddRoom={() => setShowCreateRoom(true)}
              onConnectAgent={() => void connectAgent()}
              testID="desktop-room-list-empty"
            />
          ) : (
            <View style={styles.center} testID="desktop-room-selection-empty">
              <Text style={styles.emptyTitle}>Select a Room</Text>
              <Text style={styles.emptyCopy}>
                Choose a Room or direct message from the sidebar.
              </Text>
            </View>
          )
        ) : (
          <View
            testID="room-list-gestures"
            style={styles.listViewport}
            {...roomListGestures.touchHandlers}
          >
            <SectionList
              testID="room-list"
              {...roomListGestures.listHandlers}
              sections={chatSections}
              keyExtractor={(item) => item.room.id}
              extraData={[cornerDropdowns.expanded, roomListGestures.swipesEnabled]}
              stickySectionHeadersEnabled={false}
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                refreshNow();
              }}
              contentContainerStyle={
                chatList.chats.length
                  ? [styles.list, { paddingBottom: LOBBY_LIST_BOTTOM_SPACING + insets.bottom }]
                  : styles.emptyList
              }
              renderSectionHeader={({ section }) =>
                section.title && !query.trim() ? (
                  <RoomListSectionHeader
                    title={section.title}
                    inset="roomList"
                    actionAccessibilityLabel={
                      section.kind === 'rooms' ? 'Create a new Room' : 'Start a direct message'
                    }
                    onAction={
                      viewerIsAgent || (section.kind === 'rooms' && !canManageWorkspace)
                        ? undefined
                        : () => compose(section.kind === 'rooms' ? 'room' : 'message')
                    }
                  />
                ) : null
              }
              ListFooterComponent={
                <MessageSearchResults
                  search={messageSearch}
                  now={ageNow}
                  onOpen={(result) => {
                    if (activeCommunityId)
                      router.push(messageSearchHref(result, activeCommunityId) as Href);
                  }}
                />
              }
              ListEmptyComponent={
                messageSearch.status !== 'unavailable' ? null : filter === 'pinned' &&
                  !query.trim() ? (
                  <EmptyState
                    title="No pinned conversations yet"
                    description="Long press a Room to pin it here."
                    testID="pinned-empty"
                    action={{ label: 'Show all conversations', onPress: () => setFilter('all'), testID: 'show-all-conversations' }}
                  />
                ) : query || filter !== 'all' ? (
                  <EmptyState
                    title="No matching conversations"
                    description="Try a different search or filter."
                    testID="room-list-no-match"
                    action={{
                      label: 'Show all conversations',
                      onPress: () => { setQuery(''); setFilter('all'); },
                      testID: 'no-match-show-all-conversations',
                    }}
                  />
                ) : (
                  <EmptyRoomActions
                    canAddRoom={!viewerIsAgent && canManageWorkspace}
                    canConnectAgent={!viewerIsAgent}
                    onAddRoom={() => setShowCreateRoom(true)}
                    onConnectAgent={() => void connectAgent()}
                  />
                )
              }
              renderItem={({ item, index, section }) => {
                const heading = roomRowName(item);
                const title = `${heading.sigil}${heading.name}`;
                const first = index === 0;
                const last = index === section.data.length - 1;
                const cornersExpanded = cornerDropdowns.expanded.has(item.room.id);
                const row = (
                  <View
                    // Android keeps clipping a reused `overflow: 'hidden'` frame to its old
                    // corners when a reorder changes its rounding, so the card's content
                    // vanishes; a frame whose rounding changes is mounted fresh instead.
                    key={`${first}-${last}`}
                    style={[
                      styles.rowSurface,
                      first && styles.rowSurfaceFirst,
                      last && styles.rowSurfaceLast,
                    ]}
                  >
                    <ConversationRow
                      item={item}
                      viewer={chatList.viewer.pubkey}
                      now={ageNow}
                      onPress={rowActions.press}
                      pinned={pinned.includes(item.room.id)}
                      onPin={rowActions.pin}
                      cornersExpanded={cornersExpanded}
                      onToggleCorners={rowActions.toggleCorners}
                      onLongPressCorners={viewerIsAgent ? undefined : rowActions.newCorner}
                      testID={`room-${item.room.id}`}
                    />
                    {!item.directMessage && cornersExpanded && (
                      <DesktopRoomCorners
                        item={item}
                        mobile
                        onOpen={(cornerId, name) => {
                          if (!roomListGestures.canInteract()) return;
                          router.push(cornerHref(cornerId, item.room.id, name, 'room-list'));
                        }}
                      />
                    )}
                  </View>
                );
                return (
                  <View style={[styles.roomCell, last && styles.roomCellLast]}>
                    {!viewerIsAgent ? (
                      <Swipeable
                        enabled={roomListGestures.swipesEnabled}
                        activeOffsetX={[-15, 15]}
                        failOffsetY={[-10, 10]}
                        ref={(ref) => {
                          if (ref) swipeableRefs.current.set(item.room.id, ref);
                          else swipeableRefs.current.delete(item.room.id);
                        }}
                        friction={1}
                        overshootRight={false}
                        rightThreshold={ROW_HEIGHT}
                        renderRightActions={() => (
                          <View style={styles.chatActions}>
                            {!item.directMessage && (
                              <View style={styles.swipeAction}>
                                <TouchableOpacity
                                  accessibilityLabel={`Leave ${title}`}
                                  accessibilityRole="button"
                                  hitSlop={LEAVE_TILE_HIT_SLOP}
                                  onPress={() => {
                                    if (roomListGestures.canInteract()) void handleLeaveRoom(item);
                                  }}
                                  style={styles.swipeActionButton}
                                  testID={`room-leave-action-${item.room.id}`}
                                >
                                  <ExitGlyph testID={`room-exit-glyph-${item.room.id}`} />
                                </TouchableOpacity>
                              </View>
                            )}
                            {item.directMessage && (
                              <View style={styles.swipeAction}>
                                <TouchableOpacity
                                  accessibilityLabel={`Close ${title}`}
                                  accessibilityRole="button"
                                  hitSlop={LEAVE_TILE_HIT_SLOP}
                                  onPress={() => {
                                    if (roomListGestures.canInteract()) void handleCloseChat(item);
                                  }}
                                  style={styles.swipeActionButton}
                                  testID={`chat-close-action-${item.room.id}`}
                                >
                                  <ExitGlyph testID={`dm-exit-glyph-${item.room.id}`} />
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                        )}
                        testID={`chat-close-swipe-${item.room.id}`}
                      >
                        {row}
                      </Swipeable>
                    ) : (
                      row
                    )}
                  </View>
                );
              }}
            />
          </View>
        )}
        <DirectMessagePickerSheet
          draftContext={activeCommunityId ?? ''}
          busyPubkey={messagingPubkey}
          members={workspaceMembers(workspaceDetail)}
          onClose={() => setMemberPickerVisible(false)}
          onMessage={(member) => void handleStartDirectMessage(member)}
          visible={memberPickerVisible}
        />
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.md,
      backgroundColor: hull.bgTerminal,
      paddingHorizontal: hull.space.xl,
    },
    header: {
      minHeight: 62,
      paddingLeft: hull.roomList.edge,
      // The tray's centre, not its target, sits on the Room list icon line; Room and
      // corner conversation headers keep their own 16 px target spacing.
      paddingRight: hull.roomList.trayEnd,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    // Target edge to target edge, not ink to ink: the boxes ARE the targets,
    // and they touch, so their centres stay one complete touch target apart.
    membersGlyph: { color: hull.ledgerQuiet },
    trayGlyph: { color: hull.ledgerQuiet, backgroundColor: hull.bgBase },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 0,
    },
    errorBar: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.danger,
    },
    error: { ...theme.buzz.type.meta, color: hull.danger, textAlign: 'center' },
    list: { paddingTop: hull.roomCard.gap },
    listViewport: { flex: 1 },
    emptyList: {
      flexGrow: 1,
      justifyContent: 'flex-start',
      paddingTop: hull.space.xxl,
      paddingBottom: COMPOSE_FAB_CLEARANCE,
    },
    empty: {
      alignItems: 'flex-start',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.lg,
      width: '100%',
    },
    desktopEmpty: { paddingTop: hull.space.xxl },
    emptyTitle: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    emptyCopy: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      maxWidth: 330,
    },
    emptyActionList: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      marginTop: hull.space.md,
    },
    failureInset: { paddingHorizontal: hull.roomList.edge },
    rowSurface: {
      backgroundColor: hull.bgBase,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      overflow: 'hidden',
    },
    rowSurfaceFirst: {
      borderTopWidth: 1,
      borderTopLeftRadius: hull.roomCard.cornerRadius,
      borderTopRightRadius: hull.roomCard.cornerRadius,
    },
    rowSurfaceLast: {
      borderBottomWidth: 1,
      borderBottomLeftRadius: hull.roomCard.cornerRadius,
      borderBottomRightRadius: hull.roomCard.cornerRadius,
    },
    roomCell: {
      paddingHorizontal: hull.roomList.edge,
    },
    roomCellLast: { paddingBottom: hull.roomCard.gap },
    chatActions: {
      flexDirection: 'row',
      minHeight: ROW_HEIGHT,
      backgroundColor: hull.bgHighlight,
    },
    swipeAction: {
      width: ROW_HEIGHT,
      height: ROW_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swipeActionButton: {
      width: 26,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
  };
});
