import { describe, expect, it } from 'vitest';
import { agentToolsFor } from './read-only-mcp.js';
import { postArtifact, type PostArtifactDeps } from './read-only-mcp.js';

const VALID_HTML = '<!doctype html><html><head><style>b{color:#111}</style></head><body>hi</body></html>';

function deps(): { deps: PostArtifactDeps; uploads: unknown[]; queued: unknown[] } {
  const uploads: unknown[] = [];
  const queued: unknown[] = [];
  return {
    uploads,
    queued,
    deps: {
      roomId: 'room-1',
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
      { url: '/v1/media/obj-1', name: 'Room list mock', mimeType: 'text/html', size: VALID_HTML.length },
    ]);
  });

  it('decodes base64 bytes for a PDF artifact', async () => {
    const { deps: d, uploads, queued } = deps();
    const pdf = Buffer.from('%PDF-1.7 minimal');
    await postArtifact({ title: 'Spec', mime: 'application/pdf', bytes: pdf.toString('base64') }, d);
    expect(uploads[0]).toMatchObject({ mime: 'application/pdf' });
    expect(queued[0]).toMatchObject({ mimeType: 'application/pdf', size: pdf.length });
  });

  it('refuses content that fails the validation matrix before uploading', async () => {
    const { deps: d, uploads, queued } = deps();
    await expect(
      postArtifact(
        { title: 'bad', mime: 'text/html', html: '<script>alert(1)</script>' },
        d,
      ),
    ).rejects.toThrow(/self-contained/);
    expect(uploads).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it('refuses unknown mimes and oversized artifacts', async () => {
    const { deps: d } = deps();
    await expect(postArtifact({ title: 't', mime: 'text/plain', html: 'x' }, d)).rejects.toThrow(
      /mime must be one of/,
    );
    await expect(
      postArtifact({ title: 't', mime: 'text/html', bytes: Buffer.alloc(3 * 1024 * 1024).toString('base64') }, d),
    ).rejects.toThrow(/2 MB/);
  });

  it('requires exactly one of html and bytes', async () => {
    const { deps: d } = deps();
    await expect(postArtifact({ title: 't', mime: 'text/html' }, d)).rejects.toThrow(
      /exactly one of html/,
    );
    await expect(
      postArtifact({ title: 't', mime: 'text/html', html: '<p>x</p>', bytes: 'eA==' }, d),
    ).rejects.toThrow(/exactly one of html/);
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
    expect(tool?.inputSchema).toMatchObject({ required: ['title', 'mime'] });
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
        { roomId: 'room-1', upload: async () => ({ url: '' }), queue: async (a) => void queued.push(a) },
      ),
    ).rejects.toThrow(/no url/);
    expect(queued).toHaveLength(0);
  });
});
