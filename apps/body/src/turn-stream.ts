import type { DaemonApiClient } from './daemon-api-client.js';
import { sanitizeAgentReply } from './reply-sanitizer.js';

/**
 * ONE streamed-turn presentation, shared by top-level Rooms and repository
 * corners (C100).
 *
 * In both places the current answer arrives as a provisional draft row while
 * the harness is writing, then dissolves into exactly one durable final
 * message carrying the turn's request id (#903 renders that settle; this is
 * its producer). A corner separately records completed pre-tool assistant runs
 * as output activity, and tells this lane how far into the stream that ledger
 * reaches (`markPersisted`). From there the draft shows only the UNSAVED tail
 * and the final reply carries only the remainder, so prose the reader can
 * already scroll to above the answer is never repeated inside it.
 *
 * Before C100 a corner offset did that job by arithmetic and lost text: it
 * counted the whole stream (every assistant run joined) while the cut was
 * applied to `PromptResult.agentText` (the LAST run only), so any turn that
 * spoke, called a tool and spoke again sliced past the end of a shorter string
 * and lost its closing message. The offset here is a SNAPSHOT of the stream
 * rather than a number: every cut is taken against the same string the
 * snapshot was observed on, and is checked with `startsWith`/`endsWith`
 * first, so a stream that no longer agrees with what was saved cuts nothing
 * and the whole text stands. A Room never calls `markPersisted` — it saves no
 * mid-turn prose — so its lane keeps publishing the stream entire.
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
}

/**
 * What a streamed turn leaves behind in the transcript.
 *
 * Only the harness's LAST assistant run is the answer — an earlier run is
 * progress narration around tool work and never becomes part of this final
 * (the rule `finalAgentMessageText` in `acp.ts` already states). It is returned whole:
 * never a slice, so a turn that narrated before a tool call still posts its
 * closing message in full.
 */
export function durableReplyText(agentText: string): string {
  return sanitizeAgentReply(agentText);
}

export class AgentTurnStream {
  private latest = '';
  /**
   * The assistant run currently accumulating — what `finalAgentMessageText`
   * would return if the prompt ended here. The join above is the draft lane's
   * material; this is the only part of the stream an ending may commit.
   */
  private latestRun = '';
  /**
   * The newest snapshot not yet handed to a write. A draft is a picture of the
   * whole answer so far, so an older snapshot that never reached the wire is
   * not a lost message — it is a frame nobody needed. Keeping only the newest
   * one bounds the lane at ONE write in flight plus ONE waiting.
   */
  private pending: string | undefined;
  /**
   * The stream as it stood when a corner handed everything up to that point to
   * its durable work ledger — this turn's persisted stream offset. Held as the
   * text rather than a character count so every cut can be checked against the
   * string it is about to be applied to, which is the one thing the retired
   * offset never did.
   */
  private persisted = '';
  /** The draft write on the wire, if any. Never rejects; failures are logged. */
  private inFlight: Promise<void> | undefined;
  /** Closed lanes publish nothing more, so the answer never queues behind a draft. */
  private closed = false;
  /**
   * The retract this lane already sent. A settled turn that throws afterwards
   * reaches the same retract a second time, and one empty lane is the whole
   * point: asking twice would only be a second write saying what is already so.
   */
  private retraction: Promise<void> | undefined;

  constructor(private readonly options: AgentTurnStreamOptions) {}

  /**
   * The ACP delta hook: hand it straight to `sessionPrompt`. `full` is every
   * assistant run so far joined — not the final answer — so it is only ever
   * shown provisionally, and only the part of it no durable record carries
   * yet. A caller that cannot name the current run leaves `lastRunText` empty
   * rather than letting the join stand in for it: an unknown last run is not
   * an answer, and an ending that reads one must settle through whatever else
   * it has.
   */
  readonly onChunk = (_delta: string, full: string, currentRun?: string): void => {
    this.latest = full;
    this.latestRun = currentRun ?? '';
    const text = sanitizeAgentReply(this.tailOf(full));
    if (!text || this.closed) return;
    this.pending = text;
    this.publishPending();
  };

  /** The part of `full` this lane has not been told is saved anywhere else. */
  private tailOf(full: string): string {
    return this.persisted && full.startsWith(this.persisted)
      ? full.slice(this.persisted.length)
      : full;
  }

