import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { lifecycleSummary } from '@/buzz/pr-lifecycle';
import { LedgerDisclosure } from './LedgerDisclosure';

interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
  testID?: string;
  cornerId?: string;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}
/** One collapsed steps-style row; expansion preserves every posted event. */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
  testID,
  cornerId,
  onOpenCorner,
  onOpenUrl,
}: NotificationLifecycleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const items = message.notificationLifecycleRun!.items.map((item) => ({
    ...item,
    cornerId:
      item.cornerId ??
      (item.kind === 'pull-request' || item.kind === 'check' ? cornerId : undefined),
  }));
  const summary = lifecycleSummary(items);
  return (
    <View testID={testID ?? `notification-run-${message.id}`}>
      <LedgerDisclosure
        expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        accessibilityLabel={summary}
        accessibilityState={{ expanded }}
        rowTestID={`notification-run-expand-${message.id}`}
      >
        {summary}
      </LedgerDisclosure>
      {expanded ? (
        <View style={styles.list}>
          {items.map((item) => (
            <View key={item.id} style={styles.event} testID={`notification-run-cell-${item.id}`}>
              <Text style={styles.line} numberOfLines={1} ellipsizeMode="tail">
                {item.state.replace(/^(PR|Checks) /, '')} · {item.kindLine} · {item.title}
              </Text>
              {item.url ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${item.kindLine}`}
                  onPress={() => onOpenUrl(item.url!)}
                  testID={`notification-run-cell-url-${item.id}`}
                  style={styles.linkTarget}
                >
                  <Text style={styles.link}>
                    {item.kind === 'pull-request'
                      ? 'PR →'
                      : item.kind === 'issue'
                        ? 'Issue →'
                        : item.kind === 'check'
                          ? 'Check →'
                          : 'View →'}
                  </Text>
                </Pressable>
              ) : null}
              {item.cornerId ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open corner ${item.title}`}
                  onPress={() => onOpenCorner(item.cornerId!)}
                  testID={`notification-run-cell-corner-${item.id}`}
                  style={styles.linkTarget}
                >
                  <Text style={styles.link}>Corner →</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});
const styles = StyleSheet.create(({ buzz }) => ({
  list: {
    marginLeft: buzz.space.lg,
    paddingLeft: buzz.space.sm,
    borderLeftWidth: 1,
    borderLeftColor: buzz.border,
  },
  event: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: buzz.space.sm },
  line: { ...buzz.type.machine, color: buzz.ledgerQuiet, flex: 1, minWidth: 0 },
  linkTarget: { minHeight: 44, justifyContent: 'center' },
  link: { ...buzz.type.machine, color: buzz.accent },
}));
