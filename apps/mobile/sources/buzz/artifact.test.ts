import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_CSP,
  ARTIFACT_DEFAULT_CANVAS,
  ARTIFACT_MAX_PREVIEW_HEIGHT,
  ARTIFACT_TEXT_PREVIEW_COLUMNS,
  ARTIFACT_TEXT_PREVIEW_LINES,
  artifactCapabilities,
  artifactFormat,
  artifactTextPreview,
  createInitialLoadGuard,
  injectCspMeta,
  mediaIdFromUrl,
  wrapArtifactMarkup,
} from './artifact';

/**
 * The support table, one row per mime: format, then preview/viewer for iOS,
 * Android and desktop in that order.
 *
 * The audit found four holes here and they are what these rows pin shut: a
 * raster had NO preview on any surface and no viewer at all on desktop; a PDF
 * was external on both Android and desktop; and TXT, JSON and CSV fell through
 * to the `document` row, so all three were external everywhere. Everything the
 * app can paint now previews and views on every surface, and `document` — the
 * ZIP, the octet-stream, the unrecognized — is the only external row left.
 */
const acceptedMimeMatrix = [
  ['text/html', 'html', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['image/svg+xml', 'svg', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['application/pdf', 'pdf', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['text/markdown', 'markdown', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['image/png', 'image', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['image/jpeg', 'image', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['image/gif', 'image', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['image/webp', 'image', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['text/plain', 'text', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['application/json', 'text', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  ['text/csv', 'text', 'inline', 'inline', 'inline', 'inline', 'inline', 'inline'],
  [
    'application/zip',
    'document',
    'external',
    'external',
    'external',
    'external',
    'external',
    'external',
  ],
  [
    'application/octet-stream',
    'document',
    'external',
    'external',
    'external',
    'external',
    'external',
    'external',
  ],
] as const;

describe('artifact format selection (one artifact kind keyed by mime)', () => {
  it.each(acceptedMimeMatrix)(
    'inventories preview and viewer support for %s',
    (
      mime,
      format,
      iosPreview,
      iosViewer,
      androidPreview,
      androidViewer,
      desktopPreview,
      desktopViewer,
    ) => {
      expect(artifactCapabilities(mime, 'ios')).toEqual({
        format,
        preview: iosPreview,
        viewer: iosViewer,
      });
      expect(artifactCapabilities(mime, 'android')).toEqual({
        format,
        preview: androidPreview,
        viewer: androidViewer,
      });
      expect(artifactCapabilities(mime, 'desktop')).toEqual({
        format,
        preview: desktopPreview,
        viewer: desktopViewer,
      });
    },
  );

  it('selects the per-format branch from the mime type alone', () => {
    expect(artifactFormat('text/html')).toBe('html');
    expect(artifactFormat('image/svg+xml')).toBe('svg');
    expect(artifactFormat('image/png')).toBe('image');
    expect(artifactFormat('image/jpeg')).toBe('image');
    expect(artifactFormat('image/gif')).toBe('image');
    expect(artifactFormat('image/webp')).toBe('image');
    expect(artifactFormat('application/pdf')).toBe('pdf');
    expect(artifactFormat('text/markdown')).toBe('markdown');
    expect(artifactFormat('text/x-markdown')).toBe('markdown');
    expect(artifactFormat('text/plain')).toBe('text');
    expect(artifactFormat('application/json')).toBe('text');
    expect(artifactFormat('text/csv')).toBe('text');
  });

  // The audit's four gaps, named one at a time so a regression says which one
  // came back rather than only that the table moved.
  it.each([
    ['a raster previews on the card', 'image/png', 'ios', 'preview'],
    ['a raster previews on Android', 'image/png', 'android', 'preview'],
    ['a raster previews on desktop', 'image/png', 'desktop', 'preview'],
    ['a raster opens in the desktop pane', 'image/png', 'desktop', 'viewer'],
    ['a PDF previews on Android', 'application/pdf', 'android', 'preview'],
    ['a PDF opens on Android', 'application/pdf', 'android', 'viewer'],
    ['a PDF previews on desktop', 'application/pdf', 'desktop', 'preview'],
    ['a PDF opens in the desktop pane', 'application/pdf', 'desktop', 'viewer'],
    ['plain text reads inline', 'text/plain', 'android', 'viewer'],
    ['JSON reads inline', 'application/json', 'desktop', 'viewer'],
    ['CSV reads inline', 'text/csv', 'ios', 'viewer'],
  ] as const)('%s', (_name, mime, surface, slot) => {
    expect(artifactCapabilities(mime, surface)[slot]).toBe('inline');
  });

  it('keeps the formats nothing on the device can paint on the browser path', () => {
    for (const surface of ['ios', 'android', 'desktop'] as const) {
      expect(artifactCapabilities('application/zip', surface)).toEqual({
        format: 'document',
        preview: 'external',
        viewer: 'external',
      });
    }
  });

  it('falls back to the document card for every other mime', () => {
    expect(artifactFormat('application/zip')).toBe('document');
    expect(artifactFormat('application/octet-stream')).toBe('document');
    expect(artifactFormat('')).toBe('document');
    expect(artifactFormat(' TEXT/HTML ;charset=utf-8')).toBe('html');
  });
});

describe('the text artifact crop that fills the card', () => {
  it('keeps only the lines the preview box can show', () => {
    const file = Array.from({ length: 40 }, (_, line) => `line ${line + 1}`).join('\n');
    const preview = artifactTextPreview(file);
    expect(preview.split('\n')).toHaveLength(ARTIFACT_TEXT_PREVIEW_LINES);
    expect(preview.split('\n')[0]).toBe('line 1');
    expect(preview).not.toContain(`line ${ARTIFACT_TEXT_PREVIEW_LINES + 1}`);
  });

  it('clips one very long line so it cannot push the rest off the card', () => {
    const [clipped, second] = artifactTextPreview(
      `${'x'.repeat(ARTIFACT_TEXT_PREVIEW_COLUMNS + 50)}\nsecond`,
    ).split('\n');
    expect(clipped).toBe(`${'x'.repeat(ARTIFACT_TEXT_PREVIEW_COLUMNS)}…`);
    expect(second).toBe('second');
  });

  it('leaves a file that already fits exactly as the author wrote it', () => {
    const json = '{\n  "a": 1,\n  "b": [2, 3]\n}';
    expect(artifactTextPreview(json)).toBe(json);
  });
});

describe('media id extraction', () => {
  it('reads the object id out of the canonical stored URL', () => {
    expect(mediaIdFromUrl('/v1/media/9f0f6a50-1111-4222-8333-444455556666')).toBe(
      '9f0f6a50-1111-4222-8333-444455556666',
    );
    expect(
      mediaIdFromUrl('https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666'),
    ).toBe('9f0f6a50-1111-4222-8333-444455556666');
  });

  it('names no id for a non-media URL', () => {
    expect(mediaIdFromUrl('https://example.com/page')).toBeNull();
    expect(mediaIdFromUrl('/v1/media/not-an-id')).toBeNull();
  });
});

describe('CSP meta injection', () => {
  it('declares the plan policy: no default source, inline styles, data images only', () => {
    expect(ARTIFACT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  });

  it('injects the meta as the first head element so our policy wins', () => {
    const html = '<!doctype html><html><head><style>p{}</style></head><body></body></html>';
    const wrapped = injectCspMeta(html);
    expect(wrapped.indexOf(ARTIFACT_CSP)).toBeGreaterThan('<!doctype html><html><head>'.length - 1);
    expect(wrapped.indexOf(ARTIFACT_CSP)).toBeLessThan(wrapped.indexOf('<style>'));
  });

  it('gives a headless document a head carrying the policy', () => {
    const wrapped = injectCspMeta('<p>no head</p>');
    expect(wrapped).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
    );
    expect(wrapped.endsWith('<p>no head</p>')).toBe(true);
  });

  it('injects into a document with an existing CSP meta ahead of it', () => {
    const html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>';
    const wrapped = injectCspMeta(html);
    expect(wrapped.indexOf(ARTIFACT_CSP)).toBeLessThan(wrapped.indexOf('default-src *'));
  });
});

describe('markup wrapping', () => {
  it('rides HTML through with the injected policy and caps the preview height', () => {
    const wrapped = wrapArtifactMarkup('<html><body><p>hi</p></body></html>', 'html');
    expect(wrapped).toContain(ARTIFACT_CSP);
    expect(wrapped).toContain('<p>hi</p>');
    expect(ARTIFACT_MAX_PREVIEW_HEIGHT).toBeGreaterThan(0);
  });

  it('wraps SVG bytes in a minimal document so the same sandbox renders them', () => {
    const wrapped = wrapArtifactMarkup('<svg xmlns="http://www.w3.org/2000/svg"/>', 'svg');
    expect(wrapped).toContain(ARTIFACT_CSP);
    expect(wrapped.trim().endsWith('</svg>') || wrapped.includes('<svg')).toBe(true);
    expect(wrapped).toContain('<style>');
  });

  it('paints wrapped SVG on the browser-default canvas, never on the app ink plate', () => {
    const wrapped = wrapArtifactMarkup('<svg xmlns="http://www.w3.org/2000/svg"/>', 'svg');
    // The canvas precedes the SVG so default-black paint reads on white.
    const canvasAt = wrapped.indexOf(ARTIFACT_DEFAULT_CANVAS);
    expect(canvasAt).toBeGreaterThanOrEqual(0);
    expect(wrapped.indexOf('<svg')).toBeGreaterThan(canvasAt);
    // The regression: a transparent page let an SVG's default-black paint
    // land on the app's dark ink plate, and the viewer read as a blank page.
    expect(wrapped.includes('background:transparent')).toBe(false);
    // The centered fit survives the canvas.
    expect(wrapped).toContain('align-items:center');
  });

  it('gives an unstyled HTML page a browser-default canvas, not the app ink plate', () => {
    const wrapped = wrapArtifactMarkup('<h1>Impact Report</h1>', 'html');
    expect(wrapped).toContain(ARTIFACT_DEFAULT_CANVAS);
  });

  it('injects the canvas sheet ahead of the document’s own styles so authored pages win', () => {
    const wrapped = wrapArtifactMarkup(
      '<html><head><style>html{background:#111}</style></head><body></body></html>',
      'html',
    );
    const canvasAt = wrapped.indexOf(ARTIFACT_DEFAULT_CANVAS);
    const authoredAt = wrapped.indexOf('html{background:#111}');
    expect(canvasAt).toBeGreaterThanOrEqual(0);
    expect(authoredAt).toBeGreaterThan(canvasAt);
  });
});

describe('the initial-load navigation guard', () => {
  it('allows exactly the first request and denies every later one', () => {
    const guard = createInitialLoadGuard();
    // Android fires the guard for the initial load too: the first request is
    // allowed whatever its URL.
    expect(guard.allow('about:blank')).toBe(true);
    expect(guard.allow('https://evil.example/next')).toBe(false);
    expect(guard.allow('data:text/html,<p>x</p>')).toBe(false);
  });

  it('each render gets its own gate', () => {
    const first = createInitialLoadGuard();
    const second = createInitialLoadGuard();
    expect(first.allow('about:blank')).toBe(true);
    expect(second.allow('about:blank')).toBe(true);
    expect(first.allow('about:blank')).toBe(false);
  });
});
