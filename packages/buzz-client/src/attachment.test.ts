import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MARKER,
  buildAttachmentTags,
  parseAttachmentTags,
  type AttachmentReference,
} from './attachment.js';

const image: AttachmentReference = {
  url: 'https://relay.example/media/full.png',
  name: 'mushroom study.png',
  mimeType: 'image/png',
  size: 12_345_678,
  sha256: 'a'.repeat(64),
  thumbnailUrl: 'https://relay.example/media/thumb.jpg',
  width: 1024,
  height: 768,
};

describe('link-first attachment metadata', () => {
  it('round-trips URL metadata without putting bytes in a tag', () => {
    const tags = buildAttachmentTags([image]);
    const encoded = JSON.stringify(tags);

    expect(tags[0]).toEqual(['t', ATTACHMENT_MARKER]);
    expect(parseAttachmentTags(tags)).toEqual([image]);
    expect(encoded).toContain(image.url);
    expect(encoded).toContain(image.thumbnailUrl);
    expect(encoded).not.toContain('base64');
    expect(encoded.length).toBeLessThan(1_000);
  });

  it('drops unsafe URLs and incomplete metadata', () => {
    expect(
      parseAttachmentTags([
        ['t', ATTACHMENT_MARKER],
        ['imeta', 'url data:image/png;base64,AAAA', 'm image/png', 'size 4'],
        ['imeta', 'url https://relay.example/good.pdf', 'm application/pdf', 'size 4'],
        ['attachment', 'https://relay.example/good.pdf', 'good.pdf'],
      ]),
    ).toEqual([
      {
        url: 'https://relay.example/good.pdf',
        name: 'good.pdf',
        mimeType: 'application/pdf',
        size: 4,
      },
    ]);
  });

  it('round-trips a separate isolated rendering URL without replacing the media URL', () => {
    const html: AttachmentReference = {
      url: 'https://usebeeline.app/media/hash/report.html',
      previewUrl: 'https://preview.usebeeline.app/media/hash/report.html',
      name: 'report.html',
      mimeType: 'text/html',
      size: 42,
    };
    const tags = buildAttachmentTags([html]);
    expect(tags).toContainEqual(
      expect.arrayContaining(['preview https://preview.usebeeline.app/media/hash/report.html']),
    );
    expect(parseAttachmentTags(tags)).toEqual([html]);
  });
});
