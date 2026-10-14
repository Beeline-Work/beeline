import React from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { Button } from './Button';

type Props = {
  item: Pick<
    NotificationLifecycleRun['items'][number],
    'id' | 'title' | 'kindLine' | 'actor' | 'cornerId' | 'url'
  >;
  objective?: string;
  authorPrefix?: string;
  onSelect?(): void;
  selectionTestID?: string;
  state: string;
  stateColor: React.ComponentProps<typeof Animated.Text>['style'];
  titleColor?: React.ComponentProps<typeof Animated.Text>['style'];
  testID: string;
  cornerActionTestID: string;
  urlActionTestID: string;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
};

/** One anatomy for every visible corner, PR, issue and check row. */
export function LifecycleRow({
  item,
  objective,
  authorPrefix,
  onSelect,
  selectionTestID,
  state,
  stateColor,
  titleColor,
  testID,
  cornerActionTestID,
  urlActionTestID,
  onOpenCorner,
  onOpenUrl,
}: Props) {
  const { theme } = useUnistyles();
  const attribution =
    authorPrefix ?? (state === 'opened' && item.cornerId ? 'corner · opened by ' : 'by ');
  const body = (
    <View style={styles.body}>
      <View style={styles.stateSlot}>
        <Animated.Text style={[styles.state, stateColor]}>{state}</Animated.Text>
      </View>
      <View style={styles.copy}>
        <Animated.Text style={[styles.title, titleColor]}>
          <Text>{item.title}</Text>
        </Animated.Text>
        <Text style={styles.kindLine}>{item.kindLine}</Text>
        {objective ? <Text style={styles.objective}>{objective}</Text> : null}
        {item.actor ? (
          <Text style={styles.author}>
            {attribution}
            <Text style={{ color: theme.buzz.accent }}>{`@${item.actor.replace(/^@/, '')}`}</Text>
          </Text>
        ) : null}
      </View>
    </View>
  );
  return (
    <View style={styles.cell} testID={testID}>
      {onSelect ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${state}: ${item.title}`}
          onPress={onSelect}
          testID={selectionTestID}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      <View style={styles.footer}>
        {item.cornerId ? (
          <Button
            label="Corner →"
            accessibilityLabel="Corner →"
            variant="primary"
            accessibilityRole="link"
            onPress={() => onOpenCorner(item.cornerId!)}
            testID={cornerActionTestID}
          />
        ) : null}
        {item.url ? (
          <Button
            label="View ↗"
            accessibilityLabel="View ↗"
            variant={item.cornerId ? 'quiet' : 'primary'}
            accessibilityRole="link"
            onPress={() => onOpenUrl(item.url!)}
            testID={urlActionTestID}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(({ buzz }) => ({
  cell: { borderTopWidth: 1, borderTopColor: buzz.border },
  body: {
    minWidth: 0,
    flexDirection: 'row',
    paddingVertical: buzz.transcriptCard.rowVertical,
    paddingHorizontal: buzz.transcriptCard.side,
    gap: buzz.space.sm,
  },
  stateSlot: { width: buzz.transcriptCard.rowStateWidth },
  state: { ...buzz.type.sectionHead, fontFamily: buzz.monoRegular, color: buzz.ledgerQuiet },
  copy: { flex: 1, minWidth: 0 },
  title: {
    ...buzz.type.bodyStrong,
    color: buzz.textPrimary,
    minWidth: 0,
    marginBottom: buzz.space.xs,
  },
  objective: { ...buzz.type.body, color: buzz.textSecondary, marginTop: buzz.space.sm },
  kindLine: { ...buzz.type.machine, color: buzz.ledgerGhost, marginTop: buzz.space.xs },
  author: { ...buzz.type.machine, color: buzz.ledgerQuiet, marginTop: buzz.space.sm },
  footer: {
    minHeight: buzz.transcriptCard.footerMinHeight,
    paddingVertical: buzz.transcriptCard.footerVertical,
    paddingHorizontal: buzz.transcriptCard.side,
    borderTopWidth: 1,
    borderTopColor: buzz.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: buzz.space.sm,
    justifyContent: 'flex-end',
  },
}));
