import { HullActionSheetRow } from './HullActionSheet';
import { HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import React, { useMemo } from 'react';
import { SectionList, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTextDraft } from '@/buzz/use-text-draft';
import {
  filterRepoCandidates,
  groupRepoCandidatesByOwner,
  repoShortName,
  type RepoCandidate,
} from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';

// Six rows, then the list scrolls.
const LIST_MAX_HEIGHT = HULL_SHEET_ROW_HEIGHT * 6;

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
      <HullDialogInput
        accessibilityLabel="Search repos"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search repos"
        placeholderTextColor={theme.buzz.textMuted}
        variant="sheetSearch"
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
          <HullActionSheetRow
            accessibilityLabel={item.name}
            label={repoShortName(item, section.owner)}
            selected={item.key === currentKey}
            onPress={() => onSelect(item)}
            testID={`${testIDPrefix}-candidate-${item.key}`}
          />
        )}
        renderSectionHeader={({ section }) =>
          section.owner ? (
            <RoomListSectionHeader
              title={section.owner ?? ''} inset="content" surface="sheet"
              testID={`${testIDPrefix}-group-${section.owner.toLowerCase()}`}
            />
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
    empty: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      paddingVertical: hull.space.sm,
    },
  };
});
