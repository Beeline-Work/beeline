import type { ChatDisplayMessage } from './room-view-presentation';
import { boundaryRowIndex } from './room-new-message-boundary';

/**
 * One speaker in a catch-up range. Identity, not a display name: two people
 * can share a name, and folding them into one understates how many the reader
 * is behind on. The handle disambiguates them when a Room holds both.
 */
export type CatchUpAuthor = {
  pubkey: string;
  name: string;
  handle?: string;
};

/** Distinct by pubkey, first mention winning, so a shared name still counts twice. */
export function distinctCatchUpAuthors(
  authors: readonly CatchUpAuthor[],
): readonly CatchUpAuthor[] {
  return authors.filter(
    (author, index) => authors.findIndex((other) => other.pubkey === author.pubkey) === index,
  );
}

/** The speaker a row is attributed to, or null for a row with no resolved identity. */
export function catchUpAuthorOf(
  message: Pick<ChatDisplayMessage, 'authorIdentity'>,
): CatchUpAuthor | null {
  const identity = message.authorIdentity;
  if (!identity) return null;
  return {
    pubkey: identity.pubkey,
    name: identity.name,
    ...(identity.handle ? { handle: identity.handle } : {}),
  };
}

/**
 * The unread range, named by its two ends exactly as the catch-up surfaces
 * pass it in: the boundary the reader fell behind at, through the newest row.
 */
export type CatchUpRange = {
  boundaryId: string;
  newestId: string;
  startedAt: number;
  endedAt: number;
};

/**
 * One line of the Needs you block. Decisions and action items share this
 * shape and one list — the sheet does not split them — and every one of them
 * names who is waiting on the reader.
 */
export type CatchUpNeedsYouItem = {
  id: string;
  kind: 'decision' | 'action';
  text: string;
  requesterName: string;
  at: number;
};

export type CatchUpReport = {
  range: CatchUpRange;
  /** The sheet head: `42 msgs · 08:04–09:46`. */
  rangeLabel: string;
  summary: string;
  needsYou: readonly CatchUpNeedsYouItem[];
};

/** 24-hour wall clock, the form the range head is specified in. */
export function catchUpClock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Two people can share a display name. Where that happens inside one roll the
 * handle tells them apart; counting them as one speaker never does, which is
 * what dedup-by-name did to a Room holding two Sols.
 */
function labelFor(author: CatchUpAuthor, within: readonly CatchUpAuthor[]): string {
  const shared = within.some(
    (other) => other.pubkey !== author.pubkey && other.name === author.name,
  );
  return shared && author.handle
    ? `${author.name} (@${author.handle.replace(/^@/, '')})`
    : author.name;
}

/** `Sol`, `Sol and Nerd`, `Sol, Nerd and 3 others` — the roll every catch-up line uses. */
export function catchUpAuthorRoll(authors: readonly CatchUpAuthor[]): string {
  const distinct = distinctCatchUpAuthors(authors);
  const [first, second, ...rest] = distinct;
  if (!first) return '';
  if (!second) return labelFor(first, distinct);
  if (rest.length === 0) return `${labelFor(first, distinct)} and ${labelFor(second, distinct)}`;
  return `${labelFor(first, distinct)}, ${labelFor(second, distinct)} and ${rest.length} other${
    rest.length === 1 ? '' : 's'
  }`;
}

/**
 * THE seam where a number may enter catch-up copy, and the only one.
 *
 * There is no unread count in this product to print. The server serves
 * `unread: boolean` per Room (`phone-service.ts`), the client's own
 * `NewMessageQueue.count` resets on every Room open so it only ever knows
 * about arrivals during this visit, and the session marks a Room read at its
 * tail on the first fresh view (`useRoomSurfaceSession.ts`) — so no count
 * available here can say how much the reader missed while away. A strip
 * reading `42 new since 08:04` would be inventing that 42.
 *
 * `unreadCount` is where a server-supplied count slots in when one exists.
 * Nothing supplies it today, and nothing may compute one from loaded rows and
 * pass it here: partial history would understate the number and the strip
 * would still be lying, just more quietly.
 */
export function catchUpStripLabel({
  since,
  unreadCount,
}: {
  /** Timestamp of the first unread row — the boundary the reader fell behind at. */
  since: number | null;
  unreadCount?: number | null;
}): string {
  const run =
    typeof unreadCount === 'number' && unreadCount > 0
      ? `${unreadCount} new`
      : 'New';
  const when = since === null ? '' : ` since ${catchUpClock(since)}`;
  return `${run}${when} · Catch me up`;
}

function messageLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Everything the catch-up sheet renders, composed from the range's own rows.
 *
 * There is no summarizer in this codebase to call: the merged `/catch-up`
 * composer verb was a jump to the first unread row, and no path anywhere
 * turns a message range into prose. So the Summary block is stated from what
 * the range demonstrably holds — who spoke, what was opened, what landed —
 * and the Needs you block from the asks the transcript already carries: an
 * open choice the reader is an elector of, a repository edit waiting on them,
 * a message that mentions them. Nothing here is inferred.
 *
 * This function is the single seam all three doors go through — the verb, the
 * strip, the badge. A model-backed summarizer replaces its body and none of
 * them change.
 */
