/**
 * The chat header's title, split the way a Room-list row splits its heading
 * (`roomRowName` in `room-list-row.ts`): the KIND sigil is drawn separately in
 * brass, the name that follows in the primary tone. This is presentation only —
 * it consumes the display title `channelHeaderTitle` already derived and never
 * touches a stored name.
 *
 * - a Room title `#beeline` → `#` + `beeline`; a corner `#beeline/fix-auth` →
 *   `#` + `beeline/fix-auth` (the corner keeps its parent's mark);
 * - a DM title is its peer's identity; the `@` is the sigil whether or not the
 *   label already carried one (`@alice`, `alice@usebeeline.app`, `Alice`);
 * - a Room whose title fell back to the placeholder (`Room`) has no mark:
 *   nothing fabricated is decorated.
 */
export type ChannelHeaderKind = 'room' | 'dm' | 'corner';

export type ChannelHeaderMark = {
  sigil: '#' | '@' | null;
  name: string;
};

export function splitChannelHeaderTitle(title: string, kind: ChannelHeaderKind): ChannelHeaderMark {
  const trimmed = title.trim();
  if (kind === 'dm') return { sigil: '@', name: trimmed.replace(/^@+/, '') || trimmed };
  if (trimmed.startsWith('#')) {
    const name = trimmed.replace(/^#+/, '');
    return name ? { sigil: '#', name } : { sigil: null, name: trimmed };
  }
  return { sigil: null, name: trimmed };
}
