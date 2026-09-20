import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateArtifact } from './artifact-validation.js';
import {
  BoundedSizeError,
  FETCH_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  fetchBoundedBytes,
} from './attachment-delivery.js';
import { agentToolsFor, fetchImage, type FetchImageDeps } from './read-only-mcp.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PHOTO_URL = 'https://cdn.example/products/samsung-oled.jpg';

function fakeFetch(bodies: Record<string, { bytes: Buffer; type: string; status?: number; length?: number }>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const entry = bodies[String(input)];
    if (!entry) throw new Error('connection refused');
    return new Response(entry.bytes, {
      status: entry.status ?? 200,
      headers: {
        'content-type': entry.type,
        'content-length': String(entry.length ?? entry.bytes.length),
      },
    });
  }) as unknown as typeof fetch;
}

function deps(fetchImpl: typeof fetch): FetchImageDeps {
  return { root: mkdtempSync(join(tmpdir(), 'fetch-image-')), fetchImpl };
}

describe('beeline-agent fetch_image', () => {
  it('is registered on the agent surface in a Room and a corner, never on the read-only surface', () => {
    expect(agentToolsFor(true, false).map((tool) => tool.name)).toContain('fetch_image');
    expect(agentToolsFor(true, false, true).map((tool) => tool.name)).toContain('fetch_image');
    expect(agentToolsFor(true, true).map((tool) => tool.name)).toContain('fetch_image');
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('fetch_image');
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'fetch_image');
    expect(tool?.inputSchema).toMatchObject({ required: ['url'] });
  });

  it('writes the photograph to scratch and returns path, mime, and size', async () => {
    const fetchImpl = fakeFetch({ [PHOTO_URL]: { bytes: JPEG, type: 'image/jpeg' } });
    const wired = deps(fetchImpl);
    const result = JSON.parse(await fetchImage({ url: PHOTO_URL }, wired)) as {
      path: string;
      mime: string;
      size: number;
    };
    expect(result).toEqual({
      path: join(wired.root, 'fetched-images', 'samsung-oled.jpg'),
      mime: 'image/jpeg',
      size: JPEG.length,
    });
    expect(readFileSync(result.path)).toEqual(JPEG);
    expect(fetchImpl).toHaveBeenCalledWith(PHOTO_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('a fetched photograph embeds as a data: URL that the closed validator accepts', async () => {
    const fetchImpl = fakeFetch({ [PHOTO_URL]: { bytes: JPEG, type: 'image/jpeg' } });
    const result = JSON.parse(await fetchImage({ url: PHOTO_URL }, deps(fetchImpl))) as {
      path: string;
      mime: string;
    };
    const bytes = readFileSync(result.path);
    const html = Buffer.from(
      `<!doctype html><html><head><style>img{max-width:100%}</style></head>` +
        `<body><img src="data:${result.mime};base64,${bytes.toString('base64')}" alt="Samsung OLED"></body></html>`,
    );
    expect(() => validateArtifact('text/html', html, 'Product photo')).not.toThrow();
    expect(() =>
      validateArtifact('text/html', Buffer.from(`<img src="${PHOTO_URL}">`), 'Product photo'),
    ).toThrow(/self-contained/);
  });

  it('sniffs a missing content-type from JPEG magic bytes', async () => {
    const url = 'https://cdn.example/photo.bin';
    const result = JSON.parse(
      await fetchImage({ url }, deps(fakeFetch({ [url]: { bytes: JPEG, type: 'application/octet-stream' } }))),
    ) as { mime: string; path: string };
    expect(result.mime).toBe('image/jpeg');
    expect(result.path.endsWith('.jpg')).toBe(true);
  });

  it('refuses a non-http URL, SVG, HTML, and an empty body', async () => {
    const wired = deps(fakeFetch({}));
    await expect(fetchImage({ url: 'file:///etc/passwd' }, wired)).rejects.toThrow(/http\(s\) URL/);
    await expect(fetchImage({ url: 'javascript:alert(1)' }, wired)).rejects.toThrow(/http\(s\) URL/);
    await expect(fetchImage({}, wired)).rejects.toThrow(/http\(s\) URL/);

    const svgUrl = 'https://cdn.example/icon.svg';
    await expect(
      fetchImage(
        { url: svgUrl },
        deps(fakeFetch({ [svgUrl]: { bytes: Buffer.from('<svg></svg>'), type: 'image/svg+xml' } })),
      ),
    ).rejects.toThrow(/not SVG/);

    const htmlUrl = 'https://html.duckduckgo.com/html/?q=tv';
    await expect(
      fetchImage(
        { url: htmlUrl },
        deps(fakeFetch({ [htmlUrl]: { bytes: Buffer.from('<form class="challenge-form">'), type: 'text/html' } })),
      ),
    ).rejects.toThrow(/not a photograph/);

    const emptyUrl = 'https://cdn.example/empty.jpg';
    await expect(
      fetchImage({ url: emptyUrl }, deps(fakeFetch({ [emptyUrl]: { bytes: Buffer.alloc(0), type: 'image/jpeg' } }))),
    ).rejects.toThrow(/no bytes/);
  });

  it('names an HTTP failure and reuses the attachment size ceiling', async () => {
    const missing = 'https://cdn.example/gone.jpg';
    await expect(
      fetchImage({ url: missing }, deps(fakeFetch({ [missing]: { bytes: Buffer.alloc(0), type: 'text/plain', status: 404 } }))),
    ).rejects.toThrow(/HTTP 404/);

    const huge = 'https://cdn.example/huge.jpg';
    await expect(
      fetchImage(
        { url: huge },
        deps(
          fakeFetch({
            [huge]: { bytes: JPEG, type: 'image/jpeg', length: MAX_ATTACHMENT_BYTES + 1 },
          }),
        ),
      ),
    ).rejects.toThrow(new RegExp(`${MAX_ATTACHMENT_BYTES}-byte limit`));
  });
});

describe('fetchBoundedBytes (shared daemon fetch)', () => {
  it('uses the 30 s timeout and 25 MB ceiling the attachment path already owns', () => {
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
  });

  it('refuses a declared oversize body before the caller writes scratch', async () => {
    const url = 'https://cdn.example/huge.bin';
    await expect(
      fetchBoundedBytes(
        url,
        fakeFetch({ [url]: { bytes: JPEG, type: 'image/jpeg', length: MAX_ATTACHMENT_BYTES + 8 } }),
      ),
    ).rejects.toBeInstanceOf(BoundedSizeError);
  });
});
