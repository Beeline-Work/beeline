import type { NostrEvent } from '@beeline/nostr';
import type { MonolithSurfaceEvent } from './monolith-rig-transport';

/** Draft, thought, and retract frames move live overlay text only; no read surface changes. */
export function isDraftFrame(event: NostrEvent | MonolithSurfaceEvent): boolean {
  if (!('monolithLive' in event)) return false;
  const type = event.monolithLive.type;
  return type === 'draft' || type === 'thought' || type === 'retract';
}
