import React, { useRef, useState } from 'react';
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
  const actions = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search conversations"
        onPress={() => (searchRef ?? localSearchRef).current?.focus()}
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
  return (
    <View>
      <View style={styles.toolbar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          {(['all', 'unread', 'messages', 'pinned'] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`${value} conversations`}
              accessibilityState={{ selected: value === filter }}
              onPress={() => onFilter(value)}
              style={styles.filter}
              testID={`room-filter-${value}`}
            >
              <Text style={[styles.label, value === filter && styles.selected]}>
                {value === 'all'
                  ? 'All'
                  : value === 'unread'
                    ? 'Unread'
                    : value === 'messages'
                      ? 'Messages'
                      : 'Pinned'}
                {counts && (value !== 'all' || !desktop) && value !== 'messages' ? (
                  <Text style={styles.count}> {counts[value]}</Text>
                ) : null}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {!desktop && actions}
      </View>
      <View style={desktop && styles.desktopSearchRow}>
        <TextInput
          ref={searchRef ?? localSearchRef}
          value={query}
          onChangeText={onQuery}
          accessibilityLabel="Search Rooms and direct messages"
          placeholder="Search conversations"
          placeholderTextColor={styles.label.color}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.search, desktop && styles.desktopSearch, focused && styles.searchFocused]}
          testID={desktop ? 'desktop-room-search' : 'room-search'}
        />
        {desktop && actions}
      </View>
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
  filters: { flexDirection: 'row', gap: theme.buzz.space.sm, alignItems: 'center' },
  filter: { minHeight: 44, minWidth: 32, alignItems: 'center', justifyContent: 'center' },
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  label: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  count: { color: theme.buzz.ledgerQuiet },
  selected: { color: theme.buzz.textPrimary },
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
  desktopSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  desktopSearch: { flex: 1, minWidth: 0, borderBottomWidth: 0 },
}));
