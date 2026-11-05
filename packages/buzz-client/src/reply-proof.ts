/**
 * Reply authority returned by the authenticated Room indexer for a durable
 * message. Tail and history rows use the same proof, so the publisher never
 * reconstructs ancestry from relay events.
 */
/** @public The isolated phone dependency tree consumes this client contract. */
export type KnownMessageReference = {
  readonly channelId: string;
  readonly eventId: string;
  readonly rootId: string;
};
