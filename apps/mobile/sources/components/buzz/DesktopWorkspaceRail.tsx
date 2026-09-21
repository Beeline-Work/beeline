import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { DesktopWorkspacePortal } from '@/components/buzz/DesktopWorkspacePortal';

const RAIL_WIDTH = 76;
const TILE_SIZE = 48;

/**
 * The Workspace tile bezel. A border eats into the curve, so the radius inside
 * the bezel is the outer radius LESS the border width. Same numbers as the
 * mobile drawer (`CommunityRail`), which wears this same tile.
 */
const TILE_RADIUS = 14;
const TILE_BORDER_WIDTH = 2;
const TILE_INNER_RADIUS = TILE_RADIUS - TILE_BORDER_WIDTH;
/**
 * The picture is seated in the bezel like a picture in a frame, not clipped
 * against it: the whole picture stays visible with slab showing all the way
 * round, and no corner of it touches the brass. Its own radius is the inner
 * radius less that margin, which keeps its curve parallel to the bezel's the
 * whole way round instead of tightening into the corners.
 */
const TILE_PICTURE_SIZE = 34;
const TILE_PICTURE_MARGIN = (TILE_SIZE - TILE_BORDER_WIDTH * 2 - TILE_PICTURE_SIZE) / 2;
const TILE_PICTURE_RADIUS = TILE_INNER_RADIUS - TILE_PICTURE_MARGIN;

export type DesktopWorkspaceRailItem = {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly roomCount: number;
  readonly needsAttention: boolean;
};

type DesktopWorkspaceRailProps = {
  readonly open: boolean;
  readonly workspaces: readonly DesktopWorkspaceRailItem[];
  readonly activeWorkspaceId: string | null;
  readonly onClose: () => void;
  readonly onSelect: (workspaceId: string) => void;
  readonly onAdd: () => void;
  /** The account hub. The rail's scrim covers the pane that also names it. */
  readonly onOpenAccount: () => void;
  readonly viewerPubkey?: string;
  readonly viewerName?: string;
  readonly viewerAvatarUrl?: string;
  readonly viewerFace?: string;
};

