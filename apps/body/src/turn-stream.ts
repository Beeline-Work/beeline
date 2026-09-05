import type { DaemonApiClient } from './daemon-api-client.js';
import { sanitizeAgentReply } from './reply-sanitizer.js';

/**
 * ONE streamed-turn presentation, shared by top-level Rooms and repository
 * corners (C100).
 *
 * A reader must see the same thing in both places: the answer arrives as a
 * provisional draft row while the harness is still writing, and settles by
 * dissolving into exactly one durable message carrying the turn's request id
 * (#903 renders that settle; this is its producer). Everything that decides
 * how a turn LOOKS lives here — the draft lane, the request-id handoff, what
 * becomes durable, and the retract that closes the lane. What a turn SAYS
 * (prompt, mentions, restatement and echo filters) stays with each loop.
 *
 * Before C100 the corner ran a second implementation on top of this one: it
 * also posted completed mid-stream narration sentences as durable Room rows
 * and then cut the same character count off the final. The offset counted the
 * whole stream (every assistant run joined) while the cut was applied to
 * `PromptResult.agentText` (the LAST run only), so any turn that spoke, called
 * a tool and spoke again sliced past the end of a shorter string and lost its
 * closing message. There is no offset here: nothing is published durably while
 * the turn runs, so the durable reply is always the whole reply.
 */
export interface AgentTurnStreamOptions {
  api: DaemonApiClient;
  agentId: string;
  roomId: string;
  /**
   * The live draft's turn id, which MUST equal the durable reply's request id:
   * the phone suppresses a draft the moment a reply with the same id lands, so
   * any other id leaves a ghost draft duplicating the message.
   */
  requestId: string;
  /** Log prefix naming the surface, e.g. `monolith Room <id>` or `corner <id>`. */
  label: string;
}

/** Extra fields the durable reply carries on one surface but not the other. */
export interface DurableReplyFields {
  triggerMessageId?: string;
  mentionIds?: string[];
}

/**
 * What a streamed turn leaves behind in the transcript.
 *
 * Only the harness's LAST assistant run is the answer — an earlier run is
 * progress narration around tool work and stays draft-only (the rule
 * `finalAgentMessageText` in `acp.ts` already states). It is returned whole:
 * never a slice, so a turn that narrated before a tool call still posts its
 * closing message in full.
 */
export function durableReplyText(agentText: string): string {
  return sanitizeAgentReply(agentText);
}

export class AgentTurnStream {
  private latest = '';
  /**
   * The newest snapshot not yet handed to a write. A draft is a picture of the
   * whole answer so far, so an older snapshot that never reached the wire is
   * not a lost message — it is a frame nobody needed. Keeping only the newest
   * one bounds the lane at ONE write in flight plus ONE waiting.
   */
  private pending: string | undefined;
  /** The draft write on the wire, if any. Never rejects; failures are logged. */
  private inFlight: Promise<void> | undefined;
  /** Closed lanes publish nothing more, so the answer never queues behind a draft. */
  private closed = false;

  constructor(private readonly options: AgentTurnStreamOptions) {}

  /**
   * The ACP delta hook: hand it straight to `sessionPrompt`. `full` is every
   * assistant run so far joined — not the final answer — so it is only ever
   * shown provisionally.
   */
  readonly onChunk = (_delta: string, full: string): void => {
    this.latest = full;
    const text = sanitizeAgentReply(full);
    if (!text || this.closed) return;
    this.pending = text;
    this.publishPending();
  };

  /**
   * Hand the newest snapshot to the wire, one write at a time.
   *
   * Serialized, never parallel: two drafts in flight can land out of order and
   * a reader would watch the answer go backwards. Serialized used to mean an
   * unbounded chain — every delta got its own write, and the durable reply
   * awaited the whole tail, so a finished answer sat behind writes showing text
   * nobody would ever read. It waits for at most one write now, and only to
   * keep the retract last.
   */
  private publishPending(): void {
    if (this.inFlight || this.pending === undefined) return;
    const text = this.pending;
    this.pending = undefined;
    const { api, agentId, roomId, requestId, label } = this.options;
    this.inFlight = api
      .execute('postAgentDraft', { agentId, roomId, turnId: requestId, text })
      .then(() => undefined)
      .catch((error) => console.error(`[thin-core] ${label} draft publish failed:`, error))
      .then(() => {
        this.inFlight = undefined;
        this.publishPending();
      });
  }

  /**
   * Everything the delta hook has seen this turn: every assistant run joined,
   * which is a LONGER string than `PromptResult.agentText` whenever the turn
   * spoke before a tool call. Nothing durable is derived from it.
   */
  get streamedText(): string {
    return this.latest;
  }

  /** Forget the previous run's stream text; a re-pinned retry starts clean. */
  beginRun(): void {
    this.latest = '';
    // A snapshot of the abandoned run that never reached the wire is dead text:
    // the new run rewrites the answer from its first delta.
    this.pending = undefined;
  }

  /**
   * Stop drafting. The answer is known from here on, so anything still waiting
   * is obsolete and is dropped rather than published ahead of the final.
   */
  close(): void {
    this.closed = true;
    this.pending = undefined;
  }

  /**
   * Post the durable reply under the turn's request id and dissolve the draft.
   * An empty reply settles through the turn receipt instead, and the lane is
   * retracted either way.
   */
  async settle(reply: string, fields: DurableReplyFields = {}): Promise<void> {
    this.close();
    const { api, agentId, roomId, requestId } = this.options;
    if (reply) {
      await api.execute('postRoomMessage', {
        roomId,
        requestId,
        text: reply,
        presentation: 'message',
        ...fields,
      });
    }
    // A draft write already on the wire can land after the durable reply. The
    // retract has to be the last word on this lane, or that late write puts an
    // obsolete draft back under a message the reader has already been given.
    await this.inFlight;
    await api.execute('retractAgentLiveOutput', {
      agentId,
      roomId,
      turnId: requestId,
      kind: 'draft',
    });
  }
}
