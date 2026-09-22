import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bytes: vi.fn(),
  uris: [] as string[],
}));

vi.mock('expo-file-system', () => ({
  File: class {
    constructor(uri: string) {
      mocks.uris.push(uri);
    }

    bytes() {
      return mocks.bytes();
    }
  },
}));

import { readFileBytes } from './readFileBytes';

describe('readFileBytes', () => {
  it('returns the original bytes for the reported 4.7 MB file size', async () => {
    const original = new Uint8Array(Math.floor(4.7 * 1024 * 1024));
    original[0] = 0x25;
    original[original.byteLength - 1] = 0xff;
    mocks.bytes.mockResolvedValueOnce(original);

    const read = await readFileBytes('file:///cache/report.pdf');

    expect(mocks.uris).toEqual(['file:///cache/report.pdf']);
    expect(read).toBe(original);
    expect(read.byteLength).toBe(4_928_307);
    expect(read[0]).toBe(0x25);
    expect(read[read.byteLength - 1]).toBe(0xff);
  });
});