export function DesktopWorkspaceRail({
  open,
  workspaces,
  activeWorkspaceId,
  onClose,
  onSelect,
  onAdd,
  onOpenAccount,
  viewerPubkey,
  viewerName,
  viewerAvatarUrl,
  viewerFace,
}: DesktopWorkspaceRailProps) {
  const styles = stylesheet;
  const reducedMotion = useReducedMotion();
  const railX = useSharedValue(reducedMotion ? 0 : -RAIL_WIDTH);
  const tileRefs = React.useRef<Array<any>>([]);
  const [hoveredWorkspaceId, setHoveredWorkspaceId] = React.useState<string | null>(null);
  const [focusedWorkspaceId, setFocusedWorkspaceId] = React.useState<string | null>(null);
  const [addFocused, setAddFocused] = React.useState(false);
  const [accountFocused, setAccountFocused] = React.useState(false);
  const [accountHovered, setAccountHovered] = React.useState(false);
  const activeIndex = Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId),
  );
  const focusedIndexRef = React.useRef(activeIndex);

  React.useEffect(() => {
    if (!open) return;
    focusedIndexRef.current = activeIndex;
    railX.value = reducedMotion ? 0 : -RAIL_WIDTH;
    railX.value = withTiming(0, {
      duration: reducedMotion ? 0 : 180,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      reduceMotion: ReduceMotion.System,
    });
    const frame = requestAnimationFrame(() => tileRefs.current[activeIndex]?.focus?.());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open, railX, reducedMotion]);

  React.useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Enter') {
        if (focusedIndexRef.current === workspaces.length) {
          event.preventDefault();
          onAdd();
          return;
        }
        if (focusedIndexRef.current === workspaces.length + 1) {
          event.preventDefault();
          onOpenAccount();
          return;
        }
        const workspace = workspaces[focusedIndexRef.current];
        if (!workspace) return;
        event.preventDefault();
        if (workspace.id === activeWorkspaceId) onClose();
        else onSelect(workspace.id);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const startIndex = focusedIndexRef.current;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // Workspaces, then the add tile, then the account hub.
      const itemCount = workspaces.length + 2;
      const nextIndex = (startIndex + delta + itemCount) % itemCount;
      focusedIndexRef.current = nextIndex;
      tileRefs.current[nextIndex]?.focus?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeWorkspaceId,
    activeIndex,
    onAdd,
    onClose,
    onOpenAccount,
    onSelect,
    open,
    workspaces,
  ]);

  const animatedRailStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: railX.value }],
  }));

  if (!open) return null;

  return (
    <DesktopWorkspacePortal>
      <View
        accessibilityLabel="Workspace switcher"
        accessibilityViewIsModal
        style={styles.overlay}
        testID="desktop-workspace-rail-overlay"
      >
        <Pressable
          accessibilityLabel="Close Workspace switcher"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scrim}
          testID="desktop-workspace-rail-scrim"
        />
        <Animated.View
          accessibilityLabel="Workspaces"
          accessibilityRole="menu"
          style={[styles.rail, animatedRailStyle]}
          testID="desktop-workspace-rail"
        >
          <View style={styles.workspaceList}>
            {workspaces.map((workspace, index) => {
              const current = workspace.id === activeWorkspaceId;
              const labelled = (hoveredWorkspaceId ?? focusedWorkspaceId) === workspace.id;
              const roomLabel = `${workspace.roomCount} Rooms`;
              return (
                <View key={workspace.id} style={styles.tileSlot}>
                  {(current || workspace.needsAttention) && (
                    <View
                      style={[styles.pill, current ? styles.currentPill : styles.attentionPill]}
                      testID={
                        current
                          ? `desktop-workspace-current-${workspace.id}`
                          : `desktop-workspace-needs-you-${workspace.id}`
                      }
                    />
                  )}
                  <Pressable
                    accessibilityLabel={`${workspace.name}, ${roomLabel}${
                      current ? ', you are here' : workspace.needsAttention ? ', needs you' : ''
                    }`}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: current }}
                    onBlur={() => {
                      setFocusedWorkspaceId(null);
                    }}
                    onFocus={() => {
                      focusedIndexRef.current = index;
                      setFocusedWorkspaceId(workspace.id);
                    }}
                    onHoverIn={() => setHoveredWorkspaceId(workspace.id)}
                    onHoverOut={() => setHoveredWorkspaceId(null)}
                    onPress={() => (current ? onClose() : onSelect(workspace.id))}
                    ref={(node) => {
                      tileRefs.current[index] = node;
                    }}
                    style={[
                      styles.tile,
                      current && styles.currentTile,
                      focusedWorkspaceId === workspace.id && styles.focusedTile,
                    ]}
                    testID={`desktop-workspace-tile-${workspace.id}`}
                  >
                    <View style={styles.tilePictureSeat}>
                      <IdentityMark
                        avatarUrl={workspace.avatar}
                        kind="workspace"
                        name={workspace.name}
                        seed={workspace.id}
                        size={TILE_PICTURE_SIZE}
                        testID={`desktop-workspace-mark-${workspace.id}`}
                      />
                    </View>
                  </Pressable>
                  {labelled && (
                    <View
                      pointerEvents="none"
                      style={styles.label}
                      testID="desktop-workspace-label"
                    >
                      <Text numberOfLines={1} style={styles.labelName}>
                        {workspace.name}
                      </Text>
                      <Text style={styles.labelMeta}>
                        {roomLabel}
                        {current ? ' · you are here' : ''}
                      </Text>
                    </View>
                  )}
                </View>
              );
            })}
            <View style={styles.separator} />
            <Pressable
              accessibilityLabel="Create or join a Workspace"
              accessibilityRole="menuitem"
              onBlur={() => setAddFocused(false)}
              onFocus={() => {
                focusedIndexRef.current = workspaces.length;
                setAddFocused(true);
              }}
              onPress={onAdd}
              ref={(node) => {
                tileRefs.current[workspaces.length] = node;
              }}
              style={[styles.tile, styles.addTile, addFocused && styles.focusedTile]}
              testID="desktop-workspace-add"
            >
              <Text style={styles.addGlyph}>+</Text>
            </Pressable>
            <View style={styles.separator} />
            {/* The account hub. The rail's scrim covers the navigation pane
                that also names it, so without this the rail is a dead end for
                everything that is not a Workspace. */}
            <View style={styles.tileSlot}>
              <Pressable
                accessibilityLabel={viewerName ? `${viewerName} — Settings` : 'Settings'}
                accessibilityRole="menuitem"
                onBlur={() => setAccountFocused(false)}
                onFocus={() => {
                  focusedIndexRef.current = workspaces.length + 1;
                  setAccountFocused(true);
                }}
                onHoverIn={() => setAccountHovered(true)}
                onHoverOut={() => setAccountHovered(false)}
                onPress={onOpenAccount}
                ref={(node) => {
                  tileRefs.current[workspaces.length + 1] = node;
                }}
                style={[styles.tile, accountFocused && styles.focusedTile]}
                testID="desktop-workspace-account"
              >
                {viewerPubkey ? (
                  <IdentityMark
                    avatarUrl={viewerAvatarUrl}
                    face={viewerFace}
                    kind="human"
                    name={viewerName ?? 'You'}
                    seed={viewerPubkey}
                    size={32}
                    testID="desktop-workspace-account-mark"
                  />
                ) : (
                  // The identity has not loaded yet. Hold the mark's box open
                  // rather than drawing a stand-in, exactly as the navigation
                  // pane's own account row does.
                  <View style={styles.accountMarkSlot} />
                )}
              </Pressable>
              {(accountHovered || accountFocused) && (
                <View
                  pointerEvents="none"
                  style={styles.label}
                  testID="desktop-workspace-account-label"
                >
                  <Text numberOfLines={1} style={styles.labelName}>
                    Settings
                  </Text>
                  {viewerName ? <Text style={styles.labelMeta}>{viewerName}</Text> : null}
                </View>
              )}
            </View>
          </View>
        </Animated.View>
      </View>
    </DesktopWorkspacePortal>
  );
}

