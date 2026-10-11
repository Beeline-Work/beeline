import { useCallback, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import type { RoomScheduleView, RoomSubscriptionView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';


const NEXT_RUN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** The longest a prompt's first sentence runs on a list row before it ellipsizes. */
const PROMPT_LEAD = 48;

/**
 * A prompt's first sentence, cut to fit a list row, so the row can still say
 * when it runs after it.
 */
export function promptLead(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  const bare = sentence.replace(/[.!?]$/, '');
  if (bare.length > PROMPT_LEAD) return `${bare.slice(0, PROMPT_LEAD - 1).trimEnd()}…`;
  return bare.length < text.replace(/[.!?]$/, '').length ? `${bare}…` : bare;
}

/** `#corner` for a schedule in a child corner, otherwise this Room. */
export function scheduleWhere(schedule: Pick<RoomScheduleView, 'corner'>): string {
  return schedule.corner ? `#${schedule.corner.name}` : 'this Room';
}

/** Line 1 of a schedule row: what it runs, ellipsized by the row if needed. */
export function scheduleTitle(schedule: RoomScheduleView): string {
  return schedule.workflowSlug
    ? workflowDisplayName(schedule.workflowSlug)
    : promptLead(schedule.message);
}

/** The detail page's Runs row: the cadence and the next firing. */
export function scheduleRuns(schedule: RoomScheduleView): string {
  return `${scheduleCadenceLabel(schedule.cadence)} · next ${NEXT_RUN.format(
    new Date(schedule.nextRunAt * 1_000),
  )}`;
}

export function subscriptionTitle(subscription: RoomSubscriptionView): string {
  return subscription.workflowSlug
    ? workflowDisplayName(subscription.workflowSlug)
    : promptLead(subscription.prompt ?? 'React to this event');
}

export function subscriptionWhen(subscription: RoomSubscriptionView): string {
  if (subscription.source === 'repository') {
    const repository = subscription.repository ?? 'this repository';
    const action: Record<string, string> = {
      'issue.opened': `new issue in ${repository}`,
      'issue.closed': `issue closing in ${repository}`,
      'issue.reopened': `issue reopening in ${repository}`,
      'pull_request.opened': `new pull request in ${repository}`,
      'pull_request.closed': `pull request closing in ${repository}`,
      'pull_request.reopened': `pull request reopening in ${repository}`,
      'star.created': `someone starring ${repository}`,
      'star.deleted': `someone removing a star from ${repository}`,
    };
    return `On ${action[subscription.event] ?? `an event in ${repository}`}`;
  }
  const action: Record<string, string> = {
    joined: 'someone joining this Room',
    'schedule-ran': 'a schedule running in this Room',
    'corner-opened': 'a corner opening in this Room',
    'check-passed': 'corner checks passing',
    'check-failed': 'corner checks failing',
    merged: 'a corner merging',
    'workflow-handoff': 'a workflow moving to its next step',
  };
  return `On ${action[subscription.event] ?? 'an event in this Room'}`;
}

export function subscriptionWhere(subscription: RoomSubscriptionView): string {
  return subscription.corner ? `#${subscription.corner.name}` : 'this Room';
}

export function subscriptionRuns(subscription: RoomSubscriptionView): string {
  return subscriptionWhen(subscription);
}

export type ScheduledWork = {
  roomName: string | null;
  agentNames: ReadonlyMap<string, string>;
  schedules: readonly RoomScheduleView[];
  subscriptions: readonly RoomSubscriptionView[];
};

/**
 * One read of a Room's schedules and subscriptions, with the Room's name and
 * agent names, for the Schedules and subscriptions list and each entry's page.
 * Room managers only; reloads when the page regains focus.
 */
export function useScheduledWork(roomId: string | undefined) {
  const [work, setWork] = useState<ScheduledWork | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId) {
      setError('Schedules target is missing.');
      setLoading(false);
      return;
    }
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) {
        router.replace('/beeline/onboarding' as Href);
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const room = await new RoomViewClient({ baseUrl: relayUrl, identity }).room(roomId);
      if (!room.viewer.permissions.manage) throw new Error('Room manager required');
      const [listed, subscribed] = await Promise.all([
        monolithPhoneOperation('listRoomSchedules', { roomId }),
        monolithPhoneOperation('listRoomSubscriptions', { roomId }),
      ]);
      setWork({
        roomName: room.room.name,
        agentNames: new Map(
          room.members
            .filter((member) => member.identity.kind === 'agent')
            .map((member) => [member.identity.pubkey, member.identity.name] as const),
        ),
        schedules: listed.schedules,
        subscriptions: subscribed.subscriptions,
      });
      setError(null);
    } catch (caught) {
      setError(`Could not load schedules and subscriptions: ${String(caught)}`);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void reload();
    }, [reload]),
  );

  const retry = useCallback(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { work, setWork, loading, error, setError, retry };
}

export async function stopSchedule(roomId: string, scheduleId: string): Promise<void> {
  await monolithPhoneOperation('deleteRoomSchedule', { roomId, scheduleId });
}

export async function stopSubscription(roomId: string, subscriptionId: string): Promise<void> {
  await monolithPhoneOperation('deleteRoomSubscription', { roomId, subscriptionId });
}
