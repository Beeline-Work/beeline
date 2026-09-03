import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  MAX_ATTACHMENT_BYTES,
  promptWithImages,
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

  it('renders a URL-only reference for attachments never delivered this session', () => {
    const lines = attachmentPromptLines([PHOTO]);
    expect(lines[1]).toContain('no local copy in this session');
    expect(lines[1]).toContain(`(source ${PHOTO.url})`);
  });
});
