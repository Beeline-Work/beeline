import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { useDesktopParentRoom } from '@/buzz/use-desktop-parent-room';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { useGitHubAccess } from '@/buzz/github-access-surface';
import { type GitHubInstallationAccess } from '@beeline/buzz-client';
import { transitionDesktopWorkPane, type DesktopWorkPaneEvent } from '@/buzz/desktop-workbench-state';
import { roomIsArchived, roomViewParentId } from '@/buzz/corner-display-state';
import { type RepoCandidate } from '@/buzz/room-repo-picker';
import { type ChannelKind } from '@/buzz/corner-session';
import { useRoomRoster } from '@/buzz/use-room-roster';

type Props = [
  desktopWorkPaneRef: React.RefObject<import("@/buzz/desktop-workbench-state").DesktopWorkPaneState>,
  setDesktopWorkPane: React.Dispatch<React.SetStateAction<import("@/buzz/desktop-workbench-state").DesktopWorkPaneState>>,
  desktopExperience: boolean,
  desktopAvailableWidth: number,
  decodedId: string,
  userPubkey: string,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  routeParentChannelId: string | undefined,
  isDirectMessage: boolean,
  desktopWorkPaneContent: import("@/buzz/desktop-workbench-state").DesktopWorkPaneContent | null,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  firstUnreadMessageId: string | null,
  allowOlderHistoryRef: React.RefObject<boolean>,
  routeChannelTitle: string | undefined,
  routeCommunityId: string | undefined,
  participantPickerVisible: boolean,
  rosterVisible: boolean,
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>,
  profileKind: "human" | "agent",
  profileAgentId: string | null,
];

