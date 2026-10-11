import { quoteOutsideData } from './outside-data.js';
import type { SystemEvent } from './system-events.js';

/** A standing, event-driven wake for one agent in one Room. */
export type SubscriptionSource = 'room' | 'repository' | 'service';
export type RoomSubscriptionView = {
  readonly id: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly source: SubscriptionSource;
  readonly event: string;
  readonly repository?: string;
  readonly service?: 'Slack' | 'Linear' | 'Stripe';
  readonly channel?: string;
  /** Human-readable event grammar shared by the agent list and phone. */
  readonly when?: string;
  /** Provider hooks are installed by the agent's connected helper after creation. */
  readonly registrationStatus?: 'registering' | 'active' | 'retiring' | 'error';
  /** The action delivered on each event. Older Room subscriptions have no saved prompt. */
  readonly prompt?: string;
  readonly workflowSlug?: string;
  /** Absent for older Room event subscriptions whose earlier firings were not tracked. */
  readonly firedCount?: number;
  readonly createdAt: number;
  readonly lastFiredAt?: number;
  readonly corner?: { readonly id: string; readonly name: string };
};
export type RoomSubscriptionListResult = { readonly subscriptions: readonly RoomSubscriptionView[] };

/** These are the repository actions the installed app currently receives and dispatches. */
export const REPOSITORY_SUBSCRIPTION_EVENTS = [
  'issue.opened', 'issue.closed', 'issue.reopened',
  'pull_request.opened', 'pull_request.closed', 'pull_request.reopened',
  'star.created', 'star.deleted',
] as const;
/** Only events with a configured delivery path may appear in the agent catalog. */
export const SERVICE_SUBSCRIPTION_EVENTS = [
  { service: 'Slack', event: 'new_message', label: 'new message in a Slack channel' },
  { service: 'Linear', event: 'issue.created', label: 'new issue in Linear' },
  { service: 'Stripe', event: 'payment_intent.succeeded', label: 'payment succeeded in Stripe' },
] as const;
export type ServiceSubscriptionEvent = typeof SERVICE_SUBSCRIPTION_EVENTS[number];
export type SubscriptionEventCatalog = { readonly events: readonly ServiceSubscriptionEvent[] };
export function isRepositorySubscriptionEvent(value: unknown): value is typeof REPOSITORY_SUBSCRIPTION_EVENTS[number] {
  return (REPOSITORY_SUBSCRIPTION_EVENTS as readonly unknown[]).includes(value);
}
/** Trusted saved action followed by the outside event, visibly quoted as data. */
export function subscriptionActionPrompt(event: Pick<SystemEvent, 'subscriptionPrompt' | 'subscriptionWorkflowSlug' | 'payload'>): string {
  const action = event.subscriptionWorkflowSlug
    ? `Start the saved workflow ${event.subscriptionWorkflowSlug} in this Room with start_workflow.\n${event.subscriptionPrompt ?? ''}`.trim()
    : event.subscriptionPrompt ?? 'React to this event.';
  return `${action}\n\n${quoteOutsideData('subscription event', event.payload)}`;
}
