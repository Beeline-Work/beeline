/**
 * RigTransport — Buzzy's client↔agent seam (spec.md Appendix).
 *
 * This is the adapter boundary for the follow-up lane that plugs Buzz
 * (channels + buzz-acp + git API) under Happy's session UI.
 *
 * Happy's existing backend remains the runtime implementation today
 * (see `createHappyRigTransport` and BUZZ-SEAM.md). Do NOT wire Buzz
 * networking in this package yet.
 *
 * Every method is channel-scoped in Buzzy (not one account). Happy is
 * account-scoped; that mismatch is the re-plumb work.
 */

import type { AttachmentReference } from '@beeline/buzz-client';

type SessionId = string;

export type AgentActivityItem = {
  /**
   * `output` is the agent's own prose — narration, the thing the reader is
   * actually here to read. It is deliberately distinct from `summary`, the
   * synthetic per-batch receipt body publishes, so the corner can show the one
   * and fold the other. Conflating them is what buried an agent's narration
   * behind a "tool output" disclosure.
   *
   * `note` is a Room turn's earlier text run: text the agent wrote before a
   * later tool call. It is not the reply, so it sits inside the collapsed
   * steps line in turn order, between the tool lines, shown in full.
   */
  kind: 'thinking' | 'tool' | 'output' | 'summary' | 'note';
  title: string;
  id?: string;
  toolKind?: string;
  /**
   * Per-verb counts of the observational tool calls body deliberately does not
   * project as their own events (`apps/body/src/activity.ts`). The only source
   * for "read 41, searched 12" — those calls never reach the wire themselves.
   */
  rollup?: Record<string, number>;
  /**
   * A compact receipt per folded call — what it looked at and a short taste of
   * what it found — riding the same summary event as `rollup`. The calls
   * themselves still never earn their own wire event (that's the noise-control
   * fold), so this is body's only source for the review sheet's per-call rows;
   * without it the sheet has nothing but the bare tally to show.
   */
  observed?: Array<{ verb: string; target?: string; result?: string }>;
  /**
   * Milliseconds the agent spent reasoning before this batch's work landed.
   * The reasoning *text* is never published (unbounded, and quota-hostile), so
   * this span is the only trace of it — enough for the quiet `THOUGHT FOR 5.8S`
   * receipt, which is the half of grok Build's loud-then-quiet reasoning the
   * wire can afford.
   */
  thoughtMs?: number;
  text?: string;
  status?: string;
  /** Bounded, redacted corner-tool argument summary. */
  command?: string;
  input?: string;
  /** Bounded first/last-line excerpt from the completed tool result. */
  output?: string;
  /** The identity whose message triggered the turn ("at Alex's request"). */
  requestedBy?: { pubkey: string; name?: string };
  files?: Array<{
    path: string;
    status?: string;
    diff?: string;
  }>;
  /**
   * On a `note`: this text carries on the previous note. One text run longer
   * than a note may be is split across consecutive notes, never cut.
   */
  continues?: boolean;
  plan?: {
    objective?: string;
    items: Array<{
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }>;
  };
};

export type MessageSubmitInput = {
  sessionId: SessionId;
  text: string;
  /** Optional display text / attachments — Happy's SendMessageOptions shape. */
  displayText?: string;
  source?: string;
  attachments?: AttachmentReference[];
};