export function useChatDesktopLayout([
  desktopWorkPaneRef, setDesktopWorkPane, desktopExperience, desktopAvailableWidth, decodedId,
  userPubkey, roomSurface, routeParentChannelId, isDirectMessage, desktopWorkPaneContent,
  roomClient, firstUnreadMessageId, allowOlderHistoryRef, routeChannelTitle, routeCommunityId,
  participantPickerVisible, rosterVisible, setMembershipError, profileKind, profileAgentId,
]: Props): [
  chatListKey: { relayUrl: string; viewerPubkey: string; workspaceId: string; } | null,
  isArchived: boolean,
  isCorner: boolean,
  activeCommunityId: string | null,
  surfaceParentId: string | undefined,
  parentChannelId: string | undefined,
  resolvedChannelName: string | null,
  commitDesktopWorkPane: (event: DesktopWorkPaneEvent) => import("@/buzz/desktop-workbench-state").DesktopWorkPaneTransition,
  desktopWorkRoomId: string,
  cacheViewerPubkey: string,
  workspaceRoster: { members: import("@beeline/api-contract/phone").RoomViewMember[]; agents: import("@beeline/api-contract/phone").WorkspaceAgentView[]; workspace: import("@beeline/api-contract/phone").ChatListWorkspace & { readonly about?: string; readonly createdAt: number; }; managerSettings?: { readonly allowFixSweep?: boolean; readonly visibility: "public" | "invite-only"; readonly rooms?: readonly import("@beeline/api-contract/phone").WorkspaceManagedRoomView[]; readonly roomsTruncated?: boolean; }; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; viewer: import("@beeline/api-contract/phone").RoomViewer; watchFilters: readonly import("@beeline/api-contract/phone").SurfaceWatchFilter[]; } | null,
  channelKind: ChannelKind,
  openWorkspaceRoster: () => void,
  roomRepoCandidates: RepoCandidate[],
  githubScope: { relay: string; viewer: string; } | null,
  chatListRelayUrl: string | null,
  githubInstallations: GitHubInstallationAccess[],
  desktopWorkPaneMounted: import("@beeline/api-contract/phone").RoomView | null,
  displayedDesktopWorkPaneContent: import("@/buzz/desktop-workbench-state").DesktopWorkPaneContent | null,
] {


  const commitDesktopWorkPane = useCallback((event: DesktopWorkPaneEvent) => {
    const transition = transitionDesktopWorkPane(desktopWorkPaneRef.current, event);
    desktopWorkPaneRef.current = transition.state;
    setDesktopWorkPane(transition.state);
    return transition;
  }, []);


  useEffect(() => {
    if (!desktopExperience) return;
    commitDesktopWorkPane({ type: 'resize', width: desktopAvailableWidth });
  }, [commitDesktopWorkPane, desktopExperience, desktopAvailableWidth]);


  // The second pane belongs to the view it opened beside: switching rooms
  // closes it. Declared before the corner subscription so a rail corner that
  // switched rooms opens after this close, not before it.
  useEffect(() => {
    commitDesktopWorkPane({ type: 'close' });
  }, [commitDesktopWorkPane, decodedId]);


  const cacheViewerPubkey = userPubkey;

  const isArchived = roomIsArchived(roomSurface?.room);

  const surfaceParentId = roomSurface ? roomViewParentId(roomSurface) : undefined;

  const parentChannelId = surfaceParentId ?? routeParentChannelId;

  const desktopWorkRoomId = parentChannelId ?? decodedId;

  const needsDesktopParentRoom = desktopExperience && !isDirectMessage && Boolean(desktopWorkPaneContent);

  const desktopParentRoom = useDesktopParentRoom(needsDesktopParentRoom, parentChannelId, roomClient);

  const desktopWorkRoom = parentChannelId ? desktopParentRoom : roomSurface;

  const currentComputerSession = desktopWorkPaneContent?.kind === 'computer'
    ? (roomSurface?.messages.find((message) => message.computerSession?.id === desktopWorkPaneContent.session.id)?.computerSession
      ?? desktopWorkRoom?.messages.find((message) => message.computerSession?.id === desktopWorkPaneContent.session.id)?.computerSession)
    : undefined;

  const displayedDesktopWorkPaneContent = desktopWorkPaneContent?.kind === 'computer' && currentComputerSession
    ? { ...desktopWorkPaneContent, session: { ...currentComputerSession, access: desktopWorkPaneContent.session.access } }
    : desktopWorkPaneContent;

  // A direct message has no second pane: artifacts open in the full-screen
  // viewer and the transcript keeps the width.
  const desktopWorkPaneMounted =
    desktopExperience && !isDirectMessage && desktopWorkPaneContent ? desktopWorkRoom : null;

  const channelKind: ChannelKind = roomSurface
    ? surfaceParentId
      ? 'corner'
      : 'room'
    : routeParentChannelId
      ? 'corner'
      : 'unknown';

  const isCorner = Boolean(parentChannelId);

  useEffect(() => {
    if (!isCorner && firstUnreadMessageId) allowOlderHistoryRef.current = true;
  }, [firstUnreadMessageId, isCorner]);

  const resolvedChannelName = roomSurface?.room.name ?? routeChannelTitle ?? null;

  const activeCommunityId = roomSurface?.room.workspaceId ?? routeCommunityId ?? null;

  const readPickerRoster=useCallback((workspaceId:string)=>roomClient!.workspace(workspaceId),[roomClient]);

  const {value:workspaceRoster,open:openWorkspaceRoster}=useRoomRoster(activeCommunityId,userPubkey,participantPickerVisible||rosterVisible,roomClient?readPickerRoster:undefined,setMembershipError);

  const usageProfileFocused = useSurfaceFocus();

  const committedUsageProfileId = desktopExperience && profileKind === 'agent' && activeCommunityId ? profileAgentId : null;

  useEffect(() => {
    if (!usageProfileFocused) return;
  }, [committedUsageProfileId, usageProfileFocused]);

  // The DM header, the repository-change guard, mentions and forwarding read
  // the app-level Room list, which stays live while this Room is open.
  const [chatListRelayUrl, setChatListRelayUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getEffectiveRelayUrl().then((url) => {
      if (!cancelled) setChatListRelayUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const chatListKey = useMemo(
    () =>
      chatListRelayUrl && userPubkey && activeCommunityId
      ? { relayUrl: chatListRelayUrl, viewerPubkey: userPubkey, workspaceId: activeCommunityId }
      : null,
    [activeCommunityId, chatListRelayUrl, userPubkey],
  );

  const githubScope = chatListRelayUrl && userPubkey
    ? { relay: chatListRelayUrl, viewer: userPubkey } : null;

  const githubAccess = useGitHubAccess(githubScope);

  const roomRepoCandidates = githubAccess?.candidates ?? [];

  const githubInstallations = githubAccess?.installations ?? [];
  return [
    chatListKey, isArchived, isCorner, activeCommunityId, surfaceParentId, parentChannelId,
    resolvedChannelName, commitDesktopWorkPane, desktopWorkRoomId, cacheViewerPubkey,
    workspaceRoster, channelKind, openWorkspaceRoster, roomRepoCandidates, githubScope,
    chatListRelayUrl, githubInstallations, desktopWorkPaneMounted, displayedDesktopWorkPaneContent,
  ];
}
