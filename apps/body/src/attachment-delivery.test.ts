import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MEDIA_TTL_HOURS,
  promptWithImages,
  withoutImageData,
} from './attachment-delivery.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PHOTO = {
  url: 'https://server.example/v1/media/photo-id',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 3,
};
const PDF = {
  url: 'https://server.example/v1/media/pdf-id',
  name: 'spec.pdf',
  mimeType: 'application/pdf',
  size: 4,
};

function fakeFetch(bodies: Record<string, { bytes: Buffer; type: string; status?: number }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const entry = bodies[String(input)];
    if (!entry) throw new Error('connection refused');
    return new Response(entry.bytes, {
      status: entry.status ?? 200,
      headers: { 'content-type': entry.type, 'content-length': String(entry.bytes.length) },
    });
  }) as unknown as typeof fetch;
}

describe('attachment delivery', () => {
  it('writes an image and a PDF into the scratch dir and names the local paths in the prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const jpeg = Buffer.from('jpg');
    const fetchImpl = fakeFetch({
      [PHOTO.url]: { bytes: jpeg, type: 'image/jpeg' },
      [PDF.url]: { bytes: Buffer.from('%PDF'), type: 'application/pdf' },
    });
    const delivered = await deliverAttachments([PHOTO, PDF], join(dir, 'msg-1'), fetchImpl);

    expect(delivered.map((entry) => entry.path)).toEqual([
      join(dir, 'msg-1', 'photo.jpg'),
      join(dir, 'msg-1', 'spec.pdf'),
    ]);
    expect(await readFile(join(dir, 'msg-1', 'photo.jpg'))).toEqual(jpeg);
    expect((await readFile(join(dir, 'msg-1', 'spec.pdf'))).toString()).toBe('%PDF');

    const lines = attachmentPromptLines([PHOTO, PDF], delivered);
    expect(lines[0]).toMatch(/read the local file/);
    expect(lines[1]).toContain(`local file ${join(dir, 'msg-1', 'photo.jpg')}`);
    expect(lines[1]).toContain(`(source ${PHOTO.url})`);
    expect(lines[2]).toContain(`local file ${join(dir, 'msg-1', 'spec.pdf')}`);
    expect(lines.join('\n')).not.toContain('capability URL');

    // Only the image becomes an inline block, and only for a harness that accepts images.
    expect(attachmentImageBlocks(delivered, true)).toEqual([
      { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    ]);
    expect(attachmentImageBlocks(delivered, false)).toEqual([]);
    expect(promptWithImages('hello', attachmentImageBlocks(delivered, true))).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    ]);
    expect(promptWithImages('hello', attachmentImageBlocks(delivered, false))).toBe('hello');
  });

  it('skips an oversized attachment with an explicit line and never downloads it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const fetchImpl = fakeFetch({});
    const huge = { ...PDF, size: MAX_ATTACHMENT_BYTES + 1 };
    const delivered = await deliverAttachments([huge], dir, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(delivered[0]?.path).toBeUndefined();
    const line = attachmentPromptLines([huge], delivered)[1];
    expect(line).toContain(`skipped: ${MAX_ATTACHMENT_BYTES + 1} bytes exceeds`);
    expect(line).toContain(`(source ${PDF.url})`);
  });

  it('degrades a failed download to the URL line without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const delivered = await deliverAttachments(
      [PHOTO, { ...PDF, url: 'https://server.example/v1/media/missing' }],
      dir,
      fakeFetch({ [PHOTO.url]: { bytes: Buffer.from('x'), type: 'image/jpeg', status: 500 } }),
    );
    const lines = attachmentPromptLines(
      [PHOTO, { ...PDF, url: 'https://server.example/v1/media/missing' }],
      delivered,
    );
    expect(lines[1]).toContain('download failed: HTTP 500');
    expect(lines[1]).toContain(`(source ${PHOTO.url})`);
    expect(lines[2]).toContain('download failed: connection refused');
    expect(lines[2]).toContain('(source https://server.example/v1/media/missing)');
    expect(attachmentImageBlocks(delivered, true)).toEqual([]);
  });

  // Attachment bytes are swept 24 hours after upload. "not found" reads like a
  // bug the agent should retry; "expired" is what actually happened.
  it('says an attachment expired rather than failed, from the flag and from 410 Gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const flagged = { ...PDF, expired: true };
    const goneOnFetch = { ...PHOTO, url: 'https://server.example/v1/media/swept' };
    const fetchImpl = fakeFetch({
      [goneOnFetch.url]: { bytes: Buffer.from(''), type: 'application/json', status: 410 },
    });
    const delivered = await deliverAttachments([flagged, goneOnFetch], dir, fetchImpl);

    // The server already said so, so the daemon never asks for the bytes.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delivered[0]).toEqual({
      attachment: flagged,
      reason: expect.stringContaining(`expired: attachments are kept for ${MEDIA_TTL_HOURS} hours`),
    });
    expect(delivered[1]?.reason).toContain('expired: attachments are kept');
    expect(delivered[1]?.path).toBeUndefined();

    const lines = attachmentPromptLines([flagged, goneOnFetch], delivered);
    expect(lines[1]).toContain('expired');
    expect(lines[1]).not.toContain('download failed');
    expect(lines[2]).toContain('expired');
    expect(lines[2]).not.toContain('download failed');
    // The metadata the message still carries survives beside the reason.
    expect(lines[1]).toContain('spec.pdf');
  });

  it('renders a URL-only reference for attachments never delivered this session', () => {
    const lines = attachmentPromptLines([PHOTO]);
    expect(lines[1]).toContain('no local copy in this session');
    expect(lines[1]).toContain(`(source ${PHOTO.url})`);
  });

  // C87. A photo the harness cannot carry must be NAMED, in the same turn, not
  // left looking like a picture the agent was shown.
  it('names an image as unseen when the harness advertises no image capability', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const delivered = await deliverAttachments(
      [PHOTO],
      dir,
      fakeFetch({ [PHOTO.url]: { bytes: Buffer.from('jpg'), type: 'image/jpeg' } }),
    );

    const seen = attachmentPromptLines([PHOTO], delivered, true);
    expect(seen[1]).not.toContain('NOT shown to you');
    expect(seen).toHaveLength(2);

    const unseen = attachmentPromptLines([PHOTO], delivered, false);
    expect(unseen[1]).toContain('NOT shown to you as an image: this session cannot take image content');
    expect(unseen[1]).toContain(`local file ${join(dir, 'photo.jpg')}`);
    expect(unseen.at(-1)).toBe(
      'You were not shown the picture itself: this session cannot take image content. If you are asked about it, say that in one plain sentence rather than describing an image you cannot see.',
    );
    // The degrade is a prompt fact, not a stall: no image block is ever built.
    expect(attachmentImageBlocks(delivered, false)).toEqual([]);
  });

  it('bounds one inline image and keeps the local file, naming the ceiling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const big = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 7);
    const delivered = await deliverAttachments(
      [PHOTO],
      dir,
      fakeFetch({ [PHOTO.url]: { bytes: big, type: 'image/jpeg' } }),
    );
    expect(delivered[0]?.path).toBe(join(dir, 'photo.jpg'));
    expect(delivered[0]?.image).toBeUndefined();
    expect(delivered[0]?.inlineSkipped).toContain(`past the ${MAX_INLINE_IMAGE_BYTES}-byte inline image limit`);
    expect(attachmentImageBlocks(delivered, true)).toEqual([]);

    const lines = attachmentPromptLines([PHOTO], delivered, true);
    expect(lines[1]).toContain('NOT shown to you as an image');
    expect(lines[1]).toContain(`local file ${join(dir, 'photo.jpg')}`);
    expect(lines.at(-1)).toContain('say that in one plain sentence');
  });

  it('keeps the unseen reason on a transcript re-render, after the bytes are dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const delivered = await deliverAttachments(
      [PHOTO],
      dir,
      fakeFetch({ [PHOTO.url]: { bytes: Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 7), type: 'image/jpeg' } }),
    );
    const cached = withoutImageData(delivered);
    expect(cached[0]?.image).toBeUndefined();
    expect(attachmentPromptLines([PHOTO], cached, true)[1]).toContain('NOT shown to you as an image');
  });

  // The existing text-only path is unchanged: a non-image attachment is never
  // described as an unshown picture, whatever the harness advertises.
  it('never marks a non-image attachment as unseen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const delivered = await deliverAttachments(
      [PDF],
      dir,
      fakeFetch({ [PDF.url]: { bytes: Buffer.from('%PDF'), type: 'application/pdf' } }),
    );
    const lines = attachmentPromptLines([PDF], delivered, false);
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain('NOT shown to you');
  });
});
