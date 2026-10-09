import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { acceptedJsonEncoding, encodeJsonBody } from './json-response.js';

const roomRead = {
  messages: Array.from({ length: 30 }, (_, index) => ({
    id: index.toString(16).padStart(64, '0'),
    text: `message ${index}`,
    author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Otter' },
  })),
};

describe('JSON response encoding', () => {
  it('answers brotli when offered, else gzip, else nothing', () => {
    expect(acceptedJsonEncoding('gzip, deflate, br')).toBe('br');
    expect(acceptedJsonEncoding('gzip')).toBe('gzip'); // Android's OkHttp
    expect(acceptedJsonEncoding('gzip;q=1.0, br;q=0')).toBe('gzip');
    expect(acceptedJsonEncoding('identity')).toBeUndefined();
    expect(acceptedJsonEncoding(undefined)).toBeUndefined();
  });

  it('compresses a Room-sized body to bytes that inflate back to the same JSON', () => {
    const plain = encodeJsonBody(roomRead, undefined);
    const gzip = encodeJsonBody(roomRead, 'gzip');
    const br = encodeJsonBody(roomRead, 'br');
    expect(plain.encoding).toBeUndefined();
    expect(gzip.encoding).toBe('gzip');
    expect(br.encoding).toBe('br');
    expect(gunzipSync(gzip.bytes).equals(plain.bytes)).toBe(true);
    expect(brotliDecompressSync(br.bytes).equals(plain.bytes)).toBe(true);
    expect(gzip.bytes.length).toBeLessThan(plain.bytes.length / 4);
  });

  it('leaves a body too small to save a packet as plain JSON', () => {
    expect(encodeJsonBody({ count: 3 }, 'gzip')).toEqual({ bytes: Buffer.from('{"count":3}\n') });
  });
});
