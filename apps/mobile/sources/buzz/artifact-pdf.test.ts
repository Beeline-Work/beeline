import { describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_PDF_BASE_URL,
  ARTIFACT_PDF_CSP,
  ARTIFACT_PDF_FAILURE_TEXT,
  ARTIFACT_PDF_RENDERED_URL,
  ARTIFACT_PDF_RENDER_TIMEOUT_MS,
  pdfRenderedSignalGuard,
  pdfViewerDocument,
} from './artifact-pdf';

function document(overrides: Partial<Parameters<typeof pdfViewerDocument>[0]> = {}) {
  return pdfViewerDocument({
    pdfBase64: 'JVBERi0xLjQK',
    mainSource: 'export const main = 1;',
    workerSource: 'export const worker = 1;',
    mode: 'viewer',
    ...overrides,
  });
}

describe('the generated PDF render document', () => {
  it('carries the renderer and the file, and the file only ever as data', () => {
    const html = document();
    expect(html).toContain('export const main = 1;');
    expect(html).toContain('export const worker = 1;');
    expect(html).toContain('JVBERi0xLjQK');
    // pdf.js is told never to eval: the bytes are decoded, never executed.
    expect(html).toContain('isEvalSupported: false');
  });

  it('denies every source but the blob module it builds for itself', () => {
    expect(document()).toContain(`content="${ARTIFACT_PDF_CSP}"`);
    expect(ARTIFACT_PDF_CSP).toContain("default-src 'none'");
    // No network: the document never reaches an http origin for anything.
    expect(ARTIFACT_PDF_CSP).not.toContain('https:');
  });

  it('closes a script tag hidden in the source text instead of ending the element early', () => {
    const html = document({ mainSource: 'var trap = "</script><img src=x>";' });
    // The literal sequence would end the script element mid-string; escaped,
    // the trap stays a string and the page keeps exactly one script body.
    expect(html).not.toContain('</script><img src=x>');
    expect(html).toContain('<\\/script>');
    expect(html.split('<script>')).toHaveLength(2);
  });

  it('crops the card to page one and gives the viewer the whole file', () => {
    expect(document({ mode: 'preview' })).toContain('var PAGE_LIMIT=1;');
    expect(document({ mode: 'viewer' })).toContain('var PAGE_LIMIT=0;');
  });

  it('fits every page to the frame width rather than cropping or zooming past it', () => {
    expect(document()).toContain('canvas{display:block;width:100%;height:auto');
    expect(document()).toContain('width / unscaled.width');
  });

  it('hides the card crop overflow so page one alone fills the preview box', () => {
    expect(document({ mode: 'preview' })).toContain('overflow:hidden;');
    expect(document({ mode: 'viewer' })).not.toContain('overflow:hidden;');
  });

  it('says so rather than sitting blank when a PDF never renders', () => {
    const html = document();
    expect(html).toContain(`var RENDER_TIMEOUT_MS=${ARTIFACT_PDF_RENDER_TIMEOUT_MS};`);
    expect(html).toContain(JSON.stringify(ARTIFACT_PDF_FAILURE_TEXT));
    expect(ARTIFACT_PDF_FAILURE_TEXT).toContain('Open in browser');
  });

  it('signals the host only when the host asked for it', () => {
    expect(document({ signalRendered: true })).toContain(JSON.stringify(ARTIFACT_PDF_RENDERED_URL));
    expect(document()).toContain('var RENDERED_URL=null;');
  });

  it('keeps the page off the app bridge entirely', () => {
    const html = document({ signalRendered: true });
    expect(html).not.toContain('postMessage');
    expect(html).not.toContain('ReactNativeWebView');
  });
});

describe('the render-complete signal is a refused navigation, not a bridge', () => {
  it('calls back on the completion url and still refuses it', () => {
    const onRendered = vi.fn();
    const guard = pdfRenderedSignalGuard({ allow: () => true }, onRendered);
    expect(guard.allow(ARTIFACT_PDF_RENDERED_URL)).toBe(false);
    expect(onRendered).toHaveBeenCalledTimes(1);
  });

  it('leaves every other request to the guard underneath', () => {
    const onRendered = vi.fn();
    const inner = { allow: vi.fn((url: string) => url === ARTIFACT_PDF_BASE_URL) };
    const guard = pdfRenderedSignalGuard(inner, onRendered);
    expect(guard.allow(ARTIFACT_PDF_BASE_URL)).toBe(true);
    expect(guard.allow('https://evil.example')).toBe(false);
    expect(onRendered).not.toHaveBeenCalled();
    expect(inner.allow).toHaveBeenCalledTimes(2);
  });
});

describe('the vendored renderer is loaded only when a PDF is on screen', () => {
  it('imports the megabyte of source text lazily, inside the call', async () => {
    vi.resetModules();
    vi.doMock('@/vendor/pdfjs/pdfjs.gen', () => ({
      PDFJS_MAIN_SOURCE: 'var vendoredMain;',
      PDFJS_WORKER_SOURCE: 'var vendoredWorker;',
      PDFJS_VERSION: '0.0.0-test',
    }));
    const { loadPdfViewerDocument } = await import('./artifact-pdf');
    const html = await loadPdfViewerDocument({ pdfBase64: 'JVBERi0xLjQK', mode: 'preview' });
    expect(html).toContain('var vendoredMain;');
    expect(html).toContain('var vendoredWorker;');
    vi.doUnmock('@/vendor/pdfjs/pdfjs.gen');
    vi.resetModules();
  });
});
