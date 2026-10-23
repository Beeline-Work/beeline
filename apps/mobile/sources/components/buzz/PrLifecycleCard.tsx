import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { lifecycleSummary, type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { TranscriptNavigationRow } from './IndexRow';
import { LedgerDisclosure } from './LedgerDisclosure';
import { ChevronGlyph, CHEVRON_ROW_SIZE } from './ChevronGlyph';
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
  const { theme } = useUnistyles();
  const items = message.notificationLifecycleRun!.items.map((item) => ({
    ...item,
    cornerId:
      item.cornerId ??
      (item.kind === 'pull-request' || item.kind === 'check' ? cornerId : undefined),
  }));
  const summary = lifecycleSummary(items);
  const repositoryRun = items.every(isRepositoryLifecycleItem);
  if (repositoryRun)
    return (
      <View style={!anchored && items.length === 1 && items[0].kind === 'issue' ? styles.issueRun : undefined} testID={testID ?? `notification-run-${message.id}`}>
        {items.length > 1 ? (
          <Pressable
            style={styles.header}
            accessibilityRole="button"
            accessibilityLabel={summary}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((value) => !value)}
            testID={`notification-run-expand-${message.id}`}
          >
            <ChevronGlyph
              direction={expanded ? 'down' : 'right'}
              size={CHEVRON_ROW_SIZE}
              color={theme.buzz.textMuted}
            />
            <Text style={styles.summary}>{summary}</Text>
          </Pressable>
        ) : null}
        {items.length === 1 || expanded ? (
          <>
            {(showAll || items.length <= 3 ? items : items.slice(0, 2)).map((item) => (
              <RepositoryLifecycleRow
                key={item.id}
                item={item}
                glyph={anchored}
                testID={anchored ? `corner-opened-marker-${item.cornerId}` : undefined}
                onOpenCorner={onOpenCorner}
                onOpenUrl={onOpenUrl}
              />
            ))}
            {!showAll && items.length > 3 ? (
              <Pressable
                style={styles.more}
                accessibilityRole="button"
                onPress={() => setShowAll(true)}
                testID={`notification-run-more-${message.id}`}
              >
                <Text style={styles.moreText}>{items.length - 2} more</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </View>
    );
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
          {items.map((item) =>
            isRepositoryLifecycleItem(item) ? (
              <RepositoryLifecycleRow
                key={item.id}
                item={item}
                onOpenCorner={onOpenCorner}
                onOpenUrl={onOpenUrl}
              />
            ) : (
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
            ),
          )}
        </View>
      ) : null}
    </View>
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
  testID,
  onOpenCorner,
  onOpenUrl,
}: {
  item: RepositoryItem;
  glyph?: boolean;
  /** Replaces the corner target's test id. */
  testID?: string;
  onOpenCorner(id: string): void;
  onOpenUrl(url: string): void;
}) {
  const state = item.state.replace(/^PR /, '');
  // The call-site line keeps its own closed wording in the shared format.
  const closedCallSite = glyph && state === 'Closed';
  const verb = closedCallSite ? 'Corner closed' : state.charAt(0).toUpperCase() + state.slice(1);
  const number =
    item.url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1] ?? item.kindLine.match(/#(\d+)/)?.[1];
  const copy = (
    <Text style={styles.repositoryTitle} numberOfLines={2} ellipsizeMode="tail">
      <Text style={styles.verb}>{verb} </Text>
      {number && item.url ? <Text style={styles.number}>#{number} </Text> : null}
      {closedCallSite
        ? `· #${item.title}`
        : item.kind === 'corner'
          ? `corner #${item.title}`
          : item.title}
    </Text>
  );
  const cornerTestID = testID ?? `notification-run-cell-corner-${item.id}`;
  return (
    <TranscriptNavigationRow
      testID={`notification-run-cell-${item.id}`}
      singleDestination={item.kind === 'corner' && Boolean(item.cornerId) && !item.url}
      leading={glyph ? <CornerBranchGlyph /> : undefined}
      primary={
        item.url
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
          : undefined
      }
    >
      {copy}
    </TranscriptNavigationRow>
  );
}

const styles = StyleSheet.create(({ buzz }) => ({
  issueRun: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: buzz.borderStrong },
  header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: buzz.space.sm },
  summary: { ...buzz.type.meta, color: buzz.textSecondary, flex: 1 },
  repositoryTitle: { ...buzz.type.body, color: buzz.textSecondary },
  verb: { ...buzz.type.body, fontFamily: buzz.proseMedium, color: buzz.textPrimary },
  number: {
    ...buzz.type.body,
    fontFamily: buzz.proseMedium,
    color: buzz.accent,
    textDecorationLine: 'underline',
  },
  more: {
    minHeight: 44,
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: buzz.border,
  },
  moreText: { ...buzz.type.meta, color: buzz.ledgerQuiet },
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
