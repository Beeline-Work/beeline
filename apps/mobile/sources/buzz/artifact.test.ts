import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_CSP,
  ARTIFACT_DEFAULT_CANVAS,
  ARTIFACT_MAX_PREVIEW_HEIGHT,
  artifactFormat,
  createInitialLoadGuard,
  injectCspMeta,
  mediaIdFromUrl,
  wrapArtifactMarkup,
} from './artifact';

describe('artifact format selection (one artifact kind keyed by mime)', () => {
  it('selects the per-format branch from the mime type alone', () => {
    expect(artifactFormat('text/html')).toBe('html');
    expect(artifactFormat('image/svg+xml')).toBe('svg');
    expect(artifactFormat('application/pdf')).toBe('pdf');
    expect(artifactFormat('text/markdown')).toBe('markdown');
    expect(artifactFormat('text/x-markdown')).toBe('markdown');
  });

  it('falls back to the document card for every other mime', () => {
    expect(artifactFormat('application/zip')).toBe('document');
    expect(artifactFormat('application/octet-stream')).toBe('document');
    expect(artifactFormat('')).toBe('document');
    expect(artifactFormat(' TEXT/HTML ;charset=utf-8')).toBe('html');
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
    expect(wrapped).toContain(`<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`);
    expect(wrapped.endsWith('<p>no head</p>')).toBe(true);
  });

  it('injects into a document with an existing CSP meta ahead of it', () => {
    const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>';
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
