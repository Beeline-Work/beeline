import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  readFileBytes: vi.fn(),
}));

vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: mocks.manipulateAsync,
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: mocks.readFileBytes }));

import { canonicalizeJpeg } from './avatar-png';
import { formatAttachmentSize, uploadChatAttachment } from './chat-attachment';

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >>> 8, length & 0xff, ...payload];
}

function jpegWithMetadata(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe1, [...Buffer.from('Exif\0\0'), 1, 2, 3]),
    ...segment(0xe2, [...Buffer.from('ICC_PROFILE\0'), 1, 1, 4, 5]),
    ...segment(0xfe, [...Buffer.from('phone comment')]),
    ...segment(0xdb, [7, 8, 9]),
    ...segment(0xda, [10, 11]),
    12,
    0xff,
    0x00,
    13,
    0xff,
    0xd9,
  ]);
}

function markerNames(bytes: Uint8Array): number[] {
  const markers: number[] = [];
  let offset = 2;
  let inScan = false;
  while (offset < bytes.byteLength) {
    if (inScan && bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (inScan && marker === 0x00) continue;
    markers.push(marker);
    if (marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    const length = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    offset += length;
    inScan = marker === 0xda;
  }
  return markers;
}

describe('chat attachment display metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it('formats bounded metadata without reading or displaying file content', () => {
    expect(formatAttachmentSize(900)).toBe('900 B');
    expect(formatAttachmentSize(1025)).toBe('2 KB');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatAttachmentSize(20 * 1024 * 1024)).toBe('20 MB');
  });

  it('strips EXIF, ICC, and comment marker channels from JPEG containers', () => {
    const normalized = canonicalizeJpeg(jpegWithMetadata());

    expect(markerNames(normalized)).toEqual([0xdb, 0xda, 0xd9]);
    expect(Buffer.from(normalized).includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(normalized).includes(Buffer.from('ICC_PROFILE'))).toBe(false);
    expect(Buffer.from(normalized).includes(Buffer.from('phone comment'))).toBe(false);
  });

  it('re-encodes and scrubs both the chat photo and its thumbnail before upload', async () => {
    mocks.manipulateAsync
      .mockResolvedValueOnce({ uri: 'file:///encoded.jpg', width: 100, height: 80 })
      .mockResolvedValueOnce({ uri: 'file:///thumbnail.jpg', width: 360, height: 288 });
    mocks.readFileBytes.mockResolvedValue(jpegWithMetadata());
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({
        url: 'https://relay.example/media/photo.jpg',
        sha256: 'photo-hash',
        size: 123,
        type: 'image/jpeg',
      })
      .mockResolvedValueOnce({
        url: 'https://relay.example/media/thumb.jpg',
        sha256: 'thumb-hash',
        size: 45,
        type: 'image/jpeg',
      });

    const uploaded = await uploadChatAttachment(
      { uploadMedia } as never,
      {
        uri: 'content://gallery/14561',
        name: '14561.jpg',
        mimeType: 'image/jpeg',
        size: 191_398,
        width: 100,
        height: 80,
      },
    );

    expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(1, 'content://gallery/14561', [], {
      compress: 0.9,
      format: 'jpeg',
    });
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    for (const [bytes, mimeType] of uploadMedia.mock.calls) {
      expect(mimeType).toBe('image/jpeg');
      expect(markerNames(bytes)).toEqual([0xdb, 0xda, 0xd9]);
    }
    expect(uploaded).toMatchObject({
      name: '14561.jpg',
      mimeType: 'image/jpeg',
      thumbnailUrl: 'https://relay.example/media/thumb.jpg',
    });
  });
});
