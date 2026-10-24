import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { lifecycleSummary, type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { InlineRow, TranscriptNavigationRow } from './IndexRow';
import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { CornerBranchGlyph } from './CornerBranchGlyph';

interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
  testID?: string;
  cornerId?: string;
  /** Hang corner rows beneath their source message. */
  anchored?: boolean;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}
/** One collapsed steps-style row; expansion preserves every posted event. */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
  testID,
  cornerId,
  anchored = false,
  onOpenCorner,
  onOpenUrl,
}: NotificationLifecycleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const items = message.notificationLifecycleRun!.items.map((item) => ({
    ...item,
    cornerId:
      item.cornerId ??
      (item.kind === 'pull-request' || item.kind === 'check' ? cornerId : undefined),
  }));
  const summary = lifecycleSummary(items);
  return (
    <LedgerLogGroup
      testID={testID ?? `notification-run-${message.id}`}>
      {items.length > 1 ? <LedgerDisclosure expanded={expanded}
        onPress={() => { if (expanded) setShowAll(false); setExpanded(value => !value); }} accessibilityLabel={summary}
        accessibilityState={{ expanded }} rowTestID={`notification-run-expand-${message.id}`}>
        {summary.split(' · ').map((part, index) => <Text key={index} style={/fail/i.test(part) ? styles.failed : undefined}>
          {index ? ' · ' : ''}{part}
        </Text>)}
      </LedgerDisclosure> : null}
      {items.length === 1 || expanded ? <>
        {(showAll || items.length <= 3 ? items : items.slice(0, 2)).map((item, index) => (
          <RepositoryLifecycleRow key={item.id} item={item} glyph={anchored} divider={index > 0}
            testID={anchored ? `corner-opened-marker-${item.cornerId}` : undefined}
            onOpenCorner={onOpenCorner} onOpenUrl={onOpenUrl} />
        ))}
        {!showAll && items.length > 3 ? <LedgerDisclosure expanded={false} accessibilityState={{ expanded: false }}
          accessibilityLabel={`${items.length - 2} more events`} onPress={() => setShowAll(true)}
          rowTestID={`notification-run-more-${message.id}`}>{items.length - 2} more</LedgerDisclosure> : null}
      </> : null}
    </LedgerLogGroup>
  );
});
type RepositoryItem = NotificationLifecycleRun['items'][number];
export function isRepositoryLifecycleItem(item: RepositoryItem) {
  return (
    ['pull-request', 'issue', 'corner'].includes(item.kind) && !item.state.startsWith('Checks ')
  );
}

/**
 * GitHub and corner destinations are separate; the title keeps the remaining width.
 * `glyph` draws the same row as the call-site line under the message a corner
 * was opened from: the branch mark leads it and it hangs off that message
 * without a rule.
 */
export function RepositoryLifecycleRow({
  item,
  glyph = false,
  divider = false,
  testID,
  onOpenCorner,
  onOpenUrl,
}: {
  item: RepositoryItem;
  glyph?: boolean;
  divider?: boolean;
  /** Replaces the corner target's test id. */
  testID?: string;
  onOpenCorner(id: string): void;
  onOpenUrl(url: string): void;
}) {
  const state = item.state.replace(/^(PR|Checks) /, '');
  const verb = state.charAt(0).toUpperCase() + state.slice(1);
  const number =
    item.url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1] ?? item.kindLine.match(/#(\d+)/)?.[1];
  const cornerTestID = testID ?? `notification-run-cell-corner-${item.id}`;
  if (item.kind === 'corner' && isRepositoryLifecycleItem(item)) {
    return (
      <TranscriptNavigationRow
        testID={`notification-run-cell-${item.id}`}
        divider={divider}
        singleDestination
        leading={<CornerBranchGlyph />}
        trailing={
          item.cornerId
            ? {
                accessibilityLabel: `Open corner ${item.title}`,
                onPress: () => onOpenCorner(item.cornerId!),
                testID: cornerTestID,
              }
            : undefined
        }
      >
        <InlineRow style={styles.cornerCopy}>
          <Text style={[styles.repositoryTitle, styles.cornerName]} numberOfLines={1} ellipsizeMode="tail">
            <Text style={[styles.verb, /fail/i.test(state) && styles.failed]}>{verb} </Text>
            {item.title}
            {state === 'Merged' && number && item.url ? ' ' : null}
          </Text>
          {state === 'Merged' && number && item.url ? (
            <Text
              style={[styles.number, styles.cornerNumber]}
              numberOfLines={1}
              accessibilityRole="link"
              accessibilityLabel={`Open PR ${number}`}
              testID={`notification-run-cell-url-${item.id}`}
              onPress={(event) => {
                event.stopPropagation();
                onOpenUrl(item.url!);
              }}
            >{`PR ${number}`}</Text>
          ) : null}
        </InlineRow>
      </TranscriptNavigationRow>
    );
  }
  const copy = (
    <Text style={styles.repositoryTitle} numberOfLines={2} ellipsizeMode="tail">
      <Text style={[styles.verb, /fail/i.test(state) && styles.failed]}>{verb} </Text>
      {number && item.url ? <><Text style={styles.number}>#{number}</Text>{' '}</> : null}
      {item.title}
    </Text>
  );
  return (
    <TranscriptNavigationRow
      testID={`notification-run-cell-${item.id}`}
        divider={divider}
      leading={glyph ? <CornerBranchGlyph /> : undefined}
      singleDestination={!isRepositoryLifecycleItem(item) && !item.cornerId}
      primary={
        item.url && (isRepositoryLifecycleItem(item) || item.cornerId)
          ? {
              accessibilityLabel: `Open ${item.kindLine}`,
              onPress: () => onOpenUrl(item.url!),
              testID: `notification-run-cell-url-${item.id}`,
            }
          : undefined
      }
      trailing={
        item.cornerId
          ? {
              accessibilityLabel: `Open corner ${item.title}`,
              onPress: () => onOpenCorner(item.cornerId!),
              testID: cornerTestID,
            }
          : !isRepositoryLifecycleItem(item) && item.url
            ? { accessibilityLabel: `Open ${item.kindLine}`, onPress: () => onOpenUrl(item.url!), testID: `notification-run-cell-url-${item.id}` }
            : undefined
      }
    >
      {copy}
    </TranscriptNavigationRow>
  );
}

const styles = StyleSheet.create(({ buzz }) => ({
  failed: { color: buzz.accent },
  cornerCopy: { flexDirection: 'row', alignItems: 'baseline' },
  cornerName: { flexShrink: 1, minWidth: 0 },
  cornerNumber: { flexShrink: 0, marginLeft: buzz.space.xs },
  repositoryTitle: { ...buzz.type.body, color: buzz.textSecondary },
  verb: { ...buzz.type.body, fontFamily: buzz.proseMedium, color: buzz.textPrimary },
  number: {
    ...buzz.type.body,
    fontFamily: buzz.proseMedium,
    color: buzz.accent,
    textDecorationLine: 'underline',
  },
}));
