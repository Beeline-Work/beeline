import React, { createContext, useCallback, useContext, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community } from '@beeline/buzz-client';
import { groknight } from '@/buzz/groknight';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { WorkspaceAvatar } from '@/components/buzz/WorkspaceAvatar';
import { HullSurface } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';

const DRAWER_WIDTH = 72;
const DRAWER_DURATION_MS = 180;

type CommunityRailProps = {
  communities: Community[];
  activeCommunityId: string | null;
  onSelect: (communityId: string | null) => void;
  onAdd: () => void;
  onSettings: () => void;
  viewerPubkey?: string;
  viewerAvatarUrl?: string;
};

type RailButtonProps = {
  active: boolean;
  label: string;
  children: React.ReactNode;
  add?: boolean;
  onPress: () => void;
  testID?: string;
};

function RailButton({ active, label, children, add = false, onPress, testID }: RailButtonProps) {
  return (
    <View style={styles.railButtonSlot}>
      {active && <View style={styles.activeNotch} />}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        testID={testID}
        onPress={onPress}
        style={[styles.railButton, add && styles.addRailButton]}
      >
        {children}
      </TouchableOpacity>
    </View>
  );
}

export function CommunityRail({
  communities,
  activeCommunityId,
  onSelect,
  onAdd,
  onSettings,
  viewerPubkey,
  viewerAvatarUrl,
}: CommunityRailProps) {
  const insets = useSafeAreaInsets();
  return (
    <HullSurface
      strength="quiet"
      accessibilityLabel={`${WORKSPACE_LABEL} switcher`}
      style={[styles.rail, { paddingTop: Math.max(insets.top, 10) }]}
    >
      <ScrollView
        style={styles.communityScroll}
        contentContainerStyle={styles.communityScrollContent}
        showsVerticalScrollIndicator={false}
      >
        {communities.map((community) => {
          const active = activeCommunityId === community.communityId;
          return (
            <RailButton
              key={community.communityId}
              active={active}
              label={community.name}
              onPress={() => onSelect(community.communityId)}
              testID={`community-rail-${community.communityId}`}
            >
              <WorkspaceAvatar
                active={active}
                community={community}
                size={42}
                testID={`workspace-avatar-${community.communityId}`}
              />
            </RailButton>
          );
        })}
      </ScrollView>
      <RailButton
        active={false}
        add
        label={`Create or join a ${WORKSPACE_LABEL}`}
        onPress={onAdd}
        testID="community-rail-add"
      >
        <Text style={styles.addRailButtonText}>＋</Text>
      </RailButton>
      <RailButton
        active={false}
        label="Settings"
        onPress={onSettings}
        testID="community-rail-settings"
      >
        {viewerPubkey ? (
          <PersonAvatar pubkey={viewerPubkey} avatarUrl={viewerAvatarUrl} name="You" size={38} />
        ) : (
          <Text style={styles.settingsRailButtonText}>⚙</Text>
        )}
      </RailButton>
      <View style={{ height: Math.max(insets.bottom, 8) }} />
    </HullSurface>
  );
}

type CommunityDrawerContextValue = {
  drawerOpen: boolean;
  openDrawer: () => void;
};

const CommunityDrawerContext = createContext<CommunityDrawerContextValue | null>(null);

type CommunityDrawerTriggerProps = {
  community?: Community | null;
  canEditAvatar?: boolean;
  avatarWorking?: boolean;
  onEditAvatar?: () => void;
};

