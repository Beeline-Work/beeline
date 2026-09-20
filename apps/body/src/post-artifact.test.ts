import { mkdtemp, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentToolsFor } from './read-only-mcp.js';
import { postArtifact, type PostArtifactDeps } from './read-only-mcp.js';

const VALID_HTML =
  '<!doctype html><html><head><style>b{color:#111}</style></head><body>hi</body></html>';

function deps(): { deps: PostArtifactDeps; uploads: unknown[]; queued: unknown[] } {
  const uploads: unknown[] = [];
  const queued: unknown[] = [];
  return {
    uploads,
    queued,
    deps: {
      roomId: 'room-1',
      roots: [mkdtempSync(join(tmpdir(), 'post-artifact-root-'))],
      upload: async (bytes, mime, title) => {
        uploads.push({ bytes, mime, title });
        return { url: '/v1/media/obj-1', mimeType: mime, size: bytes.length };
      },
      queue: async (attachment) => {
        queued.push(attachment);
      },
    },
  };
}

describe('beeline-agent post_artifact', () => {
  it('validates, uploads through the pass-through, and queues the attachment', async () => {
    const { deps: d, uploads, queued } = deps();
    const result = await postArtifact(
      { title: 'Room list mock', mime: 'text/html', html: VALID_HTML },
      d,
    );
    expect(result).toContain('Room list mock');
    expect(result).toContain('delivered with your final reply');
    expect(uploads).toHaveLength(1);
    expect(queued).toEqual([
      {
        url: '/v1/media/obj-1',
        name: 'Room list mock',
        mimeType: 'text/html',
        size: VALID_HTML.length,
      },
    ]);
  });

  it('decodes base64 bytes for a PDF artifact', async () => {
    const { deps: d, uploads, queued } = deps();
    const pdf = Buffer.from('%PDF-1.7 minimal');
    await postArtifact(
      { title: 'Spec', mime: 'application/pdf', bytes: pdf.toString('base64') },
      d,
    );
    expect(uploads[0]).toMatchObject({ mime: 'application/pdf' });
    expect(queued[0]).toMatchObject({ mimeType: 'application/pdf', size: pdf.length });
  });

  it('refuses content that fails the validation matrix before uploading', async () => {
    const { deps: d, uploads, queued } = deps();
    await expect(
      postArtifact({ title: 'bad', mime: 'text/html', html: '<script>alert(1)</script>' }, d),
    ).rejects.toThrow(/self-contained/);
    expect(uploads).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it('refuses unknown mimes and oversized artifacts', async () => {
    const { deps: d } = deps();
    await expect(postArtifact({ title: 't', mime: 'audio/mpeg', html: 'x' }, d)).rejects.toThrow(
      /mime must be one of/,
    );
    await expect(
      postArtifact(
        { title: 't', mime: 'text/html', bytes: Buffer.alloc(26 * 1024 * 1024).toString('base64') },
        d,
      ),
    ).rejects.toThrow(/26214400-byte limit/);
  });

  it('requires content on one channel only', async () => {
    const { deps: d } = deps();
    await expect(postArtifact({ title: 't', mime: 'text/html' }, d)).rejects.toThrow(
      /exactly one of html/,
    );
    await expect(
      postArtifact({ title: 't', mime: 'text/html', html: '<p>x</p>', bytes: 'eA==' }, d),
    ).rejects.toThrow(/not both/);
  });

  it('posts a file written by write_scratch_file by path, defaulting title and mime', async () => {
    const { deps: d, uploads, queued } = deps();
    const dir = d.roots[0];
    const html = `${VALID_HTML}<!-- note -->`;
    await writeFile(join(dir, 'page.html'), html, 'utf8');
    const result = await postArtifact({ path: 'page.html' }, d);
    expect(result).toContain('page.html');
    expect(uploads).toEqual([{ bytes: Buffer.from(html), mime: 'text/html', title: 'page.html' }]);
    expect(queued).toEqual([
      { url: '/v1/media/obj-1', name: 'page.html', mimeType: 'text/html', size: html.length },
    ]);
  });

  it.each([
    ['page.html', 'text/html', VALID_HTML],
    ['page.HTM', 'text/html', VALID_HTML],
    ['diagram.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['spec.pdf', 'application/pdf', '%PDF-1.7 minimal'],
    ['notes.md', 'text/markdown', '# Notes'],
    ['photo.png', 'image/png', 'png'],
    ['photo.jpg', 'image/jpeg', 'jpg'],
    ['photo.jpeg', 'image/jpeg', 'jpeg'],
    ['animation.gif', 'image/gif', 'gif'],
    ['photo.webp', 'image/webp', 'webp'],
    ['notes.txt', 'text/plain', 'notes'],
    ['events.log', 'text/plain', 'events'],
    ['data.json', 'application/json', '{}'],
    ['rows.csv', 'text/csv', 'a,b'],
    ['bundle.zip', 'application/zip', 'zip'],
  ])('infers %s as %s', async (fileName, expectedMime, content) => {
    const { deps: d, uploads } = deps();
    await writeFile(join(d.roots[0], fileName), content, 'utf8');
    await postArtifact({ path: fileName }, d);
    expect(uploads[0]).toMatchObject({ mime: expectedMime, title: fileName });
  });

  it('uses the octet-stream fallback for unknown and extensionless paths', async () => {
    for (const fileName of ['archive.tar.gz', 'README']) {
      const { deps: d, uploads } = deps();
      await writeFile(join(d.roots[0], fileName), 'bytes', 'utf8');
      await postArtifact({ path: fileName }, d);
      expect(uploads[0]).toMatchObject({ mime: 'application/octet-stream', title: fileName });
    }
  });

  it('refuses a path outside the roots and mixed path/content args', async () => {
    const { deps: d } = deps();
    await expect(postArtifact({ path: '/etc/passwd' }, d)).rejects.toThrow(/outside your checkout/);
    await expect(postArtifact({ path: 'x.html', html: '<p>x</p>' }, d)).rejects.toThrow(/not both/);
    await expect(postArtifact({}, d)).rejects.toThrow(/pass a file path/);
  });

  it('requires a title', async () => {
    const { deps: d } = deps();
    await expect(postArtifact({ mime: 'text/html', html: VALID_HTML }, d)).rejects.toThrow(
      /title must be a non-empty string/,
    );
  });

  it('is registered next to open_corner on the agent surface', () => {
    const tools = agentToolsFor(true, false, false, false);
    const names = tools.map((tool) => tool.name);
    expect(names.indexOf('post_artifact')).toBeGreaterThan(names.indexOf('open_corner') - 1);
    const tool = tools.find((entry) => entry.name === 'post_artifact');
    expect(tool?.inputSchema).toMatchObject({ required: [] });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual([
      'path',
      'title',
      'mime',
      'html',
      'bytes',
    ]);
    // The read-only surface never carries it, and the drift check between
    // TOOLS and READ_ONLY_TOOL_NAMES already throws at import time.
    expect(agentToolsFor(false, false, false, false).map((tool) => tool.name)).not.toContain(
      'post_artifact',
    );
  });

  it('refuses an upload that returns no url, and never queues', async () => {
    const queued: unknown[] = [];
    await expect(
      postArtifact(
        { title: 't', mime: 'text/html', html: VALID_HTML },
        {
          roomId: 'room-1',
          upload: async () => ({ url: '' }),
          queue: async (a) => void queued.push(a),
        },
      ),
    ).rejects.toThrow(/no url/);
    expect(queued).toHaveLength(0);
  });
});
