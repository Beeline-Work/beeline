import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ForwardTarget, ForwardTargetGroup } from '@/buzz/message-forward';
import { Typography } from '@/constants/Typography';
import {
  HULL_SHEET_INSET,
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from './HullActionSheet';

type ForwardMessagePickerSheetProps = {
  busyRoomId: string | null;
  error: string | null;
  onClose: () => void;
  onForward: (target: ForwardTarget) => void;
  targets: readonly ForwardTarget[] | null;
  visible: boolean;
};

const SECTIONS: readonly { group: ForwardTargetGroup; label: string }[] = [
  { group: 'people', label: 'PEOPLE' },
  { group: 'agents', label: 'AGENTS' },
  { group: 'rooms', label: 'ROOMS' },
];

export function ForwardMessagePickerSheet({
  busyRoomId,
  error,
  onClose,
  onForward,
  targets,
  visible,
}: ForwardMessagePickerSheetProps) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  const filteredTargets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return targets ?? [];
    return (targets ?? []).filter((target) =>
      target.label.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [query, targets]);

  return (
    <HullActionSheetModal
      accessibilityLabel="Close forward picker"
      onClose={onClose}
      subtitle="Choose a Room or member in this Workspace"
      testID="forward-room-picker"
      title="Forward message"
      visible={visible}
    >
      <TextInput
        accessibilityLabel="Search forward destinations"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search destinations"
        placeholderTextColor={theme.buzz.textMuted}
        returnKeyType="search"
        style={styles.search}
        testID="forward-room-search"
        value={query}
      />
      <ScrollView
        contentContainerStyle={styles.list}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        style={styles.listViewport}
        testID="forward-room-list"
      >
        {targets === null ? (
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            LOADING DESTINATIONS…
          </Text>
        ) : filteredTargets.length ? (
          SECTIONS.map((section) => {
            const sectionTargets = filteredTargets.filter(
              (target) => target.group === section.group,
            );
            if (!sectionTargets.length) return null;
            return (
              <React.Fragment key={section.group}>
                <Text accessibilityRole="header" style={styles.section}>
                  {section.label}
                </Text>
                {sectionTargets.map((target) => (
                  <HullActionSheetRow
                    chevron="right"
                    disabled={Boolean(busyRoomId)}
                    key={`${target.kind}:${target.id}`}
                    label={target.label}
                    metadata={busyRoomId === target.id ? 'SENDING' : undefined}
                    onPress={() => onForward(target)}
                    testID={`forward-${target.kind}-${target.id}`}
                  />
                ))}
              </React.Fragment>
            );
          })
        ) : (
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {error ??
              (query.trim()
                ? `No destinations match “${query.trim()}”.`
                : 'NO OTHER DESTINATIONS AVAILABLE')}
          </Text>
        )}
      </ScrollView>
      <HullActionSheetCancel onPress={onClose} testID="forward-room-cancel" />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    search: {
      ...Typography.default(),
      ...groknight.type.meta,
      minHeight: 44,
      marginHorizontal: HULL_SHEET_INSET,
      paddingHorizontal: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.border,
      color: groknight.textPrimary,
      fontFamily: groknight.proseRegular,
    },
    listViewport: { maxHeight: 360, flexGrow: 0 },
    list: { paddingBottom: 4 },
    section: {
      ...Typography.mono('semiBold'),
      color: groknight.chrome,
      fontSize: 9,
      letterSpacing: 0.6,
      paddingTop: 14,
      paddingBottom: 4,
      paddingHorizontal: HULL_SHEET_INSET,
    },
    status: {
      ...groknight.type.sectionHead,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingVertical: 18,
      color: groknight.textMuted,
      textAlign: 'center',
    },
  };
});
