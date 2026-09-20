import { resolveAgentDisplayIdentity } from './agent-display';
import { pickTurnVerb, type TurnVerb } from './turn-clock';
import type { CornerState } from '@beeline/api-contract/phone';
import type { Agent, RoomViewAgentTurn, RoomViewIdentity } from '@beeline/buzz-client';

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
 *   **A corner is open.** A non-terminal child edit channel exists. Its
 *   canonical parameterized-replaceable state decides whether it is working,
 *   waiting, or in review. Parent-Room kind:9 control history is never
 *   lifecycle authority.
 *
 * The Room no longer pins one of them above its composer — a Room holds many
 * corners, and one line could only ever name one. What is left of the corner
 * half here is the working verdict the Room-list breath reads.
 */
export type TurnProgressInput = {
  /** Corners trust their own channel-local turn proof even if Room presence is stale. */
  isCorner: boolean;
  activeTurnPubkey?: string;
  /** Server receipt time (unix seconds) the elapsed counter ticks from. */
  activeTurnStartedAt?: number;
  /** Stable per-turn identity; seeds the one-verb-per-turn pick. */
  activeTurnRequestId?: string;
  /** The agent running the turn, for the stop request's coordinates. */
  activeTurnAgentPubkey?: string;
  /** Server-reported author of the message this turn answers (`requestedBy`). */
  activeTurnRequestedBy?: string;
  /** The identity reading this Room. */
  viewerPubkey?: string;
  viewerRole?: 'owner' | 'admin' | 'member';
};

/**
 * The channel-local agent whose active turn should light the thinking line.
 *
 * The server-indexed latest WORKING receipt is the only proof, and the only
 * vetoes are the receipt's own: the 90-second freshness horizon and — applied
 * upstream, in `isAgentTurnActive` — an explicit offline marker or a different
 * daemon generation. A missing availability record is never one of them
 * (C77): a helper that claimed the message has stronger evidence in its claim
 * receipt than an unavailable presence read. Draft
 * streams are content overlays, not lifecycle: they can start late and a lost
 * retract can leave one open forever.
 */
export function selectTurnProgressAgentPubkey(input: TurnProgressInput): string | null {
  return input.activeTurnPubkey ?? null;
}

export type WorkingAgentsInput = {
  /** Every agent named by a fresh server-indexed WORKING receipt in this
   * channel. Concurrent turns are ordinary: one message can address two
   * agents, and both rings light. */
  activeTurnPubkeys?: readonly string[];
  /** This corner's administering agent, only while the corner's canonical
   * lifecycle is `working` and live (`sessionState === 'working'`). */
  workingCornerAgentPubkey?: string | null;
};

/**
 * The agents whose identity marks wear the gold ring right now, keyed by
 * pubkey. The ring means WORKING — a live turn or a live corner — and this is
 * the same proof `selectTurnProgressAgentPubkey` and the corner header read.
 * Delivery availability is deliberately not an input: a daemon can be online
 * before it has claimed work (C77), so it says nothing about whether the agent
 * is working. An empty record is the ordinary
 * result; the keys hold only agents genuinely working.
 */
export function selectWorkingAgents(input: WorkingAgentsInput): Readonly<Record<string, true>> {
  const working: Record<string, true> = {};
  for (const pubkey of input.activeTurnPubkeys ?? []) if (pubkey) working[pubkey] = true;
  if (input.workingCornerAgentPubkey) working[input.workingCornerAgentPubkey] = true;
  return working;
}

/** How long a locally-armed "buzzing" ack waits for the real WORKING receipt
 * before it must stop implying the daemon is still on its way. */
export const COMPOSER_ACK_BOUND_MS = 15_000;
/** How long a committed mid-turn steer acknowledgement remains visible. */
export const STEER_RECEIVED_VISIBLE_MS = 6_000;

export type ComposerAckState = { kind: 'thinking'; agentPubkey: string } | { kind: 'buzzing' };

export type ComposerAckInput = TurnProgressInput & {
  /** Set the instant a message addressed to an agent is sent; cleared once
   * the server accepts the write, the real receipt lands, a fresher send
   * re-arms it, or nothing addressed an agent this turn. */
  pendingAckSentAt?: number;
  now: number;
};

type AgentDisplaySource = Pick<Agent, 'pubkey' | 'displayName' | 'avatar' | 'soulProfile'>;

export type ComposerAckPresentationInput = ComposerAckInput & {
  /**
   * The server view's newest known identity for each conversation speaker.
   * This is also the source that refreshes transcript bylines, so a thinking
   * line changes with the same authenticated identity update as its message.
   */
  conversationIdentities?: ReadonlyMap<string, RoomViewIdentity>;
  /** Membership-derived detail supplies soul artwork/profile when available. */
  agentsByPubkey?: ReadonlyMap<string, AgentDisplaySource>;
  /** A human steer the server routed while this exact turn was working. */
  receivedSteer?: { agentPubkey: string; turnRequestId: string };
};

export type ComposerAckPresentation = {
  label: string;
  /** Present only when a real server receipt drives the line. */
  startedAt?: number;
  turnKey?: string;
  verb?: TurnVerb;
  /** The server committed a new human command against this running turn. */
  received?: boolean;
  /**
   * The coordinates a stop request names, present for the requester and
   * current Room owners/admins. Other members see only the working line.
   */
  stop?: { agentPubkey: string; requestId: string };
};

