import React, { createContext, useCallback, useContext, useState } from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from '@/components/buzz/IdentityMark';

const DRAWER_WIDTH = 72;
const DRAWER_DURATION_MS = 180;

export type CommunityRailItem = {
  communityId: string;
  name: string;
  avatar?: string;
};

type CommunityRailProps = {
  communities: CommunityRailItem[];
  activeCommunityId: string | null;
  onSelect: (communityId: string | null) => void;
  onAdd: () => void;
  onSettings: () => void;
  onWorkspaceSettings?: (communityId: string) => void;
  /** Long-press a Workspace tile to arm its exit affordance; confirm from there. */
  onLeaveWorkspace?: (communityId: string) => void;
  canManageActiveCommunity?: boolean;
  viewerPubkey?: string;
  viewerAvatarUrl?: string;
};

type RailButtonProps = {
  active: boolean;
  label: string;
  children: React.ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  exitArmed?: boolean;
  onExitPress?: () => void;
  testID?: string;
};

/**
 * A Workspace slot. Selection reads three redundant ways and none of them is a
 * box or a fill: a full-height bar on the rail's own edge, the mark's own
 * thicker active frame, and tone — the Workspace you are not in recedes a step
 * rather than the one you are in lighting up. A column of identical marks at
 * identical luminance was the thing that made the rail hard to read.
 */
