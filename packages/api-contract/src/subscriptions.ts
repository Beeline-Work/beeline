/** A standing, event-driven wake for one agent in one Room. */
export type SubscriptionSource = 'room' | 'repository';
export type RoomSubscriptionView = {
  readonly id: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly source: SubscriptionSource;
  readonly event: string;
  readonly repository?: string;
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
export function isRepositorySubscriptionEvent(value: unknown): value is typeof REPOSITORY_SUBSCRIPTION_EVENTS[number] {
  return (REPOSITORY_SUBSCRIPTION_EVENTS as readonly unknown[]).includes(value);
}
