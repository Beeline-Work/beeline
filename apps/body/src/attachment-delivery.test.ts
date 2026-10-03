import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  fetchBoundedBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
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
  it.each([undefined, '4'])(
    'cancels a chunked 26 MiB body with Content-Length %s',
    async (declared) => {
      let chunks = 0;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (chunks === 26) return controller.close();
            chunks += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const fetchImpl = vi.fn(
        async () =>
          new Response(body, {
            headers: declared ? { 'content-length': declared } : {},
          }),
      ) as unknown as typeof fetch;
      await expect(fetchBoundedBytes(PDF.url, fetchImpl)).rejects.toThrow(
        'exceeds the 26214400-byte limit',
      );
      expect(chunks).toBe(26);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );

  it('accepts a body exactly at the 25 MiB cap', async () => {
    const fetched = await fetchBoundedBytes(
      PDF.url,
      fakeFetch({
        [PDF.url]: { bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES), type: 'application/pdf' },
      }),
    );
    expect(fetched.bytes.length).toBe(MAX_ATTACHMENT_BYTES);
  });

  it('reports mkdir failures for every file instead of rejecting the delivery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'block mkdir');
    const fetchImpl = fakeFetch({});
    const delivered = await deliverAttachments([PHOTO, PDF], join(blocker, 'files'), fetchImpl);
    expect(delivered).toHaveLength(2);
    for (const entry of delivered) {
      expect(entry.path).toBeUndefined();
      expect(entry.reason).toContain('download failed:');
      expect(entry.reason).toContain('ENOTDIR');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a write failure affects only that file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    await mkdir(join(dir, PHOTO.name));
    const delivered = await deliverAttachments(
      [PHOTO, PDF],
      dir,
      fakeFetch({
        [PHOTO.url]: { bytes: Buffer.from('jpg'), type: 'image/jpeg' },
        [PDF.url]: { bytes: Buffer.from('%PDF'), type: 'application/pdf' },
      }),
    );
    expect(delivered[0]?.reason).toContain('EISDIR');
    expect(await readFile(delivered[1]!.path!, 'utf8')).toBe('%PDF');
  });

  it.each(['503', 'network'])(
    'bounds temporary %s failures to three attempts; a later delivery retries',
    async (failure) => {
      const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
      roots.push(dir);
      let failing = true;
      const fetchImpl = vi.fn(async () => {
        if (failing && failure === 'network') throw new TypeError('temporary network failure');
        return new Response(failing ? '' : '%PDF', { status: failing ? 503 : 200 });
      }) as unknown as typeof fetch;
      expect((await deliverAttachments([PDF], dir, fetchImpl))[0]?.reason).toContain(
        'download failed:',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      failing = false;
      const delivered = await deliverAttachments([PDF], dir, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(await readFile(delivered[0]!.path!, 'utf8')).toBe('%PDF');
    },
  );

  it('does not retry permanent HTTP failures or oversize streams and still delivers a sibling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beeline-attachments-'));
    roots.push(dir);
    const fetchImpl = fakeFetch({
      [PHOTO.url]: { bytes: Buffer.from('missing'), type: 'image/jpeg', status: 404 },
      [PDF.url]: { bytes: Buffer.from('%PDF'), type: 'application/pdf' },
    });
    const delivered = await deliverAttachments([PHOTO, PDF], dir, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delivered[0]?.reason).toContain('HTTP 404');
    expect(await readFile(delivered[1]!.path!, 'utf8')).toBe('%PDF');
    const hugeFetch = fakeFetch({
      [PDF.url]: { bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), type: 'application/pdf' },
    });
    expect((await deliverAttachments([PDF], dir, hugeFetch))[0]?.reason).toContain('exceeds');
    expect(hugeFetch).toHaveBeenCalledOnce();
  });

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

  // Attachment bytes are swept after their applicable retention window. "not
  // found" reads like a bug the agent should retry; "expired" is what happened.
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
      reason: 'expired: these attachment bytes are past their retention window',
    });
    expect(delivered[1]?.reason).toBe(
      'expired: these attachment bytes are past their retention window',
    );
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
    expect(unseen[1]).toContain(
      'NOT shown to you as an image: this session cannot take image content',
    );
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
    expect(delivered[0]?.inlineSkipped).toContain(
      `past the ${MAX_INLINE_IMAGE_BYTES}-byte inline image limit`,
    );
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
      fakeFetch({
        [PHOTO.url]: { bytes: Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 7), type: 'image/jpeg' },
      }),
    );
    const cached = withoutImageData(delivered);
    expect(cached[0]?.image).toBeUndefined();
    expect(attachmentPromptLines([PHOTO], cached, true)[1]).toContain(
      'NOT shown to you as an image',
    );
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
