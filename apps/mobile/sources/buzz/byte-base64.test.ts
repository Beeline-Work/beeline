import { describe, expect, it } from 'vitest';
import { bytesToBase64, base64ToBytes } from './byte-base64';
describe('native-runtime-compatible byte encoding', () => {
  it.each([0, 1, 2, 3, 12_287, 12_288, 12_289, 25_000])('round-trips %i bytes across chunk boundaries', size => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
  it.each(['A', 'A===', 'AA=A', '!!!!'])('rejects malformed cached encoding %s', value => {
    expect(() => base64ToBytes(value)).toThrow('Invalid');
  });
});
