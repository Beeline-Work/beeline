import {
  cornerStatusPrecedence,
  type CornerActivitySignal,
  type CornerStatus,
  type CornerSummary,
} from './corners';

/**
 * The two things a Room reports above its composer are *different facts about
 * different objects*, and this module exists to keep them from ever being
 * derived from one another again.
 *
 *   **A turn is in progress.** The agent is composing a reply in this Room.
 *   Wire signal: a `#t=agent-turn` `working` event published on the Room's own
 *   channel (`postAgentTurnStatus`, `apps/body/src/body.ts`). It is transient,
 *   it names no corner, and it is nothing to tap.
 *
 *   **A corner is open.** A child edit channel exists and has not landed,
 *   failed, or closed. Wire signal: the corner's own status card, published to
 *   the *parent* Room with a `subchannel` tag (`postParentCornerStatus`, plus
 *   the `status=archived` close notice), and the relay-read lifecycle list.
 *
 * The daemon has always published these as two unrelated streams. The client
 * used to fold the first into the second — so a plain question lit the pinned
 * gold corner line, pointed at whatever corner was last on record, archived or
 * not, and let the reader tap into a read-only channel. `selectPinnedCorner`
 * takes corner state and nothing else; the turn indicator takes turn state and
 * nothing else; neither can see the other's input.
 */
export type PinnedCorner = {
  cornerId: string;
  status: CornerStatus;
};

export type PinnedCornerInput = {
  /** Live corner status cards projected from this Room's transcript. */
  signals: readonly CornerActivitySignal[];
  /** The relay-read lifecycle snapshot for this Room's corners. */
  lifecycle: readonly CornerSummary[];
  /** False until `listSubchannelLifecycle` has actually answered. */
  lifecycleLoaded: boolean;
  /**
   * A corner a write-permission ALLOW just opened, which may still have no
   * status card and no lifecycle row of its own. Honoured only when *neither*
   * source knows the corner yet — an ALLOW is a durable transcript event and
   * stays readable long after the corner it opened has closed, which is
   * exactly how an archived corner used to reach the pinned line.
   */
  permittedCornerId?: string;
};

/** The most terminal status any source reports for a corner wins. A snapshot
 * fetched before the corner closed must never re-open it. */
function mostTerminal(
  left: CornerStatus | undefined,
  right: CornerStatus | undefined,
): CornerStatus | undefined {
  if (!left) return right;
  if (!right) return left;
  return cornerStatusPrecedence(right) > cornerStatusPrecedence(left) ? right : left;
}

/**
 * The one corner the pinned line may name, or `null` for none.
 *
 * The line's presence means one thing: a corner is actively working right
 * now. Only `live` qualifies — an idle-but-open corner, one waiting on a
 * human (`needs-attention`), or a terminal one are all "no line", not a
 * quiet-tier line. When several corners are live at once, the most recent
 * wins.
 */
export function selectPinnedCorner(input: PinnedCornerInput): PinnedCorner | null {
  const status = new Map<string, CornerStatus>();
  const seenAt = new Map<string, number>();

  for (const corner of input.lifecycle) {
    status.set(corner.id, mostTerminal(status.get(corner.id), corner.status)!);
    seenAt.set(corner.id, Math.max(seenAt.get(corner.id) ?? 0, corner.lastActivityAt ?? corner.createdAt ?? 0));
  }
  for (const signal of input.signals) {
    status.set(signal.subchannelId, mostTerminal(status.get(signal.subchannelId), signal.status)!);
    seenAt.set(signal.subchannelId, Math.max(seenAt.get(signal.subchannelId) ?? 0, signal.timestamp));
  }

  // A corner nobody has any record of yet is one that was permitted moments
  // ago and whose `starting` card is still in flight. Reporting it as `live`
  // is the honest reading, and it is only reachable once the lifecycle list
  // has answered — before that, "unknown" cannot be told from "archived".
  if (
    input.permittedCornerId &&
    input.lifecycleLoaded &&
    !status.has(input.permittedCornerId)
  ) {
    return { cornerId: input.permittedCornerId, status: 'live' };
  }

  const candidates = [...status.entries()]
    .filter(([, value]) => isPinnedCornerLive(value))
    .sort(
      ([leftId, left], [rightId, right]) =>
        cornerStatusPrecedence(left) - cornerStatusPrecedence(right) ||
        (seenAt.get(rightId) ?? 0) - (seenAt.get(leftId) ?? 0) ||
        leftId.localeCompare(rightId),
    );
  const best = candidates[0];
  return best ? { cornerId: best[0], status: best[1] } : null;
}

/**
 * Gold, and the breath that goes with it, mean one thing product-wide: an
 * agent is alive and working *in that corner*. `needs-attention` and `open`
 * are open corners waiting on a human, not running ones — `selectPinnedCorner`
 * never surfaces them, so this is the only test a pinned corner can ever fail.
 */
export function isPinnedCornerLive(status: CornerStatus): boolean {
  return status === 'live';
}
