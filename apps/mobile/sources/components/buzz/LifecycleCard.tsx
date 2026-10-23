import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import React from 'react';
import { View } from 'react-native';

import { RepositoryLifecycleRow } from './PrLifecycleCard';
import { lifecycleCornerTitle, type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';

/** Standalone adapters use the same child row as grouped runs. */
export function LifecycleRecordCard({
  item,
  testID,
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
  return (
    <View testID={testID}>
      <RepositoryLifecycleRow item={item} onOpenCorner={onOpenCorner} onOpenUrl={onOpenUrl} />
    </View>
  );
}

export interface GitHubEventCardProps {
  message: ChatDisplayMessage;
  onOpenUrl(url: string): void;
}

export const GitHubEventCard = React.memo(function GitHubEventCard({
  message,
  onOpenUrl,
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
        updatedBy: message.id,
      }}
      timestamp={message.timestamp}
      testID={`github-event-card-${event.type}-${event.action}`}
      onOpenCorner={() => undefined}
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