const stylesheet = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    overlay: {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: 2000,
    } as any,
    scrim: {
      ...StyleSheet.absoluteFillObject,
      left: RAIL_WIDTH,
      // The canvas color itself plus alpha, so the dim reads as "this
      // theme's own ground, deepened" on either Obsidian or Bone rather than
      // a hardcoded Obsidian aubergine dimming a Bone app to near-black.
      backgroundColor: `${hull.bgVoid}A8`,
    },
    rail: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: RAIL_WIDTH,
      overflow: 'visible',
      alignItems: 'center',
      backgroundColor: hull.bgRaised,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: hull.borderStrong,
    },
    workspaceList: { paddingTop: 14, alignItems: 'center', gap: 10, overflow: 'visible' },
    tileSlot: {
      position: 'relative',
      width: TILE_SIZE,
      height: TILE_SIZE,
      overflow: 'visible',
    },
    tile: {
      width: TILE_SIZE,
      height: TILE_SIZE,
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: TILE_RADIUS,
      backgroundColor: hull.bgHighlight,
      outlineStyle: 'none',
    } as any,
    /* The picture's seat: square, centred, and rounded parallel to the bezel.
     * It rounds the picture's own corners; the generated Workspace cypher draws
     * well inside this box, so it keeps the square silhouette it is meant to
     * have. Centred in the tile, so the seat does not move when a Workspace
     * becomes current and the tile puts its bezel on. */
    tilePictureSeat: {
      width: TILE_PICTURE_SIZE,
      height: TILE_PICTURE_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: TILE_PICTURE_RADIUS,
      overflow: 'hidden',
    },
    currentTile: { borderWidth: 2, borderColor: hull.accent },
    focusedTile: { borderWidth: 2, borderColor: hull.accent },
    pill: {
      position: 'absolute',
      left: -14,
      top: '50%',
      width: 4,
      borderTopRightRadius: 3,
      borderBottomRightRadius: 3,
      backgroundColor: hull.accent,
      transform: [{ translateY: '-50%' }],
    } as any,
    currentPill: { height: 36 },
    attentionPill: { height: 10 },
    label: {
      position: 'absolute',
      // The rail centres each `TILE_SIZE` tile in `RAIL_WIDTH`, so a slot's
      // left edge sits `(RAIL_WIDTH - TILE_SIZE) / 2` in; a label hung at
      // `RAIL_WIDTH` from the slot's origin therefore lands exactly on the
      // rail's right edge with a zero-pixel gap and reads as glued to it.
      // RAIL_WIDTH / 2 + TILE_SIZE / 2 is the slot-relative distance to that
      // edge; one spacing step past it is the deliberate breathing room.
      left: RAIL_WIDTH / 2 + TILE_SIZE / 2 + hull.space.sm,
      top: '50%',
      minWidth: 120,
      maxWidth: 260,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
      borderRadius: 8,
      backgroundColor: hull.bgHighlight,
      transform: [{ translateY: '-50%' }],
      zIndex: 2,
    } as any,
    labelName: {
      ...hull.type.meta,
      color: hull.textPrimary,
    },
    labelMeta: {
      ...hull.type.meta,
      color: hull.textMuted,
    },
    separator: { width: 32, height: 1, marginVertical: 4, backgroundColor: hull.borderStrong },
    addTile: {
      backgroundColor: 'transparent',
      borderWidth: StyleSheet.hairlineWidth,
      borderStyle: 'dashed',
      borderColor: hull.borderStrong,
    },
    addGlyph: {
      ...hull.type.hero,
      color: hull.accent,
    },
    accountMarkSlot: { width: 32, height: 32 },
  };
});
