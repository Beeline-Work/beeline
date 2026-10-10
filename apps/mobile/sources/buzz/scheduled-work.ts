import { useCallback, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import {
  cornerTitle,
  type RoomScheduleView,
  type RoomWebhooksResult,
} from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

export type RoomWebhookView = RoomWebhooksResult['sources'][number];

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
  return schedule.corner
    ? cornerTitle(undefined, schedule.corner.name, schedule.corner.id)
    : 'this Room';
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

export function handles(names: readonly string[]): string {
  return names.length ? names.map((name) => `@${name}`).join(', ') : 'No agent subscribed';
}

/** Line 1 of a webhook row: what it runs · when it runs. */
export function webhookTitle(hook: RoomWebhookView): string {
  return `${hook.source} event payload · ${webhookCadence(hook)}`;
}

export function webhookCadence(hook: RoomWebhookView): string {
  return `On each ${hook.source} delivery`;
}

export function webhookRuns(hook: RoomWebhookView): string {
  return hook.signed ? `${webhookCadence(hook)} · signed` : webhookCadence(hook);
}

/** What makes the webhook fire: Beeline stores only its source and signing. */
export function webhookTrigger(hook: RoomWebhookView): string {
  return [
    `Fires when ${hook.source} sends a request to this webhook's URL.`,
    "The sender's own webhook settings choose which events it sends.",
    hook.signed
      ? 'Only requests signed with the shared secret are accepted.'
      : 'Any request to the URL is accepted.',
  ].join(' ');
}

export function webhookPayload(hook: RoomWebhookView): string {
  if (!hook.agents.length) return 'No agent is subscribed, so a delivery wakes nobody.';
  const names = hook.agents.map((name) => `@${name}`);
  const who =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Each delivery wakes ${who} with the event payload.`;
}

export type ScheduledWork = {
  roomName: string | null;
  agentNames: ReadonlyMap<string, string>;
  schedules: readonly RoomScheduleView[];
  webhooks: readonly RoomWebhookView[];
};

/**
 * One read of a Room's schedules and live webhooks, with the Room's name and
 * agent names, for the Schedules and Webhooks list and each entry's page.
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
      const [listed, hooks] = await Promise.all([
        monolithPhoneOperation('listRoomSchedules', { roomId }),
        monolithPhoneOperation('readRoomWebhooks', { roomId }),
      ]);
      setWork({
        roomName: room.room.name,
        agentNames: new Map(
          room.members
            .filter((member) => member.identity.kind === 'agent')
            .map((member) => [member.identity.pubkey, member.identity.name] as const),
        ),
        schedules: listed.schedules,
        webhooks: hooks.sources.filter((hook) => !hook.revoked),
      });
      setError(null);
    } catch (caught) {
      setError(`Could not load schedules and webhooks: ${String(caught)}`);
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

export async function stopWebhook(roomId: string, webhookId: string): Promise<void> {
  await monolithPhoneOperation('manageRoomWebhook', { roomId, action: 'revoke', webhookId });
}
