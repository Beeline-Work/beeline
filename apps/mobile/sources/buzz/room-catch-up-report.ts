import type { ChatDisplayMessage } from './room-view-presentation';
import { boundaryRowIndex, messageBoundaryIds } from './room-new-message-boundary';

/**
 * The unread range, named by its two ends exactly as the catch-up surfaces
 * pass it in: the boundary the reader fell behind at, through the newest row.
 */
export type CatchUpRange = {
  boundaryId: string;
  newestId: string;
  /** Durable ids in the range, so a folded run counts every fact it carries. */
  count: number;
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

function distinct(names: readonly string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) === index);
}

/** `Sol`, `Sol and Nerd`, `Sol, Nerd and 3 others` — the roll every block uses. */
export function catchUpAuthorRoll(names: readonly string[]): string {
  const [first, second, ...rest] = names;
  if (!first) return '';
  if (!second) return first;
  if (rest.length === 0) return `${first} and ${second}`;
  return `${first}, ${second} and ${rest.length} other${rest.length === 1 ? '' : 's'}`;
}

function messageLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Everything the catch-up sheet renders, composed from the range's own rows.
 *
 * There is no summarizer in this codebase to call: the merged `/catch-up`
 * composer verb is a jump to the first unread row (`_chat-surface.tsx`), and
 * no path anywhere turns a message range into prose. So the Summary block is
 * stated from what the range demonstrably holds — who spoke, what was opened,
 * what landed — and the Needs you block from the asks the transcript already
 * carries: an open choice the reader is an elector of, a repository edit
 * waiting on them, a message that mentions them. Nothing here is inferred.
 *
 * This function is the single seam both surfaces go through. A model-backed
 * summarizer replaces its body and neither the strip nor the badge changes.
 */
export function buildCatchUpReport({
  messages,
  boundaryId,
  newestId,
  viewerPubkey,
}: {
  /** The transcript in chronological order, exactly as the list folds it. */
  messages: readonly ChatDisplayMessage[];
  boundaryId: string | null;
  newestId: string | null;
  viewerPubkey: string | null;
}): CatchUpReport | null {
  if (!boundaryId || !newestId) return null;
  const from = boundaryRowIndex(messages, boundaryId);
  const to = boundaryRowIndex(messages, newestId);
  if (from < 0 || to < from) return null;
  const range = messages.slice(from, to + 1);
  if (range.length === 0) return null;

  const count = range.reduce((total, message) => total + messageBoundaryIds(message).length, 0);
  const startedAt = range[0]!.timestamp;
  const endedAt = range.at(-1)!.timestamp;

  const authors = distinct(
    range.flatMap((message) =>
      message.isUser || !message.authorIdentity ? [] : [message.authorIdentity.name],
    ),
  );
  const pollsOpened = range.filter((message) => message.choice?.mode === 'poll').length;
  const merges = range.filter((message) => message.durableFact?.kind === 'merge').length;
  const failures = range.filter((message) => message.durableFact?.kind === 'failure').length;
  const mentions = viewerPubkey
    ? range.filter((message) => message.mentionPubkeys?.includes(viewerPubkey)).length
    : 0;

  const opening = `${count} ${count === 1 ? 'message' : 'messages'}${
    authors.length > 0 ? ` from ${catchUpAuthorRoll(authors)}` : ''
  }.`;
  const clauses = [
    pollsOpened > 0 ? `${pollsOpened} ${pollsOpened === 1 ? 'poll' : 'polls'} opened` : null,
    merges > 0 ? `${merges} ${merges === 1 ? 'merge' : 'merges'} landed` : null,
    failures > 0 ? `${failures} ${failures === 1 ? 'failure' : 'failures'} reported` : null,
    mentions > 0 ? `you were mentioned ${mentions === 1 ? 'once' : `${mentions} times`}` : null,
  ].filter((clause): clause is string => clause !== null);
  const summary =
    clauses.length === 0
      ? opening
      : `${opening} ${clauses.join(', ').replace(/^./, (first) => first.toUpperCase())}.`;

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
      return [
        {
          id: `${message.id}:write-permission`,
          kind: 'decision',
          text: `Repository edit waiting on you: ${message.writePermission.repository}`,
          requesterName,
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
    range: { boundaryId, newestId, count, startedAt, endedAt },
    rangeLabel: `${count} ${count === 1 ? 'msg' : 'msgs'} · ${catchUpClock(startedAt)}–${catchUpClock(endedAt)}`,
    summary,
    needsYou,
  };
}
