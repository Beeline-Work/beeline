import React, { useMemo } from 'react';
import { SectionList, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTextDraft } from '@/buzz/use-text-draft';
import {
  filterRepoCandidates,
  groupRepoCandidatesByOwner,
  repoShortName,
  type RepoCandidate,
} from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';

const ROW_HEIGHT = 40;
// Six rows, then the list scrolls.
const LIST_MAX_HEIGHT = ROW_HEIGHT * 6;

type Props = {
  candidates: RepoCandidate[];
  currentKey: string | null;
  loading: boolean;
  onSelect: (candidate: RepoCandidate) => void;
  testIDPrefix: string;
  draftContext: string;
};

/**
 * The Link list: search and repos under their owner. It only picks a repo;
 * orgs are connected from the Create owner menu or the GitHub Connect row.
 */
export function RepoList({
  candidates,
  currentKey,
  loading,
  onSelect,
  testIDPrefix,
  draftContext,
}: Props) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useTextDraft(`repo-search:${draftContext}:${testIDPrefix}`, '');
  const sections = useMemo(
    () =>
      groupRepoCandidatesByOwner(filterRepoCandidates(candidates, query)).map((group) => ({
        key: group.owner ? `owner-${group.owner.toLowerCase()}` : 'ungrouped',
        owner: group.owner,
        data: group.data,
      })),
    [candidates, query],
  );

  return (
    <View style={styles.container} testID={testIDPrefix}>
      <TextInput
        accessibilityLabel="Search repos"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search repos"
        placeholderTextColor={theme.buzz.textMuted}
        style={styles.search}
        testID={`${testIDPrefix}-search`}
        value={query}
      />
      <SectionList
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.empty} testID={`${testIDPrefix}-empty`}>
            {loading ? 'Loading repos…' : 'No repos match.'}
          </Text>
        }
        nestedScrollEnabled
        renderItem={({ item, section }) => (
          <TouchableOpacity
            accessibilityLabel={item.name}
            accessibilityRole="button"
            accessibilityState={{ selected: item.key === currentKey }}
            onPress={() => onSelect(item)}
            style={styles.row}
            testID={`${testIDPrefix}-candidate-${item.key}`}
          >
            <Text numberOfLines={1} style={styles.name}>
              {repoShortName(item, section.owner)}
            </Text>
            {item.key === currentKey && <Text style={styles.check}>✓</Text>}
          </TouchableOpacity>
        )}
        renderSectionHeader={({ section }) =>
          section.owner ? (
            <Text
              accessibilityRole="header"
              style={styles.owner}
              testID={`${testIDPrefix}-group-${section.owner.toLowerCase()}`}
            >
              {section.owner}
            </Text>
          ) : null
        }
        sections={sections}
        stickySectionHeadersEnabled={false}
        style={{ flexGrow: 0, maxHeight: LIST_MAX_HEIGHT }}
        testID={`${testIDPrefix}-list`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flexShrink: 1, minHeight: 0 },
    search: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      paddingHorizontal: 0,
      paddingTop: 0,
      paddingBottom: hull.space.sm,
      marginBottom: hull.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: hull.borderStrong,
    },
    owner: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      paddingTop: hull.space.xs,
    },
    row: {
      minHeight: ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: hull.space.sm,
    },
    name: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary, flex: 1 },
    check: { ...hull.type.body, color: hull.buttonPrimaryFill },
    empty: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      paddingVertical: hull.space.sm,
    },
  };
});
