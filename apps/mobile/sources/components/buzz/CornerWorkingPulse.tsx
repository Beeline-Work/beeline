import React from 'react';
import { isPinnedCornerLive } from '@/buzz/room-indicators';
import { HullLivePulse } from './MonoHull';
import type { CornerState } from '@beeline/api-contract/phone';

/**
 * One corner-working motion vocabulary for pinned and list surfaces. Bright
 * ink at the shared pulse's 0.55 floor lands near the quiet ledger tone, so
 * the cycle visibly breathes quiet-to-ink without ever borrowing brass.
 *
 * This is all that is left of the Room's retired pinned corner line: the
 * Room-list row still breathes for a corner that is genuinely working, and
 * that breath must stay the same one everywhere it appears.
 */
export function CornerWorkingPulse({
  children,
  state,
}: {
  children: React.ReactNode;
  state: CornerState;
}) {
  return isPinnedCornerLive(state) ? <HullLivePulse>{children}</HullLivePulse> : children;
}
