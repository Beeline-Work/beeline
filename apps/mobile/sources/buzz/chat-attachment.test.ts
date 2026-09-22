import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  readFileBytes: vi.fn(),
  writeAsStringAsync: vi.fn(),
}));

vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: mocks.manipulateAsync,
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: mocks.readFileBytes }));
vi.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: mocks.writeAsStringAsync,
  EncodingType: { Base64: 'base64' },
  cacheDirectory: 'file:///cache/',
}));

import { canonicalizeJpeg } from './avatar-png';
import {
  attachmentOpenUrl,
  formatAttachmentSize,
  pastedImageAttachment,
  pickedPhotoAttachments,
  uploadChatAttachment,
  uploadChatAttachments,
} from './chat-attachment';
import { RAW_PHOTO_FILE_GUIDANCE, RawPhotoDecodeError } from './publish-failure';

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

function pngWithMetadata(): Uint8Array {
  const chunk = (name: string, payload: number[]): number[] => [
    0,
    0,
    0,
    payload.length,
    ...Buffer.from(name),
    ...payload,
    0,
    0,
    0,
    0,
  ];
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [1]),
    ...chunk('tEXt', [...Buffer.from('private metadata')]),
    ...chunk('IDAT', [2]),
    ...chunk('IEND', []),
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

  it('opens active files on the isolated preview URL while leaving images unchanged', () => {
    expect(
      attachmentOpenUrl({
        url: 'https://usebeeline.app/media/hash/report.html',
        previewUrl: 'https://preview.usebeeline.app/media/hash/report.html',
        name: 'report.html',
        mimeType: 'text/html',
        size: 42,
      }),
    ).toBe('https://preview.usebeeline.app/media/hash/report.html');
    expect(
      attachmentOpenUrl({
        url: 'https://usebeeline.app/media/hash/photo.png',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 42,
      }),
    ).toBe('https://usebeeline.app/media/hash/photo.png');
  });

  it('keeps every selected photo in picker order with distinct fallback names', () => {
    expect(
      pickedPhotoAttachments(
        [
          {
            uri: 'content://gallery/first',
            fileName: ' first.png ',
            mimeType: 'image/png',
            fileSize: 12,
            width: 100,
            height: 80,
          },
          {
            uri: 'content://gallery/second',
            width: 80,
            height: 100,
          },
        ],
        1234,
      ),
    ).toEqual([
      {
        uri: 'content://gallery/first',
        name: 'first.png',
        mimeType: 'image/png',
        size: 12,
        source: 'photo',
        width: 100,
        height: 80,
      },
      {
        uri: 'content://gallery/second',
        name: 'photo-1234-2.jpg',
        mimeType: 'image/jpeg',
        size: 0,
        source: 'photo',
        width: 80,
        height: 100,
      },
    ]);
  });

  it('writes a pasted clipboard image to a cache file as a picked attachment', async () => {
    const base64 = Buffer.from('fake-png-bytes').toString('base64');
    const attachment = await pastedImageAttachment(
      { data: `data:image/png;base64,${base64}`, size: { width: 200, height: 100 } },
      1700,
    );

    expect(mocks.writeAsStringAsync).toHaveBeenCalledWith('file:///cache/pasted-1700.png', base64, {
      encoding: 'base64',
    });
    expect(attachment).toEqual({
      uri: 'file:///cache/pasted-1700.png',
      name: 'pasted-1700.png',
      mimeType: 'image/png',
      size: Math.ceil((base64.length * 3) / 4),
      source: 'photo',
      width: 200,
      height: 100,
    });
  });

  it('rejects clipboard image data that is not a base64 data URI', async () => {
    await expect(
      pastedImageAttachment({ data: 'not-a-data-uri', size: { width: 1, height: 1 } }),
    ).rejects.toThrow('Clipboard image data was not readable.');
  });

  it('uploads a message attachment batch in display order', async () => {
    mocks.readFileBytes.mockImplementation(async (uri: string) =>
      uri.endsWith('first') ? new Uint8Array([1]) : new Uint8Array([2]),
    );
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({
        url: 'https://relay.example/media/first.txt',
        sha256: 'first-hash',
        size: 1,
        type: 'text/plain',
      })
      .mockResolvedValueOnce({
        url: 'https://relay.example/media/second.txt',
        sha256: 'second-hash',
        size: 1,
        type: 'text/plain',
      });

    const uploaded = await uploadChatAttachments({ uploadMedia } as never, [
      {
        uri: 'file:///first',
        name: 'first.txt',
        mimeType: 'text/plain',
        size: 1,
        source: 'file',
      },
      {
        uri: 'file:///second',
        name: 'second.txt',
        mimeType: 'text/plain',
        size: 1,
        source: 'file',
      },
    ]);

    expect(mocks.readFileBytes.mock.calls.map(([uri]) => uri)).toEqual([
      'file:///first',
      'file:///second',
    ]);
    expect(uploaded.map(({ name }) => name)).toEqual(['first.txt', 'second.txt']);
  });

  it('strips EXIF, ICC, and comment marker channels from JPEG containers', () => {
    const normalized = canonicalizeJpeg(jpegWithMetadata());

    expect(markerNames(normalized)).toEqual([0xdb, 0xda, 0xd9]);
    expect(Buffer.from(normalized).includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(normalized).includes(Buffer.from('ICC_PROFILE'))).toBe(false);
    expect(Buffer.from(normalized).includes(Buffer.from('phone comment'))).toBe(false);
  });

  it('preserves JPEG encoding while scrubbing metadata from the photo and thumbnail', async () => {
    mocks.manipulateAsync.mockResolvedValueOnce({
      uri: 'file:///thumbnail.jpg',
      width: 360,
      height: 288,
    });
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

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: 'content://gallery/14561',
      name: '14561.jpg',
      mimeType: 'image/jpeg',
      size: 191_398,
      source: 'photo',
      width: 100,
      height: 80,
    });

    expect(mocks.manipulateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.manipulateAsync).toHaveBeenCalledWith(
      'content://gallery/14561',
      [{ resize: { width: 360 } }],
      { compress: 0.72, format: 'jpeg' },
    );
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

  it('preserves PNG encoding while scrubbing metadata', async () => {
    const original = pngWithMetadata();
    mocks.readFileBytes.mockResolvedValueOnce(original);
    mocks.manipulateAsync.mockRejectedValueOnce(new Error('thumbnail unavailable'));
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/photo.png',
      sha256: 'photo-hash',
      size: original.byteLength,
      type: 'image/png',
    });

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: 'content://gallery/photo.png',
      name: 'photo.png',
      mimeType: 'image/png',
      size: original.byteLength,
      source: 'photo',
      width: 100,
      height: 80,
    });

    const [uploadedBytes, uploadedMimeType] = uploadMedia.mock.calls[0]!;
    expect(uploadedMimeType).toBe('image/png');
    expect(Buffer.from(uploadedBytes).includes(Buffer.from('private metadata'))).toBe(false);
    expect(mocks.manipulateAsync).toHaveBeenCalledTimes(1);
    expect(uploaded).toMatchObject({ name: 'photo.png', mimeType: 'image/png' });
  });

  it.each([
    ['image/heic', 'IMG_0001.HEIC'],
    ['image/heif', 'IMG_0002.HEIF'],
  ])('converts %s gallery photos to JPEG', async (mimeType, name) => {
    mocks.manipulateAsync
      .mockResolvedValueOnce({ uri: 'file:///converted.jpg', width: 100, height: 80 })
      .mockRejectedValueOnce(new Error('thumbnail unavailable'));
    mocks.readFileBytes.mockResolvedValue(jpegWithMetadata());
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/photo.jpg',
      sha256: 'photo-hash',
      size: 123,
      type: 'image/jpeg',
    });

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: 'content://gallery/heic',
      name,
      mimeType,
      size: 4_928_307,
      source: 'photo',
      width: 100,
      height: 80,
    });

    expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(1, 'content://gallery/heic', [], {
      compress: 0.9,
      format: 'jpeg',
    });
    expect(uploadMedia).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/jpeg');
    expect(uploaded).toMatchObject({
      name: name.replace(/\.[^.]+$/, '.jpg'),
      mimeType: 'image/jpeg',
    });
  });

  it('converts an unnamed HEIC picker asset despite its fallback JPEG name', async () => {
    mocks.manipulateAsync
      .mockResolvedValueOnce({ uri: 'file:///converted.jpg', width: 100, height: 80 })
      .mockRejectedValueOnce(new Error('thumbnail unavailable'));
    mocks.readFileBytes.mockResolvedValue(jpegWithMetadata());
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/photo.jpg',
      sha256: 'photo-hash',
      size: 123,
      type: 'image/jpeg',
    });
    const [attachment] = pickedPhotoAttachments(
      [
        {
          uri: 'content://gallery/unnamed-heic',
          fileName: null,
          mimeType: 'image/heic',
          fileSize: 123,
          width: 100,
          height: 80,
        },
      ],
      1234,
    );

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, attachment!);

    expect(attachment!.name).toBe('photo-1234-1.jpg');
    expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(1, 'content://gallery/unnamed-heic', [], {
      compress: 0.9,
      format: 'jpeg',
    });
    expect(uploaded).toMatchObject({ name: 'photo-1234-1.jpg', mimeType: 'image/jpeg' });
  });

  it('preserves a compatible WebP photo format and original bytes', async () => {
    const original = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    mocks.readFileBytes.mockResolvedValueOnce(original);
    mocks.manipulateAsync.mockRejectedValueOnce(new Error('thumbnail unavailable'));
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/photo.webp',
      sha256: 'photo-hash',
      size: original.byteLength,
      type: 'image/webp',
    });

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: 'content://gallery/webp',
      name: 'photo.webp',
      mimeType: 'image/webp',
      size: original.byteLength,
      source: 'photo',
      width: 100,
      height: 80,
    });

    expect(uploadMedia).toHaveBeenCalledWith(original, 'image/webp');
    expect(uploaded).toMatchObject({ name: 'photo.webp', mimeType: 'image/webp' });
  });

  it.each([
    ['image/gif', 'photo.gif'],
    ['image/webp', 'photo.webp'],
  ])('preserves %s photo bytes', async (mimeType, name) => {
    const original = new Uint8Array([1, 2, 3, 4]);
    mocks.readFileBytes.mockResolvedValueOnce(original);
    mocks.manipulateAsync.mockRejectedValueOnce(new Error('thumbnail unavailable'));
    const uploadMedia = vi.fn().mockResolvedValue({
      url: `https://relay.example/media/${name}`,
      sha256: 'photo-hash',
      size: original.byteLength,
      type: mimeType,
    });

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: `content://gallery/${name}`,
      name,
      mimeType,
      size: original.byteLength,
      source: 'photo',
      width: 100,
      height: 80,
    });

    expect(uploadMedia).toHaveBeenCalledWith(original, mimeType);
    expect(uploaded).toMatchObject({ name, mimeType });
  });

  it.each([
    ['image/bmp', 'photo.bmp'],
    ['image/x-adobe-dng', 'photo.dng'],
  ])('converts a decodable %s photo to high-quality JPEG', async (mimeType, name) => {
    mocks.manipulateAsync
      .mockResolvedValueOnce({ uri: 'file:///converted.jpg', width: 100, height: 80 })
      .mockRejectedValueOnce(new Error('thumbnail unavailable'));
    mocks.readFileBytes.mockResolvedValueOnce(jpegWithMetadata());
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/photo.jpg',
      sha256: 'photo-hash',
      size: 123,
      type: 'image/jpeg',
    });

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: `content://gallery/${name}`,
      name,
      mimeType,
      size: 123,
      source: 'photo',
      width: 100,
      height: 80,
    });

    expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(1, `content://gallery/${name}`, [], {
      compress: 0.9,
      format: 'jpeg',
    });
    expect(uploadMedia).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/jpeg');
    expect(uploaded).toMatchObject({ name: 'photo.jpg', mimeType: 'image/jpeg' });
  });

  it('shows Send as file guidance when a RAW photo cannot decode', async () => {
    const decoderFailure = new Error('unsupported RAW variant');
    mocks.manipulateAsync.mockRejectedValueOnce(decoderFailure);
    const uploadMedia = vi.fn();

    const upload = uploadChatAttachment({ uploadMedia } as never, {
      uri: 'content://gallery/photo.cr3',
      name: 'photo.cr3',
      mimeType: 'image/jpeg',
      size: 123,
      source: 'photo',
      width: 100,
      height: 80,
    });

    await expect(upload).rejects.toMatchObject({
      name: 'RawPhotoDecodeError',
      message: RAW_PHOTO_FILE_GUIDANCE,
      cause: decoderFailure,
    } satisfies Partial<RawPhotoDecodeError>);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('uploads the reported 4.7 MB RAW file with its original bytes', async () => {
    const original = new Uint8Array(Math.floor(4.7 * 1024 * 1024));
    original[0] = 0x00;
    original[original.byteLength - 1] = 0xff;
    mocks.readFileBytes.mockResolvedValueOnce(original);
    mocks.manipulateAsync.mockRejectedValueOnce(new Error('thumbnail unavailable'));
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/original.dng',
      sha256: 'file-hash',
      size: original.byteLength,
      type: 'image/x-adobe-dng',
    });

    const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
      uri: 'file:///cache/original.dng',
      name: 'original.dng',
      mimeType: 'image/x-adobe-dng',
      size: original.byteLength,
      source: 'file',
    });

    expect(uploadMedia.mock.calls[0]?.[0]).toBe(original);
    expect(uploadMedia.mock.calls[0]?.[1]).toBe('image/x-adobe-dng');
    expect(uploaded).toMatchObject({
      name: 'original.dng',
      mimeType: 'image/x-adobe-dng',
    });
  });
});
