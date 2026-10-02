import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MESSAGE_SEARCH_MIN_CHARS, type MessageSearchResult } from '@beeline/api-contract/phone';
import { compactRelativeTime } from '@/buzz/relative-time';
import type { MessageSearchFailure, MessageSearchState } from '@/buzz/use-message-search';
import { RoomListSectionHeader } from './RoomListSectionHeader';

/** The Messages section under the Room list while a search is typed. */
export function MessageSearchResults({
  search,
  now,
  onOpen,
}: {
  search: MessageSearchState;
  now: number;
  onOpen: (result: MessageSearchResult) => void;
}) {
  if (search.status === 'unavailable') return null;
  return (
    <View testID="message-search-results">
      <RoomListSectionHeader title="Messages" />
      {search.status === 'short' ? (
        <Text style={styles.note} testID="message-search-short">
          Type {MESSAGE_SEARCH_MIN_CHARS} or more letters to search messages.
        </Text>
      ) : search.status === 'filler' ? (
        <Text style={styles.note} testID="message-search-filler">
          Common words aren't searched. Type a more specific word.
        </Text>
      ) : search.status === 'loading' ? (
        <Text style={styles.note} testID="message-search-loading">
          Searching messages…
        </Text>
      ) : search.status === 'too_broad' ? (
        <Text style={styles.note} testID="message-search-too-broad">
          Too many messages match “{search.query}”. Add another word.
        </Text>
      ) : search.status === 'rate_limited' || search.status === 'error' ? (
        <Retry
          label={FAILURE_LABELS[search.status]}
          onPress={search.retry}
          testID={search.status === 'rate_limited' ? 'message-search-too-fast' : 'message-search-retry'}
        />
      ) : search.results.length === 0 ? (
        <Text style={styles.note} testID="message-search-empty">
          No messages match
        </Text>
      ) : (
        <>
          {search.results.map((result) => (
            <MessageSearchRow key={result.messageId} result={result} now={now} onOpen={onOpen} />
          ))}
          {search.moreFailed ? (
            <Retry
              label={search.moreFailed === 'error' ? "Couldn't load more." : FAILURE_LABELS[search.moreFailed]}
              onPress={search.loadMore}
              testID="message-search-more-retry"
            />
          ) : search.hasMore ? (
            <Pressable
              accessibilityRole="button"
              disabled={search.loadingMore}
              onPress={search.loadMore}
              style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              testID="message-search-more"
            >
              <Text style={styles.action}>{search.loadingMore ? 'Loading…' : 'Show more'}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

const FAILURE_LABELS: Record<MessageSearchFailure, string> = {
  too_broad: 'Too many messages match. Add another word.',
  rate_limited: 'Searching too fast. Wait a moment.',
  error: "Couldn't search messages.",
};

function MessageSearchRow({
  result,
  now,
  onOpen,
}: {
  result: MessageSearchResult;
  now: number;
  onOpen: (result: MessageSearchResult) => void;
}) {
  const sigil = result.directMessage ? '@' : '#';
  const room = result.roomName.replace(/^[#@]+/, '');
  const text = result.snippet.map((part) => part.text).join('');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${result.authorName} in ${sigil}${room}: ${text}`}
      onPress={() => onOpen(result)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`message-search-result-${result.messageId}`}
    >
      <View style={styles.meta}>
        <Text numberOfLines={1} style={styles.room}>
          <Text style={styles.sigil}>{sigil}</Text>
          {room}
        </Text>
        <Text style={styles.time}>{compactRelativeTime(result.createdAt, now)}</Text>
      </View>
      <Text numberOfLines={3} style={styles.snippet}>
        <Text style={styles.author}>{result.authorName}: </Text>
        {result.snippet.map((part, index) =>
          part.match ? (
            <Text key={index} style={styles.match} testID="message-search-match">
              {part.text}
            </Text>
          ) : (
            part.text
          ),
        )}
      </Text>
    </Pressable>
  );
}

function Retry({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <View style={styles.retryLine}>
      <Text style={styles.note}>{label}</Text>
      <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8} testID={testID}>
        <Text style={styles.action}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: 9,
    gap: 2,
  },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: theme.buzz.space.sm },
  room: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  sigil: { color: theme.buzz.accent },
  time: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  snippet: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  author: { color: theme.buzz.textPrimary },
  // Brass text, not a brass fill: the row is a pressable control.
  match: { color: theme.buzz.accent, fontFamily: theme.buzz.proseSemibold },
  note: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: 9,
  },
  retryLine: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  more: { paddingHorizontal: theme.buzz.space.md, paddingVertical: 9, minHeight: 44, justifyContent: 'center' },
  action: { ...theme.buzz.type.meta, color: theme.buzz.buttonSecondaryText },
}));