export function CommunityDrawerTrigger({
  community,
  canEditAvatar = false,
  avatarWorking = false,
  onEditAvatar,
}: CommunityDrawerTriggerProps) {
  const drawer = useContext(CommunityDrawerContext);
  if (!drawer) {
    throw new Error('CommunityDrawerTrigger must be rendered inside BuzzCommunityShell.');
  }
  const editable = canEditAvatar && Boolean(onEditAvatar);

  return (
    <View style={styles.drawerTrigger}>
      <TouchableOpacity
        accessibilityLabel={
          editable ? `Change ${WORKSPACE_LABEL} picture` : `Open ${WORKSPACE_LABEL} switcher`
        }
        accessibilityRole="button"
        disabled={editable && avatarWorking}
        onPress={editable ? onEditAvatar : drawer.openDrawer}
        style={styles.drawerAvatarButton}
        testID={editable ? 'workspace-avatar-edit' : 'workspace-avatar-trigger'}
      >
        <WorkspaceAvatar community={community} size={38} testID="workspace-avatar-header" />
        {editable && (
          <View style={styles.avatarEditBadge}>
            <Text style={styles.avatarEditBadgeText}>{avatarWorking ? '⋯' : '+'}</Text>
          </View>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel={`Open ${WORKSPACE_LABEL} switcher`}
        accessibilityRole="button"
        accessibilityState={{ expanded: drawer.drawerOpen }}
        onPress={drawer.openDrawer}
        style={styles.drawerToggleButton}
        testID="community-drawer-trigger"
      >
        <Text style={styles.drawerTriggerChevron}>›</Text>
      </TouchableOpacity>
    </View>
  );
}

type BuzzCommunityShellProps = CommunityRailProps & {
  children: React.ReactNode;
};

export function BuzzCommunityShell({
  children,
  communities,
  activeCommunityId,
  onSelect,
  onAdd,
  onSettings,
  viewerPubkey,
  viewerAvatarUrl,
}: BuzzCommunityShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerX = useSharedValue(-DRAWER_WIDTH);
  const scrimOpacity = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  const openDrawer = useCallback(() => {
    drawerX.value = -DRAWER_WIDTH;
    scrimOpacity.value = 0;
    setDrawerOpen(true);
    drawerX.value = withTiming(0, {
      duration: DRAWER_DURATION_MS,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      reduceMotion: ReduceMotion.System,
    });
    scrimOpacity.value = withTiming(0.78, {
      duration: 120,
      reduceMotion: ReduceMotion.System,
    });
  }, [drawerX, scrimOpacity]);

  const closeDrawer = useCallback(() => {
    scrimOpacity.value = withTiming(0, {
      duration: 90,
      reduceMotion: ReduceMotion.System,
    });
    drawerX.value = withTiming(
      -DRAWER_WIDTH,
      {
        duration: reducedMotion ? 0 : 135,
        easing: Easing.out(Easing.poly(5)),
        reduceMotion: ReduceMotion.System,
      },
      (finished) => {
        if (finished) runOnJS(setDrawerOpen)(false);
      },
    );
  }, [drawerX, reducedMotion, scrimOpacity]);

  const selectAndClose = useCallback(
    (communityId: string | null) => {
      closeDrawer();
      void Haptics.selectionAsync();
      onSelect(communityId);
    },
    [closeDrawer, onSelect],
  );

  const addAndClose = useCallback(() => {
    closeDrawer();
    onAdd();
  }, [closeDrawer, onAdd]);

  const settingsAndClose = useCallback(() => {
    closeDrawer();
    onSettings();
  }, [closeDrawer, onSettings]);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerX.value }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));

  return (
    <CommunityDrawerContext.Provider value={{ drawerOpen, openDrawer }}>
      <View style={styles.shell}>
        <View style={styles.content}>{children}</View>
        {drawerOpen && (
          <View style={styles.drawerOverlay} testID="community-drawer-overlay">
            <Animated.View style={[styles.scrim, scrimStyle]}>
              <Pressable
                accessibilityLabel={`Close ${WORKSPACE_LABEL} switcher`}
                accessibilityRole="button"
                onPress={closeDrawer}
                style={StyleSheet.absoluteFill}
                testID="community-drawer-scrim"
              />
            </Animated.View>
            <Animated.View style={[styles.drawer, drawerStyle]} testID="community-drawer">
              <CommunityRail
                communities={communities}
                activeCommunityId={activeCommunityId}
                onSelect={selectAndClose}
                onAdd={addAndClose}
                onSettings={settingsAndClose}
                viewerPubkey={viewerPubkey}
                viewerAvatarUrl={viewerAvatarUrl}
              />
            </Animated.View>
          </View>
        )}
      </View>
    </CommunityDrawerContext.Provider>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: groknight.bgTerminal,
  },
  content: {
    flex: 1,
    minWidth: 0,
    backgroundColor: groknight.bgTerminal,
  },
  rail: {
    flex: 1,
    width: DRAWER_WIDTH,
    alignItems: 'center',
    backgroundColor: groknight.bgBase,
    borderRightWidth: 1,
    borderRightColor: groknight.border,
  },
  communityScroll: {
    flex: 1,
    width: '100%',
  },
  communityScrollContent: {
    alignItems: 'center',
  },
  railButtonSlot: {
    width: DRAWER_WIDTH,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addRailButton: {
    borderRadius: 13,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgHighlight,
    borderStyle: 'dashed',
  },
  addRailButtonText: {
    ...Typography.default(),
    color: groknight.chrome,
    fontSize: 20,
    fontWeight: '500',
  },
  settingsRailButtonText: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 18,
  },
  activeNotch: {
    position: 'absolute',
    left: 8,
    top: 6,
    width: 10,
    height: 10,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    borderColor: groknight.selectedBorder,
  },
  drawerOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: DRAWER_WIDTH,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    left: DRAWER_WIDTH,
    backgroundColor: groknight.bgTerminal,
  },
  drawerTrigger: {
    width: 76,
    height: 44,
    marginRight: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerAvatarButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerToggleButton: {
    width: 32,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerTriggerChevron: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 13,
  },
  avatarEditBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 17,
    height: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: groknight.selectedBorder,
    backgroundColor: groknight.bgRaised,
  },
  avatarEditBadgeText: {
    ...Typography.default('semiBold'),
    color: groknight.signalBright,
    fontSize: 11,
    lineHeight: 13,
  },
});
