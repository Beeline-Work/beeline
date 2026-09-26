import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { BookmarksGlyph } from './BookmarksGlyph';
import type { RoomListFilter } from '@/buzz/room-list-preferences';

export function RoomListToolbar({
  filter,
  onFilter,
  query,
  onQuery,
  onBookmarks,
  searchRef,
  desktop = false,
  bookmarksSelected = false,
  counts,
}: {
  filter: RoomListFilter;
  onFilter: (filter: RoomListFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  onBookmarks?: () => void;
  searchRef?: React.RefObject<TextInput | null>;
  desktop?: boolean;
  bookmarksSelected?: boolean;
  counts?: { all: number; unread: number; pinned: number };
}) {
  const localSearchRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  useEffect(() => {
    if (mobileSearchOpen && !desktop) (searchRef ?? localSearchRef).current?.focus();
  }, [desktop, mobileSearchOpen, searchRef]);
  const toggleSearch = () => {
    if (desktop) {
      (searchRef ?? localSearchRef).current?.focus();
    } else if (mobileSearchOpen) {
      (searchRef ?? localSearchRef).current?.blur();
      onQuery('');
      setMobileSearchOpen(false);
    } else {
      setMobileSearchOpen(true);
    }
  };
  const actions = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={mobileSearchOpen && !desktop ? 'Close search' : 'Search conversations'}
        accessibilityState={!desktop ? { expanded: mobileSearchOpen } : undefined}
        onPress={toggleSearch}
        style={styles.action}
        testID="room-search-toggle"
      >
        <Ionicons name="search-outline" size={21} color={styles.label.color} />
      </Pressable>
      {onBookmarks && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Bookmarks"
          accessibilityState={{ selected: bookmarksSelected }}
          onPress={onBookmarks}
          style={styles.action}
          testID={desktop ? 'desktop-bookmarks' : 'workspace-bookmarks'}
        >
          <BookmarksGlyph size={21} color={styles.bookmark.color} filled={bookmarksSelected} />
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
    <View style={desktop && styles.desktopSearchWrap}>
      <TextInput
        ref={searchRef ?? localSearchRef}
        value={query}
        onChangeText={onQuery}
        accessibilityLabel="Search Rooms and direct messages"
        placeholder="Search Rooms and direct messages"
        placeholderTextColor={styles.label.color}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.search, desktop && styles.desktopSearch, focused && styles.searchFocused]}
        testID={desktop ? 'desktop-room-search' : 'room-search'}
      />
    </View>
  );
  return (
    <View>
      {desktop && search}
      <View
        style={[styles.toolbar, !desktop && styles.mobileToolbar, desktop && styles.desktopToolbar]}
      >
        {filters}
        {!desktop && actions}
      </View>
      {!desktop && mobileSearchOpen && search}
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
  desktopToolbar: { paddingHorizontal: theme.buzz.space.md, borderBottomWidth: 0 },
  desktopFilters: {
    flex: 1,
    gap: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
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
  bookmark: { color: theme.buzz.accent },
  searchFocused: { borderBottomColor: theme.buzz.accent },
  search: {
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    padding: theme.buzz.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    minHeight: 44,
  },
  desktopSearchWrap: { paddingHorizontal: theme.buzz.space.md, paddingTop: 12, paddingBottom: 8 },
  desktopSearch: {
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.buzz.radius,
  },
}));
