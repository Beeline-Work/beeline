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
  /** Draft publishes are serialized so the lane never reorders. */
  private tail = Promise.resolve();
  private latest = '';

  constructor(private readonly options: AgentTurnStreamOptions) {}

  /**
   * The ACP delta hook: hand it straight to `sessionPrompt`. `full` is every
   * assistant run so far joined — not the final answer — so it is only ever
   * shown provisionally.
   */
  readonly onChunk = (_delta: string, full: string): void => {
    this.latest = full;
    const text = sanitizeAgentReply(full);
    if (!text) return;
    const { api, agentId, roomId, requestId, label } = this.options;
    this.tail = this.tail
      .catch(() => undefined)
      .then(() =>
        api.execute('postAgentDraft', { agentId, roomId, turnId: requestId, text }),
      )
      .then(() => undefined)
      .catch((error) =>
        console.error(`[thin-core] ${label} draft publish failed:`, error),
      );
  };

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
  }

  /** Await every queued draft publish, so the lane is quiet before it settles. */
  async drained(): Promise<void> {
    await this.tail;
  }

  /**
   * Post the durable reply under the turn's request id and dissolve the draft.
   * An empty reply settles through the turn receipt instead, and the lane is
   * retracted either way.
   */
  async settle(reply: string, fields: DurableReplyFields = {}): Promise<void> {
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
    await api.execute('retractAgentLiveOutput', {
      agentId,
      roomId,
      turnId: requestId,
      kind: 'draft',
    });
  }
}
