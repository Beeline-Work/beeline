/**
 * THROWAWAY TYPE EXPLORATION SCREEN — delete with the rest of the toggle once
 * the captain picks a direction. See `@/buzz/font-exploration`.
 *
 * This screen deliberately bypasses the shared typography system for its own
 * preview rows: each row has to render in the family it is offering, not in the
 * currently-active one, so it reads families straight off the direction table.
 * That is also why it is excluded from `Typography.test.ts`'s allowlisted file
 * set — it is the one place in the Buzz surface where an explicit fontFamily is
 * the point.
 */
import React, { useCallback, useState } from 'react';
import { DevSettings, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';

import { groknight } from '@/buzz/groknight';
import {
  FONT_DIRECTIONS,
  readActiveFontDirectionId,
  writeActiveFontDirectionId,
  type FontDirection,
  type FontDirectionId,
} from '@/buzz/font-exploration';
import { HullSurface } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';

const PROSE_SAMPLE = 'The corner is quiet. I read the file, found the seam, and left the rest alone.';
const MACHINE_SAMPLE = 'CORNER · fm/font-explore · a19f3c8 · 3 FILES';

/**
 * The direction only takes effect after the JS bundle reloads: every Buzz screen
 * bakes its font families into a module-level StyleSheet at import time, so the
 * families cannot be swapped in place. A reload is not a rebuild — it costs
 * about a second and keeps the installed build.
 */
async function reloadIntoDirection(id: FontDirectionId): Promise<void> {
  writeActiveFontDirectionId(id);
  try {
    await Updates.reloadAsync();
  } catch {
    DevSettings.reload();
  }
}

function DirectionRow({
  direction,
  active,
  pending,
  onSelect,
}: {
  direction: FontDirection;
  active: boolean;
  pending: boolean;
  onSelect: (id: FontDirectionId) => void;
}) {
  return (
    <TouchableOpacity
      accessibilityLabel={`Use type direction ${direction.name}`}
      accessibilityState={{ selected: active }}
      disabled={pending}
      onPress={() => onSelect(direction.id)}
      style={styles.directionRow}
      testID={`font-direction-${direction.id}`}
    >
      <View style={styles.directionHead}>
        <Text style={styles.selectionGlyph}>{active ? '▣' : '▢'}</Text>
        <Text
          style={[styles.directionName, { fontFamily: direction.body.semiBold }]}
          numberOfLines={1}
        >
          {direction.name}
        </Text>
        {active ? <Text style={styles.activeTag}>ACTIVE</Text> : null}
        {pending ? <Text style={styles.activeTag}>RELOADING…</Text> : null}
      </View>

      <Text style={styles.directionBlurb}>{direction.blurb}</Text>

      <Text style={[styles.proseSample, { fontFamily: direction.body.regular }]}>
        {PROSE_SAMPLE}
      </Text>
      <Text style={[styles.machineSample, { fontFamily: direction.mono.semiBold }]}>
        {MACHINE_SAMPLE}
      </Text>

      <Text style={styles.licenseLine}>{direction.licenses}</Text>
    </TouchableOpacity>
  );
}

export default function BuzzFontExploration() {
  const insets = useSafeAreaInsets();
  const [activeId] = useState<FontDirectionId>(() => readActiveFontDirectionId());
  const [pendingId, setPendingId] = useState<FontDirectionId | null>(null);

  const handleSelect = useCallback(
    (id: FontDirectionId) => {
      if (id === activeId || pendingId) {
        return;
      }
      setPendingId(id);
      void reloadIntoDirection(id);
    },
    [activeId, pendingId],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HullSurface strength="quiet" style={styles.header}>
        <TouchableOpacity accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Type direction</Text>
          <Text style={styles.headerMeta}>EXPLORATION · NOT A SHIPPING SETTING</Text>
        </View>
      </HullSurface>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        testID="font-direction-list"
      >
        <Text style={styles.intro}>
          Pick a direction to feel it in the real room and corner. Selecting one saves the choice
          and reloads the bundle — about a second, no reinstall. Every sample below is drawn in the
          family it is offering, so the list itself is a specimen sheet.
        </Text>

        {FONT_DIRECTIONS.map((direction) => (
          <DirectionRow
            key={direction.id}
            direction={direction}
            active={direction.id === activeId}
            pending={pendingId === direction.id}
            onSelect={handleSelect}
          />
        ))}

        <Text style={styles.footer}>
          All candidates are SIL Open Font License 1.1 and bundled with the app. Nothing here is a
          committed choice — the follow-up change keeps only the winner.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 66,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.default(), color: groknight.chrome, fontSize: 30, lineHeight: 34 },
  headerCopy: { flex: 1, minWidth: 0, paddingRight: 44 },
  title: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 18 },
  headerMeta: {
    ...Typography.mono('semiBold'),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.7,
  },
  content: { paddingTop: 20, paddingHorizontal: 18 },
  intro: {
    ...Typography.default(),
    marginBottom: 22,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  directionRow: {
    paddingBottom: 20,
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  directionHead: { flexDirection: 'row', alignItems: 'center' },
  selectionGlyph: {
    ...Typography.mono(),
    width: 20,
    color: groknight.textSecondary,
    fontSize: 13,
  },
  directionName: { flexShrink: 1, color: groknight.textPrimary, fontSize: 16 },
  activeTag: {
    ...Typography.mono('semiBold'),
    marginLeft: 8,
    color: groknight.accent,
    fontSize: 9,
    letterSpacing: 0.8,
  },
  directionBlurb: {
    ...Typography.default(),
    marginTop: 6,
    marginLeft: 20,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  proseSample: {
    marginTop: 14,
    marginLeft: 20,
    color: groknight.textPrimary,
    fontSize: 14,
    lineHeight: 21,
  },
  machineSample: {
    marginTop: 10,
    marginLeft: 20,
    color: groknight.textSecondary,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  licenseLine: {
    ...Typography.mono(),
    marginTop: 12,
    marginLeft: 20,
    color: groknight.textDisabled,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  footer: {
    ...Typography.default(),
    color: groknight.textDisabled,
    fontSize: 10,
    lineHeight: 15,
  },
});
