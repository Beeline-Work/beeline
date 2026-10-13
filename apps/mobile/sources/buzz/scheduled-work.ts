import { useCallback, useEffect, useMemo } from 'react';
import {
  cornerShortTitle,
  type RoomScheduleView,
  type RoomSubscriptionView,
  type ScheduledWorkResult,
} from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { useSharedSurface } from './use-shared-surface';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { subscribeClientReset } from '@/sync/client-reset';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';


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
): string {
  return work.corner
    ? `corner ${cornerShortTitle(roomName, work.corner.name, work.corner.id)}`
    : 'this Room';
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
  const action: Record<string, string> = {
    joined: 'someone joining this Room',
    'schedule-ran': 'a schedule running in this Room',
    'corner-opened': 'a corner opening in this Room',
    'check-passed': 'corner checks passing',
    'check-failed': 'corner checks failing',
    'workflow-handoff': 'a workflow moving to its next step',
  };
  return `On ${action[subscription.event] ?? 'an event in this Room'}`;
}

export function subscriptionWhere(
  subscription: RoomSubscriptionView,
  roomName: string | null | undefined,
): string {
  return scheduleWhere(subscription, roomName);
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

const isScheduledWork = (value: unknown): value is ScheduledWorkResult => {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<ScheduledWorkResult>;
  return (view.roomName === null || typeof view.roomName === 'string') &&
    Array.isArray(view.agentNames) && Array.isArray(view.schedules) &&
    Array.isArray(view.subscriptions);
};
const scheduledWorkAddress = (relay: string, pubkey: string, roomId: string) =>
  surfaceAddress(relay, pubkey, '/room/:id/scheduled-work', { roomId });
const watched = new Map<string, { address: SurfaceCacheAddress; stop?: () => void }>();
subscribeClientReset(() => {
  for (const entry of watched.values()) entry.stop?.();
  watched.clear();
});
function holdScheduledWork(roomId: string, address: SurfaceCacheAddress) {
  if (watched.has(roomId)) return;
  const entry: { address: SurfaceCacheAddress; stop?: () => void } = { address };
  watched.set(roomId, entry);
  // A route can unmount while its projection stays held. Keep its watch with
  // that owner, so another visit never needs a focus reconciliation.
  void sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
    if (!('monolithLive' in event)) return;
    const live = event.monolithLive;
    if (live.type === 'invalidate' &&
        ((live.roomId === roomId &&
          ['postgres:agent_schedules', 'postgres:agent_subscriptions', 'postgres:memberships'].includes(live.reason)) ||
         (live.roomId === '' && live.reason === 'reconnect')))
      void mobileSurfaceCache.fetch(address, isScheduledWork,
        () => monolithPhoneOperation('readScheduledWork', { roomId })).catch(() => undefined);
  }).then((stop) => { if (watched.get(roomId) === entry) entry.stop = stop; else stop(); },
    () => { watched.delete(roomId); });
  if (watched.size > 16) {
    const [oldRoom, oldEntry] = watched.entries().next().value!;
    watched.delete(oldRoom); oldEntry.stop?.();
  }
}

/**
 * One server projection and one registry entry shared by the list and details.
 * A held answer paints without a focus read; Room changes and reconnects reconcile it.
 */
export function useScheduledWork(roomId: string | undefined) {
  const request = useCallback(() => monolithPhoneOperation('readScheduledWork', { roomId: roomId! }), [roomId]);
  const { value, address, loading, error, setError, refresh } = useSharedSurface(
    '/room/:id/scheduled-work', roomId ? { roomId } : undefined, isScheduledWork, request, Boolean(roomId));
  useEffect(() => { if (roomId && address) holdScheduledWork(roomId, address); }, [address, roomId]);
  const work = useMemo<ScheduledWork | null>(() => value && ({
    roomName: value.roomName,
    agentNames: new Map(value.agentNames),
    schedules: value.schedules,
    subscriptions: value.subscriptions,
  }), [value]);
  return { work, loading: loading && !value, error: roomId ? error : 'Schedules target is missing.',
    setError, retry: () => { void refresh(); } };
}

export async function stopSchedule(roomId: string, scheduleId: string): Promise<void> {
  await monolithPhoneOperation('deleteRoomSchedule', { roomId, scheduleId });
  const [identity, relay] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity) return;
  const address = scheduledWorkAddress(relay, identity.publicKey, roomId);
  const current = mobileSurfaceCache.peek(address, isScheduledWork);
  if (current) await mobileSurfaceCache.write(address, {
    ...current, schedules: current.schedules.filter((item) => item.id !== scheduleId),
  }, isScheduledWork);
}

export async function stopSubscription(roomId: string, subscriptionId: string): Promise<void> {
  await monolithPhoneOperation('deleteRoomSubscription', { roomId, subscriptionId });
  const [identity, relay] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity) return;
  const address = scheduledWorkAddress(relay, identity.publicKey, roomId);
  const current = mobileSurfaceCache.peek(address, isScheduledWork);
  if (current) await mobileSurfaceCache.write(address, {
    ...current, subscriptions: current.subscriptions.filter((item) => item.id !== subscriptionId),
  }, isScheduledWork);
}
