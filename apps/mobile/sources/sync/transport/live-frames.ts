import type { NostrEvent } from '@beeline/nostr';
import type { MonolithSurfaceEvent } from './monolith-rig-transport';

/** Draft, thought, and retract frames move live overlay text only; no read surface changes. */
export function isDraftFrame(event: NostrEvent | MonolithSurfaceEvent): boolean {
  if (!('monolithLive' in event)) return false;
  const type = event.monolithLive.type;
  return type === 'draft' || type === 'thought' || type === 'retract';
}

/** A child corner's list status changed. Only a corner list re-reads for it. */
export function isCornerStatusFrame(event: NostrEvent | MonolithSurfaceEvent): boolean {
  if (!('monolithLive' in event)) return false;
  const live = event.monolithLive;
  return live.type === 'invalidate' && live.reason === 'corner-status';
}
