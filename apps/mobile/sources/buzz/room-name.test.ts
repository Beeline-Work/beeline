import { describe, expect, it } from 'vitest';
import { roomNameEntry, validRoomSlug } from './room-name';

describe('continuous Room names', () => {
  it.each([' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u2028', '\ufeff'])('replaces and rejects whitespace %j', (separator) => {
    expect(roomNameEntry(`continuous${separator}amber-corner`)).toBe('continuous-amber-corner');
    expect(validRoomSlug(`continuous${separator}amber-corner`)).toBe(false);
    expect(validRoomSlug(`room${separator}`)).toBe(false);
  });
  it('keeps the trailing hyphen while the user enters the next word', () => {
    expect(roomNameEntry('continuous ')).toBe('continuous-');
    expect(roomNameEntry('continuous  amber')).toBe('continuous--amber');
    expect(validRoomSlug('continuous-amber-corner')).toBe(true);
  });
});
