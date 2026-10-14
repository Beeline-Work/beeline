import type { ChatDisplayMessage } from './room-view-presentation';
import { boundaryRowIndex } from './room-new-message-boundary';
import { ledgerStamp } from './relative-time';

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
  /** Device-local first and last unread times. */
  rangeLabel: string;
  summary: string | null;
  needsYou: readonly CatchUpNeedsYouItem[];
};

/** Device-local 24-hour clock; transcript timestamps are Unix seconds. */
export function catchUpClock(atSeconds: number): string {
  return ledgerStamp(atSeconds);
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

function messageLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Extract up to three content sentences, prioritizing decisions and outcomes. */
function unreadSummary(messages: readonly ChatDisplayMessage[]): string | null {
  const authors = distinctCatchUpAuthors(messages.flatMap((message) => {
    const author = catchUpAuthorOf(message);
    return author ? [author] : [];
  }));
  const candidates = messages.flatMap((message, index) => {
    if (message.deleted || message.isAgentActivity || message.isAgentDraft || message.isAgentLiveTurn) return [];
    const text = (message.choice?.prompt ?? message.text)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[ \t]*[#>*-]+[ \t]*/gm, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    const author = catchUpAuthorOf(message);
    const name = author ? labelFor(author, authors) : null;
    return sentences.map((sentence, sentenceIndex) => {
      const content = sentence.trim();
      const line = content.length > 220
        ? `${content.slice(0, 217).replace(/\s+\S*$/, '')}…`
        : content;
      return {
        index,
        sentenceIndex,
        score: /\b(merged?|failed?|failure|decided?|decision|approved?|passed?|result|blocked|shipped?)\b/i.test(content) ? 1 : 0,
        text: `${name ? `${name}: ` : ''}${line}${/[.!?…]$/.test(line) ? '' : '.'}`,
      };
    });
  });
  const seen = new Set<string>();
  const selected = candidates.sort((a, b) => b.score - a.score || b.index - a.index)
    .filter((candidate) => {
      if (seen.has(candidate.text)) return false;
      seen.add(candidate.text);
      return true;
    }).slice(0, 3).sort((a, b) => a.index - b.index || a.sentenceIndex - b.sentenceIndex);
  return selected.map((candidate) => candidate.text).join(' ') || null;
}

/** Composes the unread overview and existing asks from committed transcript rows. */
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

  const summary = unreadSummary(range);

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
