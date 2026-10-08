/**
 * The composer's `#room` / `#room/corner` suggestions. A pick inserts the
 * exact token `findChannelReferences` links once the message is sent.
 */

export type ActiveChannel = {
  start: number;
  end: number;
  query: string;
};

export type ChannelSuggestion = {
  readonly kind: 'room' | 'corner';
  readonly id: string;
  /** `room` or `room/corner`, without the `#` mark. */
  readonly token: string;
  /** Second row line: a Room's repository, or `in #room` for a corner. */
  readonly subtitle?: string;
};

const CHANNEL_QUERY_PATTERN = /(?:^|[\s([{])#([\p{L}\p{M}\p{N}_\-/]*)$/u;

function fold(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

/** Find the `#` fragment ending at a collapsed composer cursor. */
export function activeChannelAtCursor(text: string, cursor: number): ActiveChannel | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const match = CHANNEL_QUERY_PATTERN.exec(text.slice(0, cursor));
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: cursor - query.length - 1, end: cursor, query };
}

/** Rooms first, then the current Room's corners; duplicate ids keep their first entry. */
export function channelSuggestionCandidates(
  rooms: readonly {
    readonly id: string;
    readonly name: string;
    readonly repositoryName?: string;
  }[],
  cornerRoom: { readonly name: string } | null,
  corners: readonly { readonly id: string; readonly name: string }[],
): ChannelSuggestion[] {
  const seen = new Set<string>();
  const candidates: ChannelSuggestion[] = [];
  const add = (candidate: ChannelSuggestion) => {
    if (seen.has(candidate.id)) return;
    seen.add(candidate.id);
    candidates.push(candidate);
  };
  for (const room of rooms) {
    if (room.name) {
      add({
        kind: 'room',
        id: room.id,
        token: room.name,
        ...(room.repositoryName ? { subtitle: room.repositoryName } : {}),
      });
    }
  }
  if (cornerRoom?.name) {
    for (const corner of corners) {
      if (corner.name) {
        add({
          kind: 'corner',
          id: corner.id,
          token: `${cornerRoom.name}/${corner.name}`,
          subtitle: `in #${cornerRoom.name}`,
        });
      }
    }
  }
  return candidates;
}

/**
 * Match the token, or a corner's own name, against the query. Prefix matches
 * lead substring matches; candidate order holds within each group.
 */
export function filterChannelSuggestions(
  candidates: readonly ChannelSuggestion[],
  query: string,
  limit = 6,
): { matches: ChannelSuggestion[]; overflow: number } {
  const folded = fold(query);
  const matching = candidates
    .map((candidate, index) => {
      const token = fold(candidate.token);
      const name = candidate.kind === 'corner' ? token.slice(token.indexOf('/') + 1) : token;
      if (!token.includes(folded) && !name.includes(folded)) return null;
      return { candidate, index, prefix: token.startsWith(folded) || name.startsWith(folded) };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.index - b.index);
  return {
    matches: matching.slice(0, limit).map((item) => item.candidate),
    overflow: Math.max(0, matching.length - limit),
  };
}

/**
 * After `#room/`, when every match is a corner of that Room, the menu names the
 * Room in its heading instead of on each row.
 */
export function channelCornerRoom(
  query: string,
  matches: readonly ChannelSuggestion[],
): string | null {
  const slash = query.indexOf('/');
  if (slash <= 0 || matches.length === 0) return null;
  const room = fold(query.slice(0, slash));
  const inRoom = matches.every(
    (item) => item.kind === 'corner' && fold(item.token).startsWith(`${room}/`),
  );
  return inRoom ? matches[0]!.token.slice(0, matches[0]!.token.indexOf('/')) : null;
}

/** Replace only the active `#` fragment; add one space unless whitespace already follows. */
export function replaceActiveChannel(
  text: string,
  channel: ActiveChannel,
  token: string,
): { text: string; cursor: number } {
  const after = text.slice(channel.end);
  const inserted = /^\s/.test(after) ? `#${token}` : `#${token} `;
  return {
    text: `${text.slice(0, channel.start)}${inserted}${after}`,
    cursor: channel.start + inserted.length,
  };
}
