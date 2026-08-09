import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community } from '@buzzy/buzz-client';
import { groknight } from '@/buzz/groknight';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

type CommunityRailProps = {
  communities: Community[];
  activeCommunityId: string | null;
  onSelect: (communityId: string | null) => void;
  onAdd: () => void;
};

function communityMark(name: string): string {
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
      accessibilityLabel="Community switcher"
      style={[styles.rail, { paddingTop: Math.max(insets.top, 10) }]}
    >
      <RailButton
        active={activeCommunityId === null}
        label="Standalone channels"
        mark="B"
        onPress={() => onSelect(null)}
        testID="community-rail-standalone"
      />
      <View style={styles.separator} />
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
        label="Create or join a community"
        mark="＋"
        onPress={onAdd}
        testID="community-rail-add"
      />
      <View style={{ height: Math.max(insets.bottom, 8) }} />
    </View>
  );
}

type BuzzCommunityShellProps = CommunityRailProps & {
  children: React.ReactNode;
};

export function BuzzCommunityShell({ children, ...railProps }: BuzzCommunityShellProps) {
  return (
    <View style={styles.shell}>
      <CommunityRail {...railProps} />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: groknight.bgTerminal,
  },
  content: {
    flex: 1,
    minWidth: 0,
    backgroundColor: groknight.bgTerminal,
  },
  rail: {
    width: 66,
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
    width: 66,
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
    fontFamily: mono,
    letterSpacing: 0.2,
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
  separator: {
    width: 30,
    height: 1,
    marginVertical: 2,
    backgroundColor: groknight.borderActive,
  },
});
