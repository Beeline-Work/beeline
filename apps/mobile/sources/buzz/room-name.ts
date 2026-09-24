export function validRoomSlug(name: string): boolean {
  return name.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export const ROOM_SLUG_HINT = 'Use lowercase letters, numbers and single hyphens (up to 48 characters).';