  /**
   * Record that everything in `snapshot` now lives in a durable record of its
   * own. Pass the value `streamedText` had when the save was taken, and pass
   * it only once that write has LANDED: an offset that ran ahead of the wire
   * would cut text out of both the draft and the reply that nothing else ever
   * recorded, which is a loss where a duplicate is merely untidy.
   *
   * Ignored unless the snapshot still starts this turn's stream and reaches
   * further than the last one, so a replayed or rewritten stream, a retried
   * run, and an out-of-order write all leave the offset where it was.
   */
  markPersisted(snapshot: string): void {
    if (snapshot.length <= this.persisted.length) return;
    if (!this.latest.startsWith(snapshot)) return;
    this.persisted = snapshot;
  }

  /** How much of this turn's stream a durable record already carries. */
  get persistedOffset(): string {
    return this.persisted;
  }

  /** What the draft lane is showing: the stream past the persisted offset. */
  get unsavedTail(): string {
    return this.tailOf(this.latest);
  }

  /**
   * The turn's answer with any already-saved head removed — the remainder the
   * final reply settles.
   *
   * `agentText` is the LAST assistant run, while the offset is measured on
   * every run joined. Those are two different strings, and cutting one by the
   * other's length is precisely what the retired corner offset got wrong. So
   * the run is located inside the stream first (`endsWith`), and a cut is
   * taken only for the part of the saved snapshot reaching PAST where that run
   * begins. An offset stopping at or before the seam cuts nothing and the
   * closing message lands whole, exactly as it does with no offset at all.
   */
  remainderOf(agentText: string): string {
    if (!agentText || !this.persisted) return agentText;
    if (!this.latest.startsWith(this.persisted)) return agentText;
    if (!this.latest.endsWith(agentText)) return agentText;
    const runStart = this.latest.length - agentText.length;
    if (this.persisted.length <= runStart) return agentText;
    const savedHead = this.persisted.slice(runStart);
    return agentText.startsWith(savedHead) ? agentText.slice(savedHead.length) : agentText;
  }

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
   * spoke before a tool call. A corner records its runs independently and
   * hands this value back through `markPersisted` to say how much of the
   * stream that record now covers.
   */
  get streamedText(): string {
    return this.latest;
  }

  /**
   * The LAST assistant run alone — the same text `PromptResult.agentText`
   * carries when the prompt returns, available to an ending the prompt never
   * reached. An earlier run is progress narration around tool work and is not
   * this turn's answer, however the turn ends.
   */
  get lastRunText(): string {
    return this.latestRun;
  }

  /** Forget the previous run's stream text; a re-pinned retry starts clean. */
  beginRun(): void {
    this.latest = '';
    this.latestRun = '';
    // The offset measured the abandoned run. The retry rewrites the answer
    // from its first delta, so nothing of the new stream is saved yet.
    this.persisted = '';
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
   * Dissolve the draft, publishing nothing.
   *
   * Every ending uses this: the settle below calls it once the durable reply is
   * on the wire, and a turn that THROWS calls it directly. A throw never
   * reaches a settle, and `close()` alone only stops future writes — the last
   * snapshot stays live on the page, so a turn the Room has already reported
   * stopped or failed keeps a half-written answer visibly in progress under it.
   */
  async retract(): Promise<void> {
    this.close();
    this.retraction ??= (async () => {
      // A draft write already on the wire can land after this. The retract has
      // to be the last word on this lane, or that late write puts an obsolete
      // draft back after the lane was supposed to be empty.
      await this.inFlight;
      const { api, agentId, roomId, requestId, label } = this.options;
      await api
        .execute('retractAgentLiveOutput', {
          agentId,
          roomId,
          turnId: requestId,
          kind: 'draft',
        })
        .catch((error) => console.error(`[thin-core] ${label} draft retract failed:`, error));
    })();
    await this.retraction;
  }

  /**
   * Post the durable reply under the turn's request id and dissolve the draft.
   * An empty reply settles through the turn receipt instead, and the lane is
   * retracted either way.
   *
   * The durable reply is this turn's answer and its last word. The draft lane
   * is presentation, so a refused retract is logged like a refused draft and
   * the turn still settles complete: raising here failed a turn that had
   * already answered, which posts a `failed` receipt and inscribes "<agent>
   * could not answer" UNDER the answer the reader is looking at. The reader
   * loses nothing by it either — the phone ends a retracted draft on the
   * turn's own complete receipt (`visibleLiveOverlays`).
   */
  async settle(
    reply: string,
    fields: DurableReplyFields = {},
    onReplyPosted?: () => void,
  ): Promise<void> {
    this.close();
    const { api, roomId, requestId } = this.options;
    if (reply) {
      await api.execute('postRoomMessage', {
        roomId,
        requestId,
        text: reply,
        presentation: 'message',
        ...fields,
      });
      onReplyPosted?.();
    }
    // The retract stays after the reply: a late draft write must never put an
    // obsolete snapshot back under a message the reader has already been given.
    await this.retract();
  }
}
