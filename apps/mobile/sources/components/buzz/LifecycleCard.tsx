import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import React, { type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RepositoryLifecycleRow, isRepositoryLifecycleItem } from './PrLifecycleCard';
import { LifecycleRow } from './LifecycleRow';
import { lifecycleCornerTitle, type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { ledgerStamp } from '@/buzz/relative-time';

export function lifecycleDisplayState(state: string) {
  return state
    .replace(/^PR /, '')
    .replace(/^Checks /, '')
    .toLowerCase();
}

export function lifecycleHeadline(
  items: readonly (Omit<NotificationLifecycleRun['items'][number], 'state'> & { state: string })[],
) {
  const kinds = new Set(
    items.map((item) =>
      item.kind === 'corner'
        ? item.kindLine.includes('PR #') || Boolean(item.url?.match(/\/pull\/\d+/))
          ? 'PR'
          : 'Corner'
        : item.kind === 'pull-request'
          ? 'PR'
          : item.kind === 'issue'
            ? 'Issue'
            : 'Check',
    ),
  );
  const counts = new Map<string, number>();
  for (const item of items) {
    const state = lifecycleDisplayState(item.state);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return `${kinds.size === 1 ? [...kinds][0] : 'Activity'} · ${[...counts]
    .sort()
    .map(([state, count]) => `${count} ${state}`)
    .join(', ')}`;
}

/** Standalone adapters use the same shell and row as grouped runs. */
export function LifecycleRecordCard({
  item,
  timestamp,
  testID,
  objective,
  authorPrefix,
  onOpenCorner,
  onOpenUrl,
}: {
  item: Omit<NotificationLifecycleRun['items'][number], 'state'> & { state: string };
  timestamp: number;
  testID: string;
  objective?: string;
  authorPrefix?: string;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}) {
  const { theme } = useUnistyles();
  if (isRepositoryLifecycleItem(item))
    return (
      <View testID={testID}>
        <RepositoryLifecycleRow item={item} onOpenCorner={onOpenCorner} onOpenUrl={onOpenUrl} />
      </View>
    );
  const state = lifecycleDisplayState(item.state);
  const color = state.includes('failed')
    ? theme.buzz.diffRemoved
    : ['opened', 'running'].includes(state)
      ? theme.buzz.accent
      : theme.buzz.ledgerQuiet;
  return (
    <LifecycleCard title={lifecycleHeadline([item])} stamp={ledgerStamp(timestamp)} testID={testID}>
      <LifecycleRow
        item={item}
        state={state}
        objective={objective}
        authorPrefix={authorPrefix}
        stateColor={{ color }}
        titleColor={{ color: theme.buzz.textPrimary }}
        testID={`notification-run-cell-${item.id}`}
        cornerActionTestID={`${testID}-primary-action`}
        urlActionTestID={`${testID}-${item.cornerId ? 'secondary' : 'primary'}-action`}
        onOpenCorner={onOpenCorner}
        onOpenUrl={onOpenUrl}
      />
    </LifecycleCard>
  );
}

/** Frame and header shared by standalone and grouped repository lifecycle records. */
export function LifecycleCard({
  title,
  stamp,
  testID,
  headerTestID,
  children,
}: {
  title: string;
  stamp: string;
  testID: string;
  headerTestID?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.shell} testID={testID}>
      <View style={styles.frame}>
        <View style={styles.head} testID={headerTestID}>
          <Text style={styles.title} testID={`${testID}-title`}>
            {title}
          </Text>
          <Text style={styles.stamp}>{stamp}</Text>
        </View>
        {children}
      </View>
    </View>
  );
}
const styles = StyleSheet.create(({ buzz }) => ({
  shell: {
    minWidth: 0,
    marginTop: buzz.transcriptCard.marginTop - buzz.space.md,
    marginRight: -buzz.space.md,
    marginBottom: buzz.transcriptCard.marginBottom - buzz.space.md,
    marginLeft: -buzz.space.md,
    padding: buzz.space.md,
  },
  frame: {
    minWidth: 0,
    borderWidth: 1,
    borderColor: buzz.borderStrong,
    borderRadius: buzz.transcriptCard.cornerRadius,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: buzz.space.sm,
    paddingVertical: buzz.space.sm,
    paddingHorizontal: buzz.transcriptCard.side,
  },
  title: { ...buzz.type.bodyStrong, color: buzz.textPrimary, flex: 1, minWidth: 0 },
  stamp: { ...buzz.type.machine, color: buzz.ledgerQuiet, fontVariant: ['tabular-nums'] },
}));

export interface GitHubEventCardProps {
  message: ChatDisplayMessage;
  onOpenCorner?(cornerId: string): void;
  onOpenUrl(url: string): void;
}

export const GitHubEventCard = React.memo(function GitHubEventCard({
  message,
  onOpenUrl,
  onOpenCorner,
}: GitHubEventCardProps) {
  const event = message.githubEvent!;
  // Only the kinds this build knows how to draw. A card from a newer server
  // renders nothing rather than taking the Room down with it.
  const SUBJECTS: Record<string, string> = { 'pull-request': 'PR', issue: 'Issue' };
  const subject = SUBJECTS[event.type];
  if (!subject) return null;
  const number = event.url.match(/\/(?:pull|issues)\/(\d+)/)?.[1];
  return (
    <LifecycleRecordCard
      item={{
        id: message.id,
        title: event.title,
        state: event.type === 'issue' && event.action === 'opened' ? 'Filed' : event.action,
        kind: event.type === 'issue' ? 'issue' : 'pull-request',
        kindLine: `${subject}${number ? ` #${number}` : ''}`,
        actor: event.actor,
        url: event.url,
        ...(onOpenCorner && event.cornerId ? { cornerId: event.cornerId } : {}),
        updatedBy: message.id,
      }}
      timestamp={message.timestamp}
      testID={`github-event-card-${event.type}-${event.action}`}
      onOpenCorner={onOpenCorner ?? (() => undefined)}
      onOpenUrl={onOpenUrl}
    />
  );
});

export interface DaemonFactCardProps {
  message: ChatDisplayMessage;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}

export const DaemonFactCard = React.memo(function DaemonFactCard({
  message,
  onOpenCorner,
  onOpenUrl,
}: DaemonFactCardProps) {
  const fact = message.daemonFact!;
  const agent =
    message.authorIdentity?.kind === 'agent'
      ? (message.authorIdentity.handle ?? message.authorIdentity.name).replace(/^@/, '')
      : undefined;
  const landedCorner = fact.type === 'corner-complete' && fact.outcome === 'landed';
  // The NAME titles the card; the objective is its body.
  const title = landedCorner
    ? fact.pullRequest?.title || lifecycleCornerTitle(fact)
    : lifecycleCornerTitle(fact);
  const prNumber = fact.pullRequest?.number;
  const state =
    fact.type === 'corner-open'
      ? 'Opened'
      : fact.type === 'checks-failing'
        ? 'Checks failed'
        : landedCorner
          ? 'Merged'
          : 'Closed';
  return (
    <LifecycleRecordCard
      item={{
        id: message.id,
        title,
        state,
        kind: 'corner',
        kindLine: `corner${prNumber ? ` · PR #${prNumber}` : ''}`,
        cornerId: fact.cornerId,
        url: fact.pullRequest?.url,
        actor: agent ?? '',
        updatedBy: message.id,
      }}
      timestamp={message.timestamp}
      objective={fact.type === 'corner-open' ? fact.objective : undefined}
      authorPrefix={fact.type === 'corner-open' ? 'corner · opened by ' : undefined}
      testID={
        fact.type === 'corner-complete' && (landedCorner || fact.pullRequest)
          ? 'corner-summary-card'
          : `daemon-fact-card-${fact.type}`
      }
      onOpenCorner={onOpenCorner}
      onOpenUrl={onOpenUrl}
    />
  );
});
