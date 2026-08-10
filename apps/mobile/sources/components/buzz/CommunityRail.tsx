import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community } from '@buzzy/buzz-client';
import { groknight } from '@/buzz/groknight';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';

const DRAWER_WIDTH = 72;
const DRAWER_DURATION_MS = 180;

type CommunityRailProps = {
  communities: Community[];
  activeCommunityId: string | null;
  onSelect: (communityId: string | null) => void;
  onAdd: () => void;
};

export function communityMark(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

type RailButtonProps = {
  active: boolean;
  label: string;
  mark: string;
  onPress: () => void;
  testID?: string;
};

function RailButton({ active, label, mark, onPress, testID }: RailButtonProps) {
  return (
    <View style={styles.railButtonSlot}>
      {active && <View style={styles.activePill} />}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        testID={testID}
        onPress={onPress}
        style={[styles.railButton, active && styles.railButtonActive]}
      >
        <Text style={[styles.railMark, active && styles.railMarkActive]}>{mark}</Text>
      </TouchableOpacity>
    </View>
  );
}

export function CommunityRail({
  communities,
  activeCommunityId,
  onSelect,
  onAdd,
}: CommunityRailProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityLabel={`${WORKSPACE_LABEL} switcher`}
      style={[styles.rail, { paddingTop: Math.max(insets.top, 10) }]}
    >
      <ScrollView
        style={styles.communityScroll}
        contentContainerStyle={styles.communityScrollContent}
        showsVerticalScrollIndicator={false}
      >
        {communities.map((community) => (
          <RailButton
            key={community.communityId}
            active={activeCommunityId === community.communityId}
            label={community.name}
            mark={communityMark(community.name)}
            onPress={() => onSelect(community.communityId)}
            testID={`community-rail-${community.communityId}`}
          />
        ))}
      </ScrollView>
      <RailButton
        active={false}
        label={`Create or join a ${WORKSPACE_LABEL}`}
        mark="＋"
        onPress={onAdd}
        testID="community-rail-add"
      />
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
  communityName?: string;
};

export function CommunityDrawerTrigger({ communityName }: CommunityDrawerTriggerProps) {
  const drawer = useContext(CommunityDrawerContext);
  if (!drawer) {
    throw new Error('CommunityDrawerTrigger must be rendered inside BuzzCommunityShell.');
  }

  return (
    <TouchableOpacity
      accessibilityLabel={`Open ${WORKSPACE_LABEL} switcher`}
      accessibilityRole="button"
      accessibilityState={{ expanded: drawer.drawerOpen }}
      onPress={drawer.openDrawer}
      style={styles.drawerTrigger}
      testID="community-drawer-trigger"
    >
      <Text style={styles.drawerTriggerMark}>
        {communityName ? communityMark(communityName) : 'B'}
      </Text>
      <Text style={styles.drawerTriggerChevron}>›</Text>
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
}: BuzzCommunityShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerX = useRef(new Animated.Value(-DRAWER_WIDTH)).current;

  const openDrawer = useCallback(() => {
    drawerX.setValue(-DRAWER_WIDTH);
    setDrawerOpen(true);
    Animated.timing(drawerX, {
      toValue: 0,
      duration: DRAWER_DURATION_MS,
      useNativeDriver: true,
    }).start();
  }, [drawerX]);

  const closeDrawer = useCallback(() => {
    Animated.timing(drawerX, {
      toValue: -DRAWER_WIDTH,
      duration: DRAWER_DURATION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setDrawerOpen(false);
    });
  }, [drawerX]);

  const selectAndClose = useCallback(
    (communityId: string | null) => {
      closeDrawer();
      onSelect(communityId);
    },
    [closeDrawer, onSelect],
  );

  const addAndClose = useCallback(() => {
    closeDrawer();
    onAdd();
  }, [closeDrawer, onAdd]);

  return (
    <CommunityDrawerContext.Provider value={{ drawerOpen, openDrawer }}>
      <View style={styles.shell}>
        <View style={styles.content}>{children}</View>
        {drawerOpen && (
          <View style={styles.drawerOverlay} testID="community-drawer-overlay">
            <Pressable
              accessibilityLabel={`Close ${WORKSPACE_LABEL} switcher`}
              accessibilityRole="button"
              onPress={closeDrawer}
              style={styles.scrim}
              testID="community-drawer-scrim"
            />
            <Animated.View
              style={[styles.drawer, { transform: [{ translateX: drawerX }] }]}
              testID="community-drawer"
            >
              <CommunityRail
                communities={communities}
                activeCommunityId={activeCommunityId}
                onSelect={selectAndClose}
                onAdd={addAndClose}
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
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railButton: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgHighlight,
  },
  railButtonActive: {
    borderWidth: 2,
    borderColor: groknight.accent,
    backgroundColor: groknight.bgHover,
  },
  railMark: {
    color: groknight.chrome,
    fontSize: 13,
    fontWeight: '800',
  },
  railMarkActive: {
    color: groknight.accent,
  },
  activePill: {
    position: 'absolute',
    left: 0,
    width: 4,
    height: 24,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    backgroundColor: groknight.accent,
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
    opacity: 0.78,
  },
  drawerTrigger: {
    width: 44,
    height: 44,
    marginRight: 10,
    borderRadius: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgHighlight,
  },
  drawerTriggerMark: {
    color: groknight.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  drawerTriggerChevron: {
    marginLeft: 2,
    color: groknight.steel,
    fontSize: 13,
    fontWeight: '700',
  },
});
