import React, { useState } from 'react';
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
}: {
  filter: RoomListFilter;
  onFilter: (filter: RoomListFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  onBookmarks?: () => void;
  searchRef?: React.RefObject<TextInput | null>;
  desktop?: boolean;
  bookmarksSelected?: boolean;
}) {
  const [searching, setSearching] = useState(desktop);
  const [focused, setFocused] = useState(false);
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
              {value === 'pinned' ? (
                <Ionicons
                  name="pin-outline"
                  size={17}
                  color={value === filter ? styles.selected.color : styles.label.color}
                />
              ) : (
                <Text style={[styles.label, value === filter && styles.selected]}>
                  {value === 'all' ? 'All' : value === 'unread' ? 'Unread' : 'Messages'}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search conversations"
          accessibilityState={{ expanded: searching }}
          onPress={() => {
            if (desktop) {
              searchRef?.current?.focus();
              return;
            }
            setSearching((value) => !value);
            if (searching) onQuery('');
          }}
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
            <BookmarksGlyph
              size={21}
              color={bookmarksSelected ? styles.selected.color : styles.label.color}
            />
          </Pressable>
        )}
      </View>
      {(searching || query.length > 0) && (
        <TextInput
          ref={searchRef}
          value={query}
          onChangeText={onQuery}
          accessibilityLabel="Search Rooms and direct messages"
          placeholder="Search conversations"
          placeholderTextColor={styles.label.color}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.search, focused && styles.searchFocused]}
          testID={desktop ? 'desktop-room-search' : 'room-search'}
        />
      )}
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
  selected: { color: theme.buzz.textPrimary },
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
