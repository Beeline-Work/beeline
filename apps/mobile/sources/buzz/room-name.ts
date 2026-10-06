export function validRoomSlug(name: string): boolean {
  return name.length <= 48 && !/\s/.test(name) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export const ROOM_SLUG_HINT = 'Use lowercase letters, numbers and single hyphens (up to 48 characters).';

/** Replace whitespace as it is entered, including the separator at the caret. */
export function roomNameEntry(value: string): string {
  return value.replace(/\s/g, '-');
}
