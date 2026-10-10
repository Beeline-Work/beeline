/**
 * The one title grammar for Rooms, corners and DMs. Every surface that names
 * a conversation — the chat header, the Room list, the Corners page, the
 * grouped corner dropdown, the desktop inspector, server push and the desktop
 * notification — composes its title here, so one stored name can never read
 * three different ways.
 *
 * Presentation only: nothing here feeds a stored name, a navigation param, a
 * deep link or a cache key. Those keep the raw stored name and the id.
 */

/** Leading `#` marks and outer whitespace removed from a stored name. */
function bareName(name: string | null | undefined): string {
  return name?.trim().replace(/^#+/, '') ?? '';
}

/**
 * A Room titled `#<name>`, or `undefined` when it has no stored name: a
 * placeholder id is never decorated as if it were a name.
 */
export function roomTitle(storedName: string | null | undefined): string | undefined {
  const name = bareName(storedName);
  return name ? `#${name}` : undefined;
}

/**
 * A corner's own name, without the Room part. A legacy stored `<room>/`
 * prefix is dropped (case-insensitively, exact segment only), so a row saved
 * as `#alpha/fix-auth` never reads `#alpha/alpha/fix-auth`. An empty or
 * `sub-` name falls back to an id slug, so the title is never empty.
 *
 * Grouped surfaces — a corner listed under its Room's own row — show this
 * short form, because the Room row already names the Room.
 */
export function cornerShortTitle(
  parentRoomName: string | null | undefined,
  cornerStoredName: string | null | undefined,
  cornerId: string,
): string {
  const room = bareName(parentRoomName);
  let corner = bareName(cornerStoredName);
  const prefix = room ? `${room}/` : '';
  if (prefix && corner.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
    corner = corner.slice(prefix.length).trim();
  if (!corner || corner.startsWith('sub-')) return `corner-${cornerId.slice(0, 8)}`;
  return corner;
}

/**
 * A corner titled `#<room>/<corner>`. When the parent Room's name is not
 * known yet the corner still gets its own mark, `#<corner>`.
 */
export function cornerTitle(
  parentRoomName: string | null | undefined,
  cornerStoredName: string | null | undefined,
  cornerId: string,
): string {
  const room = bareName(parentRoomName);
  const corner = cornerShortTitle(room, cornerStoredName, cornerId);
  return room ? `#${room}/${corner}` : `#${corner}`;
}

export type ChatTitleIdentity = {
  name: string;
  handle?: string | null;
  avatar?: string | null;
};

/** Connector DMs (and Trusty Squire) are named by display name, not handle. */
export function isConnectorIdentity(identity: ChatTitleIdentity): boolean {
  return Boolean(
    (identity.avatar && /\/v1\/connectors\/logo\/[a-z0-9-]+\.svg(?:\?|$)/.test(identity.avatar)) ||
    (identity.name === 'Trusty Squire' && identity.handle?.replace(/^@/, '') === 'trusty-squire'),
  );
}

/**
 * The short handle for a person or agent: the local part of a `name@domain`
 * handle, else the display name. Never carries a leading `@`.
 */
export function identityHandle(identity: ChatTitleIdentity): string {
  if (isConnectorIdentity(identity)) return identity.name;
  const handle = identity.handle?.trim().replace(/^@+/, '');
  const local = handle?.split('@')[0]?.trim();
  return local || identity.name.trim();
}

/** A DM titled `@<peer handle>`. */
export function directMessageTitle(peer: ChatTitleIdentity): string {
  return `@${identityHandle(peer)}`;
}