/** The requester and current Room owners/admins may stop a running turn. */
export function viewerMayStopTurn(
  viewerPubkey: string | undefined,
  requestedBy: string | undefined,
  viewerRole?: 'owner' | 'admin' | 'member',
): boolean {
  return Boolean(
    viewerPubkey &&
      (viewerRole === 'owner' ||
        viewerRole === 'admin' ||
        (requestedBy && viewerPubkey === requestedBy)),
  );
}

function agentFromConversationIdentity(
  identity: RoomViewIdentity | undefined,
): AgentDisplaySource | undefined {
  if (identity?.kind !== 'agent') return undefined;
  return {
    pubkey: identity.pubkey,
    displayName: identity.name,
    ...(identity.handle ? { handle: identity.handle } : {}),
    ...(identity.avatar ? { avatar: identity.avatar } : {}),
  };
}

/**
 * A locally armed acknowledgement belongs to one signed user message. The
 * server-indexed lifecycle receipt carries that message id as `requestId`, so
 * either a working or terminal receipt proves the acknowledgement is no
 * longer needed. Matching the id prevents an older agent turn from clearing a
 * newer send.
 */
export function hasComposerAckReceipt(
  requestId: string | undefined,
  latestAgentTurns: readonly RoomViewAgentTurn[],
): boolean {
  return requestId !== undefined && latestAgentTurns.some((turn) => turn.requestId === requestId);
}

/**
 * The composer's immediate answer to "did anything happen yet", in three
 * honest stages. While the send round trip is in the air there is nothing to
 * show but the local bridge (`pendingAckSentAt` → `buzzing`, "sending…").
 * Once the server accepts the write the bridge retires — the message is
 * stored, and silence is now the truth between "sent" and "claimed". When the
 * daemon CLAIMS the message it writes a WORKING receipt, which reaches the
 * phone as `activeTurnPubkey` and lights `thinking` — long before the model's
 * first token streams, which on a real host can be tens of seconds later.
 * `thinking` always wins once `selectTurnProgressAgentPubkey` has an answer;
 * past `COMPOSER_ACK_BOUND_MS` with still no receipt and no claim, the local
 * acknowledgement expires. Silence cannot prove an agent is waiting or
 * working; only the server-indexed receipt may show that.
 */
export function selectComposerAckState(input: ComposerAckInput): ComposerAckState | null {
  const activePubkey = selectTurnProgressAgentPubkey(input);
  if (activePubkey) return { kind: 'thinking', agentPubkey: activePubkey };
  if (input.pendingAckSentAt == null) return null;
  const elapsed = input.now - input.pendingAckSentAt;
  if (elapsed < 0) return null;
  return elapsed < COMPOSER_ACK_BOUND_MS ? { kind: 'buzzing' } : null;
}

/**
 * Presentation for the one composer acknowledgement. The active-turn receipt
 * provides only a pubkey, so resolve it through the current server identity
 * map before falling back to membership detail. This keeps the thinking label
 * in lockstep with Room/corner bylines without inventing a name on a miss.
 */
export function selectComposerAckPresentation(
  input: ComposerAckPresentationInput,
): ComposerAckPresentation | null {
  const state = selectComposerAckState(input);
  if (!state) return null;
  if (state.kind === 'thinking') {
    const agent =
      agentFromConversationIdentity(input.conversationIdentities?.get(state.agentPubkey)) ??
      input.agentsByPubkey?.get(state.agentPubkey);
    const subject = resolveAgentDisplayIdentity(state.agentPubkey, agent).name;
    // A real receipt carries its own identity: one verb per turn (seeded by
    // the turn key, never re-picked per tick) and the receipt's server time
    // for the elapsed counter. The local "sending…" bridge has neither.
    if (input.activeTurnRequestId) {
      const turnKey = `${state.agentPubkey}:${input.activeTurnRequestId}`;
      const verb = pickTurnVerb(turnKey);
      // A stop needs the turn's own coordinates, and only a real receipt has
      // them. The local "sending…" bridge is not a turn yet: there is nothing
      // running to stop, and offering to stop it would be a lie about what the
      // press does.
      const stoppable = viewerMayStopTurn(
        input.viewerPubkey,
        input.activeTurnRequestedBy,
        input.viewerRole,
      );
      return {
        label: `${subject} ${verb.gerund}…`,
        turnKey,
        verb,
        ...(input.receivedSteer?.agentPubkey === state.agentPubkey &&
        input.receivedSteer.turnRequestId === input.activeTurnRequestId
          ? { received: true }
          : {}),
        ...(input.activeTurnStartedAt != null ? { startedAt: input.activeTurnStartedAt } : {}),
        ...(stoppable
          ? {
              stop: {
                agentPubkey: input.activeTurnAgentPubkey ?? state.agentPubkey,
                requestId: input.activeTurnRequestId,
              },
            }
          : {}),
      };
    }
    return { label: `${subject} thinking…` };
  }
  return { label: 'sending…' };
}

/**
 * Motion means one thing product-wide: an agent is working in that corner.
 * Waiting and review show no breath.
 */
export function isPinnedCornerLive(status: CornerState): boolean {
  return status === 'working';
}

/** A corner has an approvable change waiting. */
export function isPinnedCornerReadyForReview(status: CornerState): boolean {
  return status === 'review';
}

/** Human-facing branch label for a full Git target ref. */
export function humanBranchName(ref: string | undefined): string | undefined {
  const value = ref?.trim();
  if (!value) return undefined;
  return value.replace(/^refs\/heads\//, '');
}
