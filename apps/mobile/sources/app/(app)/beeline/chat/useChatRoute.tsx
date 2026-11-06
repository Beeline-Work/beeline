import { useDesktopLayout } from '@/buzz/desktop-layout-state';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { RoomSendPreview } from '@/buzz/room-send-list';
import { useIsDesktop } from '@/utils/responsive';
import { isDesktopShell } from '@/utils/isDesktopShell';

type Props = [

];

export function useChatRoute([

]: Props): [
  sendPreview: RoomSendPreview,
  decodedId: string,
  navigation: Omit<import("@react-navigation/core").NavigationProp<ReactNavigation.RootParamList>, "getState"> & { getState(): import("@react-navigation/routers").NavigationState | undefined; },
  desktopExperience: boolean,
  desktopAvailableWidth: number,
  routeParentChannelId: string | undefined,
  allowOlderHistoryRef: React.RefObject<boolean>,
  routeChannelTitle: string | undefined,
  routeCommunityId: string | undefined,
  profileKind: "human" | "agent",
  profileAgentId: string | null,
  setProfileKind: React.Dispatch<React.SetStateAction<"human" | "agent">>,
  setProfileAgentId: React.Dispatch<React.SetStateAction<string | null>>,
  messageAnchorId: string,
  notificationResponseId: string | undefined,
  notificationMessageId: string | undefined,
  notificationTarget: string | undefined,
  insets: import("react-native-safe-area-context/lib/typescript/src/SafeArea.types").EdgeInsets,
  cornerReturnTarget: "corners" | "room-list" | undefined,
  isDesktop: boolean,
  readOnlyFooterInset: { marginBottom: number; paddingBottom?: undefined; } | { paddingBottom: number; marginBottom?: undefined; },
] {

  const { theme } = useUnistyles();

  const isDesktop = useIsDesktop();

  // `parent`/`title` are hints, not authority: every surface that opens a
  // corner already knows both, so passing them makes the header correct on the
  // first frame instead of one server round trip later. The screen's own reads
  // still run and still win.
  const {
    channelId,
    notificationResponseId,
    notificationTarget,
    notificationMessageId,
    communityId,
    parent,
    title,
    returnTo,
  } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
    notificationTarget?: string;
    notificationMessageId?: string;
    communityId?: string;
    parent?: string;
    title?: string;
    returnTo?: string;
  }>();

  const decodedId = channelId ? decodeURIComponent(channelId) : '';

  const sendPreview = useMemo(() => new RoomSendPreview(), [decodedId]);

  useEffect(() => {
    sendPreview.activate();
    return () => sendPreview.dispose();
  }, [sendPreview]);


  const messageAnchorId = (notificationMessageId ?? notificationTarget ?? '').trim();

  const allowOlderHistoryRef = useRef(false);

  useEffect(() => {
    allowOlderHistoryRef.current = Boolean(messageAnchorId);
  }, [decodedId, messageAnchorId]);

  const { availableWidth: desktopAvailableWidth } = useDesktopLayout();

  // Desktop chrome and the work pane follow the live window, not the
  // monitor. `isDesktopPlatform()` is true for every browser, and
  // `screen.availWidth` is the display — either one sizes a phone tab as a
  // desktop shell and a narrowed desktop window as a 3-column wide layout.
  // A packaged Tauri window keeps the desktop experience at every width.
  const desktopExperience = isDesktop || isDesktopShell();

  const [profileKind, setProfileKind] = useState<'human' | 'agent'>('agent');

  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);

  useEffect(() => {
    setProfileAgentId(null);
  }, [decodedId]);

  const routeParentChannelId = parent?.trim() || undefined;

  const routeCommunityId = communityId?.trim() || undefined;

  const routeChannelTitle = title?.trim() || undefined;

  const cornerReturnTarget =
    returnTo === 'room-list' || returnTo === 'corners' ? returnTo : undefined;

  const insets = useSafeAreaInsets();

  const readOnlyFooterInset =
    Platform.OS === 'android'
      ? { marginBottom: insets.bottom }
      : { paddingBottom: Math.max(insets.bottom, 8) };

  const navigation = useNavigation();
  return [
    sendPreview, decodedId, navigation, desktopExperience, desktopAvailableWidth,
    routeParentChannelId, allowOlderHistoryRef, routeChannelTitle, routeCommunityId, profileKind,
    profileAgentId, setProfileKind, setProfileAgentId, messageAnchorId, notificationResponseId,
    notificationMessageId, notificationTarget, insets, cornerReturnTarget, isDesktop,
    readOnlyFooterInset,
  ];
}