export function buildCatchUpReport({
  messages,
  boundaryId,
  newestId,
  viewerPubkey,
  identities,
}: {
  /** The transcript in chronological order, exactly as the list folds it. */
  messages: readonly ChatDisplayMessage[];
  boundaryId: string | null;
  newestId: string | null;
  viewerPubkey: string | null;
  /**
   * Who a pubkey belongs to, for the asks whose requester is NOT the row's
   * author. A permission card is written by the agent that wants the edit and
   * names its requester by pubkey; attributing the card to its author put the
   * agent's name against a decision a person had asked for.
   */
  identities?: ReadonlyMap<string, CatchUpAuthor>;
}): CatchUpReport | null {
  if (!boundaryId || !newestId) return null;
  const from = boundaryRowIndex(messages, boundaryId);
  const to = boundaryRowIndex(messages, newestId);
  if (from < 0 || to < from) return null;
  const range = messages.slice(from, to + 1);
  if (range.length === 0) return null;

  const startedAt = range[0]!.timestamp;
  const endedAt = range.at(-1)!.timestamp;

  const authors = distinctCatchUpAuthors(
    range.flatMap((message) => {
      const author = message.isUser ? null : catchUpAuthorOf(message);
      return author ? [author] : [];
    }),
  );
  const pollsOpened = range.filter((message) => message.choice?.mode === 'poll').length;
  const merges = range.filter((message) => message.durableFact?.kind === 'merge').length;
  const failures = range.filter((message) => message.durableFact?.kind === 'failure').length;
  const mentions = viewerPubkey
    ? range.filter((message) => message.mentionPubkeys?.includes(viewerPubkey)).length
    : 0;

  // Who, never how many. The rows this range covers are the rows the client
  // happens to hold, so a total stated from them would be a guess dressed as
  // a fact; the head states the window instead and lets the reader see it.
  const roll = catchUpAuthorRoll(authors);
  const opening = roll ? `From ${roll}.` : '';
  const clauses = [
    pollsOpened > 0 ? `${pollsOpened} ${pollsOpened === 1 ? 'poll' : 'polls'} opened` : null,
    merges > 0 ? `${merges} ${merges === 1 ? 'merge' : 'merges'} landed` : null,
    failures > 0 ? `${failures} ${failures === 1 ? 'failure' : 'failures'} reported` : null,
    mentions > 0 ? `you were mentioned ${mentions === 1 ? 'once' : `${mentions} times`}` : null,
  ].filter((clause): clause is string => clause !== null);
  const tail =
    clauses.length === 0
      ? ''
      : `${clauses.join(', ').replace(/^./, (first) => first.toUpperCase())}.`;
  const summary = [opening, tail].filter(Boolean).join(' ') || 'Nothing but messages.';

  const needsYou = range.flatMap((message): CatchUpNeedsYouItem[] => {
    const requesterName = message.authorIdentity?.name ?? 'Someone';
    const choice = message.choice;
    if (
      choice &&
      choice.status === 'open' &&
      viewerPubkey &&
      choice.electorate.includes(viewerPubkey) &&
      !choice.responses.some((response) => response.identityId === viewerPubkey)
    ) {
      return [
        {
          id: `${message.id}:choice`,
          kind: 'decision',
          text: messageLine(choice.prompt),
          requesterName: choice.requester?.name ?? choice.agent.name,
          at: message.timestamp,
        },
      ];
    }
    // The same pending-edit rule the composer's open-corner verb runs on.
    if (
      message.writePermission?.status === 'pending' &&
      message.writePermission.repository &&
      message.writePermission.purpose !== 'squire-spending'
    ) {
      // The card is written by the agent that wants the edit; the person who
      // asked for it is `requesterPubkey`, and the two are routinely
      // different. Only the author's own row may be attributed to the author.
      const { requesterPubkey } = message.writePermission;
      const requester =
        requesterPubkey === message.authorIdentity?.pubkey
          ? catchUpAuthorOf(message)
          : (identities?.get(requesterPubkey) ?? null);
      return [
        {
          id: `${message.id}:write-permission`,
          kind: 'decision',
          text: `Repository edit waiting on you: ${message.writePermission.repository}`,
          requesterName: requester?.name ?? 'Someone',
          at: message.timestamp,
        },
      ];
    }
    if (viewerPubkey && message.mentionPubkeys?.includes(viewerPubkey)) {
      return [
        {
          id: `${message.id}:mention`,
          kind: 'action',
          text: messageLine(message.text),
          requesterName,
          at: message.timestamp,
        },
      ];
    }
    return [];
  });

  return {
    range: { boundaryId, newestId, startedAt, endedAt },
    // The window, by its two ends. A count here would be a count of loaded
    // rows presenting itself as the size of the run.
    rangeLabel: `Since ${catchUpClock(startedAt)} · newest ${catchUpClock(endedAt)}`,
    summary,
    needsYou,
  };
}
