import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

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
    }));
    const { loadPdfViewerDocument } = await import('./artifact-pdf');
    const html = await loadPdfViewerDocument({ pdfBase64: 'JVBERi0xLjQK', mode: 'preview' });
    expect(html).toContain('var vendoredMain;');
    expect(html).toContain('var vendoredWorker;');
    vi.doUnmock('@/vendor/pdfjs/pdfjs.gen');
    vi.resetModules();
  });
});

/**
 * The Android floor. pdf.js' default build assumes a browser as new as its own
 * release: it calls `Promise.withResolvers` while loading the very first
 * document, and that is Chrome 119. An Android System WebView updates through
 * the Play Store independently of the OS, so a device can sit well behind the
 * app — on one of those the default build throws before a page is ever drawn,
 * and the reader gets the failure line instead of their PDF. `legacy/build` is
 * the same pdf.js with its core-js polyfills folded in.
 *
 * So these load the vendored source the way the WebView does — as a module,
 * from a runtime with the primitive taken away — and assert it comes back.
 * Both halves are checked: the fake worker runs the worker build on the main
 * thread, so it meets the same runtime. Regenerating from `build/` instead of
 * `legacy/build/` fails here rather than on a reader's phone.
 */
describe('the vendored renderer runs on the Android WebViews the app still meets', () => {
  const vendored = readFileSync(
    fileURLToPath(new URL('../vendor/pdfjs/pdfjs.gen.ts', import.meta.url)),
    'utf8',
  );

  /** Reads one generated `export const NAME = "…";` string literal back out. */
  function vendoredSource(name: string): string {
    const declaration = vendored.indexOf(`export const ${name} = `);
    expect(declaration).toBeGreaterThan(-1);
    const open = vendored.indexOf('"', declaration);
    let close = open + 1;
    while (close < vendored.length && vendored[close] !== '"') {
      close += vendored[close] === '\\' ? 2 : 1;
    }
    return JSON.parse(vendored.slice(open, close + 1)) as string;
  }

  // Canvas globals the browser build reaches for as it loads. They are not what
  // is under test; stubbing them lets the module finish loading under node.
  beforeAll(() => {
    class Unused {}
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D'] as const) {
      (globalThis as Record<string, unknown>)[name] ??= Unused;
    }
  });

  it.each(['PDFJS_MAIN_SOURCE', 'PDFJS_WORKER_SOURCE'])(
    'loads on a runtime with no Promise.withResolvers and supplies it — %s',
    async (name) => {
      const native = Promise.withResolvers;
      const directory = mkdtempSync(join(tmpdir(), 'pdfjs-runtime-'));
      const module = join(directory, 'vendored.mjs');
      writeFileSync(module, vendoredSource(name));
      try {
        // Exactly the WebView 108 condition: the primitive is simply absent.
        delete (Promise as Partial<PromiseConstructor>).withResolvers;
        expect(Promise.withResolvers).toBeUndefined();
        await import(/* @vite-ignore */ pathToFileURL(module).href);
        expect(typeof Promise.withResolvers).toBe('function');
        const { promise, resolve } = Promise.withResolvers<string>();
        resolve('settled');
        await expect(promise).resolves.toBe('settled');
      } finally {
        Promise.withResolvers = native;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
