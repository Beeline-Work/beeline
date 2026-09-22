import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: vi.fn(),
  EncodingType: { Base64: 'base64' },
  cacheDirectory: 'file:///cache/',
}));

import { uploadChatAttachment } from './chat-attachment';

describe('desktop file attachment upload', () => {
  it('uploads the original bytes from a dropped blob URL', async () => {
    const original = new Uint8Array(Math.floor(4.7 * 1024 * 1024));
    original[0] = 0x25;
    original[original.byteLength - 1] = 0xff;
    const uri = URL.createObjectURL(new Blob([original], { type: 'application/octet-stream' }));
    const uploadMedia = vi.fn().mockResolvedValue({
      url: 'https://relay.example/media/report.bin',
      sha256: 'file-hash',
      size: original.byteLength,
      type: 'application/octet-stream',
    });

    try {
      const uploaded = await uploadChatAttachment({ uploadMedia } as never, {
        uri,
        name: 'report.bin',
        mimeType: 'application/octet-stream',
        size: original.byteLength,
        source: 'file',
      });

      const uploadedBytes = uploadMedia.mock.calls[0]?.[0] as Uint8Array;
      expect(uploadedBytes).toBeInstanceOf(Uint8Array);
      expect(uploadedBytes.byteLength).toBe(4_928_307);
      expect(uploadedBytes[0]).toBe(0x25);
      expect(uploadedBytes[uploadedBytes.byteLength - 1]).toBe(0xff);
      expect(uploaded).toMatchObject({
        name: 'report.bin',
        mimeType: 'application/octet-stream',
      });
    } finally {
      URL.revokeObjectURL(uri);
    }
  });
});
