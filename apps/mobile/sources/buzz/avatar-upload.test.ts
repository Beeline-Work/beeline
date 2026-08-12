import { describe, expect, it } from 'vitest';
import { canonicalizeAvatarPng } from './avatar-png';

const signature = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(name: string, data: number[] = []): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...[...name].map((character) => character.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function names(bytes: Uint8Array): string[] {
  const found: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length =
      bytes[offset]! * 0x1000000 +
      bytes[offset + 1]! * 0x10000 +
      bytes[offset + 2]! * 0x100 +
      bytes[offset + 3]!;
    const name = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    found.push(name);
    offset += length + 12;
  }
  return found;
}

describe('avatar PNG normalization', () => {
  it('drops metadata channels while preserving the lossless image chunks', () => {
    const source = new Uint8Array([
      ...signature,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...chunk('cHRM', [1, 2, 3]),
      ...chunk('tEXt', [4, 5, 6]),
      ...chunk('IDAT', [7, 8, 9]),
      ...chunk('IEND'),
    ]);

    const normalized = canonicalizeAvatarPng(source);

    expect(names(normalized)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(normalized.byteLength).toBeLessThan(source.byteLength);
  });

  it('rejects incomplete containers before the relay request', () => {
    expect(() => canonicalizeAvatarPng(new Uint8Array(signature))).toThrow('incomplete PNG');
  });
});
