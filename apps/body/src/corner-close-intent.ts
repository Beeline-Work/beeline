/**
 * Recognizing "close this corner" typed as an ordinary chat message inside a
 * corner channel.
 *
 * Owner-reported 2026-08-23: the close affordance the product actually ships
 * is the `#t=buzz-corner-close` control tag (`BuzzRigTransport.closeCorner`,
 * wired to mobile's ■ CLOSE CORNER button and `/close` slash verb). A person
 * who instead TYPES "Close this corner" into the corner composer produces a
 * plain kind:9 with no such tag, which `pollMembers` forwarded into the ACP
 * session as conversation — and the agent cannot close its own corner, so the
 * ask died twice and the corner stayed open and enterable forever.
 *
 * This recognizer closes that gap on the daemon side, where it covers every
 * client: an explicit imperative whose whole subject is closing/archiving THIS
 * corner is routed to the same `archiveSubchannel` teardown the tagged control
 * takes, not to the agent. It is deliberately a FIXED set of phrasings — the
 * target-branch lesson (`target-branch.ts`) is that natural language is not a
 * recognizer, and a miss here must degrade to today's behavior (an ordinary
 * conversational turn), never to a wrong close. Anything that discusses,
 * questions the wisdom of, or adds conditions to a close ("should I close
 * this corner?", "close this corner after the tests pass") does NOT match:
 * those remain real turns for the agent.
 */

/** Leading @mention addressing, peeled before matching ("@beebee close…"). */
const MENTION_PREFIX = /^@[A-Za-z0-9_.-]+[,.!?]?\s+/;

/**
 * Conversational leads peeled before matching. Only polite/request frames —
 * never interrogatives that question the close itself ("why did you…",
 * "should I…" leave a residue that fails the exact match below).
 */
const LEAD_PREFIX =
  /^(?:hey|hi|hello|please|pls|can\s+you|could\s+you|would\s+you|will\s+you|go\s+ahead\s+and|and)\s+/i;

/** Trailing politeness/punctuation peeled before matching. */
const TAIL_SUFFIX = /(?:[.,!?\s]+|\s+(?:please|pls|thanks|thank\s+you))+$/i;

/**
 * The imperative itself: close/archive THIS corner, nothing else. The noun is
 * required — a bare "close this" could be about anything, and a wrong close
 * destroys the worktree, so only an explicit corner phrasing qualifies.
 */
const CLOSE_PHRASE = /^(?:close|shut\s+down|archive)\s+(?:this\s+|the\s+|that\s+)?corner$/i;

/**
 * True when `text` is, in its entirety, a request to close this corner.
 *
 * Deliberately strict: after peeling one leading mention, any run of leading
 * politeness leads, and trailing politeness/punctuation, what remains must be
 * exactly the imperative. Extra clauses fail — "close this corner and open a
 * new one" is new work plus a close, and only a human who meant both should
 * have to say so in two messages.
 */
export function isCornerCloseRequest(text: string): boolean {
  let rest = text.trim();
  for (;;) {
    const mentionStripped = rest.replace(MENTION_PREFIX, '');
    const leadStripped = mentionStripped.replace(LEAD_PREFIX, '');
    if (leadStripped === rest) break;
    rest = leadStripped;
  }
  rest = rest.replace(TAIL_SUFFIX, '').trim();
  return CLOSE_PHRASE.test(rest);
}
