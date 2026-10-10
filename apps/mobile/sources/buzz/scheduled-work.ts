import { useCallback, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import type { RoomScheduleView, RoomSubscriptionView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
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

/** Line 1 of a schedule row: what it runs · when it runs. */
export function scheduleTitle(schedule: RoomScheduleView): string {
  const what = schedule.workflowSlug
    ? `${schedule.workflowSlug} workflow`
    : promptLead(schedule.message);
  return `${what} · ${scheduleCadenceLabel(schedule.cadence)}`;
}

/** The detail page's Runs row: the cadence and the next firing. */
export function scheduleRuns(schedule: RoomScheduleView): string {
  return `${scheduleCadenceLabel(schedule.cadence)} · next ${NEXT_RUN.format(
    new Date(schedule.nextRunAt * 1_000),
  )}`;
}

export function subscriptionTitle(subscription: RoomSubscriptionView): string {
  if (subscription.source === 'repository') {
    const repository = subscription.repository ?? 'this repository';
    const action: Record<string, string> = {
      'issue.opened': `New issue in ${repository}`,
      'issue.closed': `Issue closes in ${repository}`,
      'issue.reopened': `Issue reopens in ${repository}`,
      'pull_request.opened': `New pull request in ${repository}`,
      'pull_request.closed': `Pull request closes in ${repository}`,
      'pull_request.reopened': `Pull request reopens in ${repository}`,
      'star.created': `Someone stars ${repository}`,
      'star.deleted': `Someone removes a star from ${repository}`,
    };
    return action[subscription.event] ?? `An event arrives in ${repository}`;
  }
  const action: Record<string, string> = {
    joined: 'Someone joins this Room',
    'schedule-ran': 'A schedule runs in this Room',
    'corner-opened': 'A corner opens in this Room',
    'check-passed': 'Corner checks pass',
    'check-failed': 'Corner checks fail',
    merged: 'A corner merges',
    'workflow-handoff': 'A workflow moves to its next step',
  };
  return action[subscription.event] ?? 'An event arrives in this Room';
}

export function subscriptionWhere(subscription: RoomSubscriptionView): string {
  return subscription.corner ? `#${subscription.corner.name}` : 'this Room';
}

export function subscriptionRuns(subscription: RoomSubscriptionView): string {
  if (subscription.source === 'repository') {
    const repository = subscription.repository ?? 'this repository';
    const when: Record<string, string> = {
      'issue.opened': `Each time a new issue opens in ${repository}`,
      'issue.closed': `Each time an issue closes in ${repository}`,
      'issue.reopened': `Each time an issue reopens in ${repository}`,
      'pull_request.opened': `Each time a new pull request opens in ${repository}`,
      'pull_request.closed': `Each time a pull request closes in ${repository}`,
      'pull_request.reopened': `Each time a pull request reopens in ${repository}`,
      'star.created': `Each time someone stars ${repository}`,
      'star.deleted': `Each time someone removes a star from ${repository}`,
    };
    return when[subscription.event] ?? `Each time an event arrives in ${repository}`;
  }
  const when: Record<string, string> = {
    joined: 'Each time someone joins this Room',
    'schedule-ran': 'Each time a schedule runs in this Room',
    'corner-opened': 'Each time a corner opens in this Room',
    'check-passed': 'Each time corner checks pass',
    'check-failed': 'Each time corner checks fail',
    merged: 'Each time a corner merges',
    'workflow-handoff': 'Each time a workflow moves to its next step',
  };
  return when[subscription.event] ?? 'Each time an event arrives in this Room';
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
