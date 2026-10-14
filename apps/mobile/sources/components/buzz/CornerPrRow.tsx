import React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { Button } from './Button';

type Props = {
  item: NotificationLifecycleRun['items'][number];
  state: string;
  stateColor: React.ComponentProps<typeof Animated.Text>['style'];
  titleColor?: React.ComponentProps<typeof Animated.Text>['style'];
  testID: string;
  cornerActionTestID: string;
  urlActionTestID: string;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
};

/** The same presented PR row in a standalone card and an accordion. */
export function CornerPrRow({
  item,
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
  return (
    <View style={styles.cell} testID={testID}>
      <View style={styles.body}>
        <View style={styles.stateSlot}>
          <Animated.Text style={[styles.state, stateColor]}>{state}</Animated.Text>
        </View>
        <View style={styles.copy}>
          <Animated.Text style={[styles.title, titleColor]} numberOfLines={1} ellipsizeMode="tail">
            {item.title}
          </Animated.Text>
          <Animated.Text style={styles.kindLine}>{item.kindLine}</Animated.Text>
          {item.actor ? (
            <Animated.Text style={styles.author}>
              by{' '}
              <Animated.Text
                style={{ color: theme.buzz.accent }}
              >{`@${item.actor.replace(/^@/, '')}`}</Animated.Text>
            </Animated.Text>
          ) : null}
        </View>
      </View>
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
