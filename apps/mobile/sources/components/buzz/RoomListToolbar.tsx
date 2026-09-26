import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { TrayGlyph } from './TrayGlyph';
import { compactNeedsYouCount } from '@/buzz/needs-you';
import type { RoomListFilter } from '@/buzz/room-list-preferences';

export function RoomListToolbar({
  filter,
  onFilter,
  query,
  onQuery,
  onTray,
  needsYouCount = 0,
  searchRef,
  searchOpen: controlledSearchOpen,
  onSearchOpenChange,
  desktop = false,
  traySelected = false,
  counts,
}: {
  filter: RoomListFilter;
  onFilter: (filter: RoomListFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  onTray?: () => void;
  /** The badge on the tray mark; absent at zero. */
  needsYouCount?: number;
  searchRef?: React.RefObject<TextInput | null>;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  desktop?: boolean;
  traySelected?: boolean;
  counts?: { all: number; unread: number; pinned: number };
}) {
  const localSearchRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const searchOpen = controlledSearchOpen ?? localSearchOpen;
  const setSearchOpen = (open: boolean) => {
    onSearchOpenChange?.(open);
    if (controlledSearchOpen === undefined) setLocalSearchOpen(open);
  };
  useEffect(() => {
    if (searchOpen) (searchRef ?? localSearchRef).current?.focus();
  }, [searchOpen, searchRef]);
  const toggleSearch = () => {
    if (searchOpen) {
      (searchRef ?? localSearchRef).current?.blur();
      onQuery('');
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
    }
  };
  const actions = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={searchOpen ? 'Close search' : 'Search conversations'}
        accessibilityState={{ expanded: searchOpen }}
        onPress={toggleSearch}
        style={styles.action}
        testID="room-search-toggle"
      >
        <Ionicons name="search-outline" size={21} color={styles.label.color} />
      </Pressable>
      {onTray && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={needsYouCount > 0 ? `Tray, ${needsYouCount} need you` : 'Tray'}
          accessibilityState={{ selected: traySelected }}
          onPress={onTray}
          style={styles.action}
          testID={desktop ? 'desktop-tray' : 'workspace-tray'}
        >
          <TrayGlyph
            size={22}
            color={styles.tray.color}
            cutColor={styles.tray.backgroundColor}
            filled={traySelected}
          />
          {needsYouCount > 0 ? (
            <View style={styles.needsCount} testID="tray-needs-you-count">
              <Text style={styles.needsCountText}>{compactNeedsYouCount(needsYouCount)}</Text>
            </View>
          ) : null}
        </Pressable>
      )}
    </>
  );
  const filters = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.filters, desktop && styles.desktopFilters]}
    >
      {(['all', 'unread', 'pinned'] as const).map((value) => (
        <Pressable
          key={value}
          accessibilityRole="button"
          accessibilityLabel={`${value} conversations`}
          accessibilityState={{ selected: value === filter }}
          onPress={() => onFilter(value)}
          style={[styles.filter, !desktop && styles.mobileFilter, desktop && styles.desktopFilter]}
          testID={`room-filter-${value}`}
        >
          <Text style={[styles.label, value === filter && styles.selected]}>
            {value === 'pinned' ? 'Pinned' : value === 'all' ? 'All' : 'Unread'}
            {counts ? <Text style={styles.count}> {counts[value]}</Text> : null}
          </Text>
          {desktop && value === filter && <View style={styles.selectedRule} />}
        </Pressable>
      ))}
    </ScrollView>
  );
  const search = (
    <View>
      <TextInput
        ref={searchRef ?? localSearchRef}
        value={query}
        onChangeText={onQuery}
        accessibilityLabel="Search Rooms and direct messages"
        placeholder="Search Rooms and direct messages"
        placeholderTextColor={styles.label.color}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.search, focused && styles.searchFocused]}
        testID={desktop ? 'desktop-room-search' : 'room-search'}
      />
    </View>
  );
  return (
    <View>
      <View
        style={[styles.toolbar, !desktop && styles.mobileToolbar, desktop && styles.desktopToolbar]}
      >
        {filters}
        {actions}
      </View>
      {searchOpen && search}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.buzz.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  mobileToolbar: { paddingLeft: theme.buzz.space.md },
  filters: { flexDirection: 'row', gap: theme.buzz.space.sm, alignItems: 'center' },
  desktopToolbar: { paddingLeft: theme.buzz.space.md },
  desktopFilters: {
    flex: 1,
    gap: 20,
  },
  filter: { minHeight: 44, minWidth: 32, alignItems: 'center', justifyContent: 'center' },
  desktopFilter: { minHeight: 30, position: 'relative' },
  mobileFilter: { alignItems: 'flex-start' },
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  label: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  count: { color: theme.buzz.ledgerQuiet },
  selected: { color: theme.buzz.textPrimary },
  selectedRule: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -StyleSheet.hairlineWidth,
    height: 1,
    backgroundColor: theme.buzz.accent,
  },
  tray: { color: theme.buzz.accent, backgroundColor: theme.buzz.bgBase },
  needsCount: {
    position: 'absolute',
    top: 2,
    right: 1,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.buzz.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.accent,
  },
  needsCountText: {
    ...theme.buzz.type.sectionHead,
    letterSpacing: 0,
    color: theme.buzz.textInverted,
    fontVariant: ['tabular-nums'],
  },
  searchFocused: { borderBottomColor: theme.buzz.accent },
  search: {
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    padding: theme.buzz.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    minHeight: 44,
  },
}));