function RailButton({
  active,
  label,
  children,
  onPress,
  onLongPress,
  exitArmed = false,
  onExitPress,
  testID,
}: RailButtonProps) {
  return (
    <View style={styles.railButtonSlot}>
      {active && <View style={styles.selectionBar} />}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        testID={testID}
        onPress={onPress}
        onLongPress={onLongPress}
        style={[styles.railButton, !active && styles.railButtonIdle]}
      >
        {children}
      </TouchableOpacity>
      {exitArmed && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Exit ${label}`}
          testID={`workspace-exit-${testID?.replace('community-rail-', '') ?? ''}`}
          onPress={onExitPress}
          style={styles.exitAffordance}
        >
          <Text style={styles.exitAffordanceGlyph}>×</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

type RailCommandProps = {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  glyph?: string;
  children?: React.ReactNode;
  testID?: string;
};

/**
 * A rail command: glyph (or identity mark) over a mono micro-label. The label
 * is what makes the rail deliberate instead of a column of mystery icons, and
 * it is why these need no border — the affordance is named, not framed.
 */
function RailCommand({
  label,
  accessibilityLabel,
  onPress,
  glyph,
  children,
  testID,
}: RailCommandProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.railCommand}
      testID={testID}
    >
      {glyph ? <Text style={styles.railCommandGlyph}>{glyph}</Text> : children}
      <Text style={styles.railCommandLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

export function CommunityRail({
  communities,
  activeCommunityId,
  onSelect,
  onAdd,
  onSettings,
  onWorkspaceSettings,
  onLeaveWorkspace,
  canManageActiveCommunity = false,
  viewerPubkey,
  viewerAvatarUrl,
}: CommunityRailProps) {
  const insets = useSafeAreaInsets();
  // Long-press arms ONE tile's exit affordance; any other tap dismisses it.
  const [exitArmedId, setExitArmedId] = useState<string | null>(null);
  const activeCommunity =
    communities.find((community) => community.communityId === activeCommunityId) ?? null;
  const showsWorkspaceSettings = Boolean(
    activeCommunity && canManageActiveCommunity && onWorkspaceSettings,
  );
  return (
    // No surface of its own: the rail is the same obsidian as the screen it
    // slides over, held apart by one hairline edge.
    <View
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
          const exitArmed = exitArmedId === community.communityId;
          return (
            <RailButton
              active={active}
              key={community.communityId}
              label={community.name}
              onPress={() => {
                if (exitArmedId) {
                  // A tap anywhere while the X is showing just dismisses it.
                  setExitArmedId(null);
                  return;
                }
                onSelect(community.communityId);
              }}
              onLongPress={
                onLeaveWorkspace
                  ? () => {
                      void Haptics.selectionAsync();
                      setExitArmedId(community.communityId);
                    }
                  : undefined
              }
              exitArmed={exitArmed}
              onExitPress={() => {
                setExitArmedId(null);
                onLeaveWorkspace?.(community.communityId);
              }}
              testID={`community-rail-${community.communityId}`}
            >
              <IdentityMark
                kind="workspace"
                seed={community?.communityId ?? 'workspace-loading'}
                avatarUrl={community?.avatar}
                name={community?.name}
                size={40}
                selected={active}
                testID={`workspace-avatar-${community.communityId}`}
              />
            </RailButton>
          );
        })}
      </ScrollView>

      {/* Commands, not identities: one zone, separated by a hairline rather
          than by a box around each control. */}
      <View style={styles.railDivider} />
      <RailCommand
        accessibilityLabel={`Create or join a ${WORKSPACE_LABEL}`}
        glyph="＋"
        label="ADD"
        onPress={onAdd}
        testID="community-rail-add"
      />
      {showsWorkspaceSettings && activeCommunity && (
        <RailCommand
          accessibilityLabel={`${activeCommunity.name} ${WORKSPACE_LABEL}`}
          glyph="⚙"
          label="WORKSPACE"
          onPress={() => onWorkspaceSettings?.(activeCommunity.communityId)}
          testID={`workspace-settings-${activeCommunity.communityId}`}
        />
      )}
      <View style={styles.railDivider} />
      <RailCommand
        accessibilityLabel="Your settings"
        glyph={viewerPubkey ? undefined : '⚙'}
        label="YOU"
        onPress={onSettings}
        testID="community-rail-settings"
      >
        {viewerPubkey ? (
          <IdentityMark
            kind="human"
            seed={viewerPubkey}
            avatarUrl={viewerAvatarUrl}
            name="You"
            size={34}
          />
        ) : null}
      </RailCommand>
      <View style={{ height: Math.max(insets.bottom, 8) }} />
    </View>
  );
}

type CommunityDrawerContextValue = {
  drawerOpen: boolean;
  openDrawer: () => void;
};

const CommunityDrawerContext = createContext<CommunityDrawerContextValue | null>(null);

type CommunityDrawerTriggerProps = {
  community?: CommunityRailItem | null;
};

/**
 * The Workspace identity *is* the switcher: one press target holding the mark,
 * the name, and a disclosure caret. Two adjacent targets doing the same thing
 * (the previous avatar + chevron pair) read as an accident.
 */
export function CommunityDrawerTrigger({ community }: CommunityDrawerTriggerProps) {
  const drawer = useContext(CommunityDrawerContext);
  if (!drawer) {
    throw new Error('CommunityDrawerTrigger must be rendered inside BuzzCommunityShell.');
  }
  return (
    <TouchableOpacity
      accessibilityLabel={`${community?.name ?? WORKSPACE_LABEL} — switch ${WORKSPACE_LABEL}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: drawer.drawerOpen }}
      onPress={drawer.openDrawer}
      style={styles.drawerTrigger}
      testID="workspace-avatar-trigger"
    >
      <IdentityMark
        kind="workspace"
        seed={community?.communityId ?? 'workspace-loading'}
        avatarUrl={community?.avatar}
        name={community?.name}
        size={26}
        testID="workspace-avatar-header"
      />
      <Text
        numberOfLines={1}
        style={styles.drawerTriggerName}
        testID={
          community ? `workspace-active-${community.communityId}` : 'workspace-active-loading'
        }
      >
        {community?.name ?? WORKSPACE_LABEL}
      </Text>
      <Text style={styles.drawerTriggerCaret}>⌄</Text>
    </TouchableOpacity>
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
  onWorkspaceSettings,
  onLeaveWorkspace,
  canManageActiveCommunity,
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

  const workspaceSettingsAndClose = useCallback(
    (communityId: string) => {
      closeDrawer();
      onWorkspaceSettings?.(communityId);
    },
    [closeDrawer, onWorkspaceSettings],
  );

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
                onWorkspaceSettings={workspaceSettingsAndClose}
                onLeaveWorkspace={onLeaveWorkspace}
                canManageActiveCommunity={canManageActiveCommunity}
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

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
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
      backgroundColor: groknight.bgTerminal,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: groknight.border,
    },
    communityScroll: {
      flex: 1,
      width: '100%',
    },
    communityScrollContent: {
      paddingVertical: 4,
      alignItems: 'center',
    },
    railButtonSlot: {
      width: DRAWER_WIDTH,
      height: 58,
      alignItems: 'center',
      justifyContent: 'center',
    },
    railButton: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /* Tone, not a box: an unselected Workspace mark sits one step back from the
     * one you are in. The rail is a quiet column you glance at, not a row of
     * competing badges. */
    railButtonIdle: { opacity: 0.5 },
    /* Exit affordance: one close glyph hung at the tile's own top-right corner,
     * on the same quiet chrome tier as every other rail glyph. It appears only
     * while a long-press has armed it. */
    exitAffordance: {
      position: 'absolute',
      top: 2,
      right: 4,
      width: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 3,
      backgroundColor: groknight.bgHover,
    },
    exitAffordanceGlyph: {
      ...Typography.default('semiBold'),
      color: groknight.textPrimary,
      fontSize: 14,
      lineHeight: 16,
      textAlign: 'center',
    },
    selectionBar: {
      position: 'absolute',
      top: 9,
      bottom: 9,
      left: 0,
      width: 2,
      backgroundColor: groknight.selectedBorder,
    },
    railDivider: {
      width: 40,
      height: 1,
      marginVertical: 6,
      backgroundColor: groknight.border,
    },
    railCommand: {
      width: DRAWER_WIDTH,
      minHeight: 48,
      paddingVertical: 4,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
    },
    /* A rail command is named, so its glyph does not also have to shout: the
     * mono micro-label under it carries the meaning and the glyph sits on the
     * same quiet tier as the rest of the chrome. */
    railCommandGlyph: {
      ...Typography.default(),
      height: 22,
      color: groknight.textSecondary,
      fontSize: 19,
      lineHeight: 22,
      textAlign: 'center',
    },
    railCommandLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.6,
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
      minHeight: 44,
      flex: 1,
      minWidth: 0,
      paddingRight: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    drawerTriggerName: {
      ...Typography.default('semiBold'),
      flexShrink: 1,
      color: groknight.textPrimary,
      fontSize: 17,
      lineHeight: 22,
    },
    drawerTriggerCaret: {
      ...Typography.default('semiBold'),
      color: groknight.steel,
      fontSize: 13,
      lineHeight: 16,
    },
  };
});
