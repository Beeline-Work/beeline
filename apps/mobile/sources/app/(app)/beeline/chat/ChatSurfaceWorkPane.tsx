import { HumanProfile } from '../human-profile';
import BuzzMembers from '../members';
import React from 'react';
import { View } from 'react-native';
import { type ChannelReferenceIndex, type ChannelReferenceTarget } from '@/buzz/channel-reference';
import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
import { styles } from './chat-surface-styles';

type Props = {
  profileAgentId: string | null;
  desktopExperience: boolean;
  activeCommunityId: string | null;
  profileKind: "human" | "agent";
  setProfileAgentId: React.Dispatch<React.SetStateAction<string | null>>;
  decodedId: string;
  desktopWorkPaneMounted: import("@beeline/api-contract/phone").RoomView | null;
  desktopWorkPaneContent: import("@/buzz/desktop-workbench-state").DesktopWorkPaneContent | null;
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null;
  channelReferenceIndex: ChannelReferenceIndex;
  handleOpenChannelReference: (target: ChannelReferenceTarget, text?: string) => Promise<void>;
  displayedDesktopWorkPaneContent: import("@/buzz/desktop-workbench-state").DesktopWorkPaneContent | null;
  openDesktopCorner: (roomId: string, cornerId: string) => void;
  desktopWorkRoomId: string;
  expandDesktopCorner: (cornerId: string) => void;
  closeDesktopWorkPane: () => void;
};
export function ChatSurfaceWorkPane({
  profileAgentId,
  desktopExperience,
  activeCommunityId,
  profileKind,
  setProfileAgentId,
  decodedId,
  desktopWorkPaneMounted,
  desktopWorkPaneContent,
  roomClient,
  channelReferenceIndex,
  handleOpenChannelReference,
  displayedDesktopWorkPaneContent,
  openDesktopCorner,
  desktopWorkRoomId,
  expandDesktopCorner,
  closeDesktopWorkPane,
}: Props) { return <>
        {profileAgentId && desktopExperience && activeCommunityId && (
          <View style={styles.agentProfilePane} testID="desktop-agent-profile-pane">
            {profileKind === 'human' ? (
              <HumanProfile
                key={profileAgentId}
                memberId={profileAgentId}
                workspaceId={activeCommunityId}
                onClose={() => setProfileAgentId(null)}
              />
            ) : (
              <BuzzMembers
                key={profileAgentId}
                profileAgentId={profileAgentId}
                profileRoomId={decodedId}
                workspaceIdOverride={activeCommunityId}
                onClose={() => setProfileAgentId(null)}
              />
            )}
          </View>
        )}
        {!profileAgentId && desktopWorkPaneMounted && desktopWorkPaneContent && (
          <DesktopRoomInspector
            room={desktopWorkPaneMounted}
            client={roomClient}
            channelIndex={channelReferenceIndex}
            onChannelReference={handleOpenChannelReference}
            content={displayedDesktopWorkPaneContent!}
            onOpenCorner={(cornerId) => openDesktopCorner(desktopWorkRoomId, cornerId)}
            onOpenInMain={expandDesktopCorner}
            onClose={closeDesktopWorkPane}
          />
        )}

</>; }
