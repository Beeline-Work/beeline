import { useMemo, useState } from 'react';
import { useSurfaceFocus } from './use-surface-focus';
import {
  cornerShortTitle,
  type RoomScheduleView,
  type RoomSubscriptionView,
} from '@beeline/api-contract/phone';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import {useRoutedScheduledWork,prepareScheduledStop} from './router-scheduled-work';


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

/**
 * Spoken scope: name a child corner as such, or this Room. The corner's name
 * comes from the shared title grammar, so an empty or legacy `<room>/` name
 * reads the same as on every other surface.
 */
export function scheduleWhere(
  work: Pick<RoomScheduleView, 'corner'>,
  roomName: string | null | undefined,
  isDirectMessage = false,
): string {
  return work.corner
    ? `corner ${cornerShortTitle(roomName, work.corner.name, work.corner.id)}`
    : isDirectMessage ? 'this DM' : 'this Room';
}

/** The longest a derived schedule title runs before it stops at a word boundary. */
const SCHEDULE_TITLE_WORDS = 4;

/**
 * The first few words of a prompt, so a nameless schedule still names itself.
 * One to four words, never a whole sentence, matching the server's derivation.
 */
export function promptTitle(message: string): string {
  const words = message.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words
    .slice(0, SCHEDULE_TITLE_WORDS)
    .join(' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

/** Line 1 of a schedule row: what it runs, ellipsized by the row if needed. */
export function scheduleTitle(schedule: RoomScheduleView): string {
  const stored = schedule.title?.trim();
  // A server before this derivation sent the generic label for a nameless
  // schedule; read it as absent so the prompt or workflow names the row.
  if (stored && stored !== 'Scheduled task') return stored;
  if (schedule.workflowSlug) return workflowDisplayName(schedule.workflowSlug);
  return promptTitle(schedule.message) || 'Scheduled task';
}

export function scheduleTrigger(schedule: RoomScheduleView, now = new Date()): string {
  const next = new Date(schedule.nextRunAt * 1000);
  if (schedule.maxRuns !== 1) return scheduleCadenceLabel(schedule.cadence, next);
  const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.format(next) === date.format(now) ? 'Today'
    : date.format(next) === date.format(tomorrow) ? 'Tomorrow'
    : new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(next);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(next);
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(next).find(part => part.type === 'timeZoneName')?.value ?? '';
  return `${day} at ${time} ${zone}`.trim();
}

/** The detail page's Runs row: the cadence and the next firing. */
export function scheduleRuns(schedule: RoomScheduleView): string {
  return `${scheduleTrigger(schedule)} · next ${NEXT_RUN.format(
    new Date(schedule.nextRunAt * 1_000),
  )}`;
}

export function subscriptionTitle(subscription: RoomSubscriptionView): string {
  if (subscription.title?.trim()) return subscription.title.trim();
  return subscription.workflowSlug
    ? workflowDisplayName(subscription.workflowSlug)
    : promptLead(subscription.prompt ?? '') || 'React to this event';
}

export function subscriptionWhen(subscription: RoomSubscriptionView, isDirectMessage = false): string {
  if (subscription.registrationStatus === 'error')
    return `Setup failed · ${subscription.when ?? subscription.event}`;
  if (subscription.registrationStatus === 'registering')
    return `Setting up · ${subscription.when ?? subscription.event}`;
  if (subscription.when) return subscription.when;
  if (subscription.source === 'service' && subscription.service === 'Slack')
    return `On new message in ${subscription.channel ?? 'a Slack channel'}`;
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
  const place = isDirectMessage ? 'this DM' : 'this Room';
  const action: Record<string, string> = {
    joined: `someone joining ${place}`,
    'schedule-ran': `a schedule running in ${place}`,
    'corner-opened': `a corner opening in ${place}`,
    'check-passed': 'corner checks passing',
    'check-failed': 'corner checks failing',
    'workflow-handoff': 'a workflow moving to its next step',
  };
  return `On ${action[subscription.event] ?? `an event in ${place}`}`;
}

export function subscriptionWhere(
  subscription: RoomSubscriptionView,
  roomName: string | null | undefined,
  isDirectMessage = false,
): string {
  return scheduleWhere(subscription, roomName, isDirectMessage);
}

export function subscriptionRuns(subscription: RoomSubscriptionView, isDirectMessage = false): string {
  return subscriptionWhen(subscription, isDirectMessage);
}

export type ScheduledWork = {
  isDirectMessage: boolean;
  roomName: string | null;
  agentNames: ReadonlyMap<string, string>;
  schedules: readonly RoomScheduleView[];
  subscriptions: readonly RoomSubscriptionView[];
};

/** Observe the one router-owned Scheduled Work projection. */
export function useScheduledWork(roomId: string | undefined, _targetValid = true) {
  const focused = useSurfaceFocus();
  const routed = useRoutedScheduledWork(roomId, focused);
  const [error, setError] = useState<string | null>(null);
  const work = useMemo<ScheduledWork | null>(() => routed.value && ({
    roomName: routed.value.roomName, isDirectMessage: routed.value.isDirectMessage === true,
    agentNames: new Map(routed.value.agentNames), schedules: routed.value.schedules,
    subscriptions: routed.value.subscriptions,
  }), [routed.value]);
  return { work, routed: routed.mode === 'router', loading: routed.loading,
    error: roomId ? error ?? routed.error : 'Schedules target is missing.',
    setError, retry: () => { setError(null); routed.retry(); } };
}

/** Durable stop commands express the desired state and are idempotent on the server. */
export async function stopSchedule(roomId: string, scheduleId: string): Promise<void> {
  await prepareScheduledStop('deleteRoomSchedule', roomId, scheduleId);
}

export async function stopSubscription(roomId: string, subscriptionId: string): Promise<void> {
  await prepareScheduledStop('deleteRoomSubscription', roomId, subscriptionId);
}
