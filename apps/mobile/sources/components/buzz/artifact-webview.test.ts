import { describe, expect, it, vi } from 'vitest';

import { artifactWebViewProps, type ArtifactSource } from './artifact-webview';

const guard = { allow: vi.fn(() => true) };

function props(source: ArtifactSource['source'], scrollEnabled?: boolean) {
  return artifactWebViewProps({ source, guard, ...(scrollEnabled !== undefined ? { scrollEnabled } : {}) });
}

describe('the one sandbox prop table', () => {
  it('renders script off, no origins, no windows, no file access', () => {
    const table = props({ html: '<p>mock</p>' });
    expect(table.javaScriptEnabled).toBe(false);
    expect(table.originWhitelist).toEqual([]);
    expect(table.setSupportMultipleWindows).toBe(false);
    expect(table.allowFileAccess).toBe(false);
    expect(table.scrollEnabled).toBe(false);
  });

  it('carries no onMessage bridge at all — the key is absent, not undefined', () => {
    expect(Object.hasOwn(props({ html: '<p>x</p>' }), 'onMessage')).toBe(false);
    expect(Object.hasOwn(props({ uri: 'file:///cache/a.pdf' }), 'onMessage')).toBe(false);
  });

  it('passes the source verbatim: wrapped HTML for pages, a file URI for iOS PDFs', () => {
    expect(props({ html: '<p>x</p>' }).source).toEqual({ html: '<p>x</p>' });
    expect(props({ uri: 'file:///cache/a.pdf' }).source).toEqual({ uri: 'file:///cache/a.pdf' });
    expect(props({ html: '<p>x</p>' }, true).scrollEnabled).toBe(true);
  });

  it('turns script on only when asked, and keeps the rest of the table either way', () => {
    // The one caller that asks is the generated PDF document, which IS the
    // renderer; artifact markup never gets it.
    const table = artifactWebViewProps({ source: { html: '<p>x</p>' }, guard, javaScript: true });
    expect(table.javaScriptEnabled).toBe(true);
    expect(table.originWhitelist).toEqual([]);
    expect(table.setSupportMultipleWindows).toBe(false);
    expect(table.allowFileAccess).toBe(false);
    expect(Object.hasOwn(table, 'onMessage')).toBe(false);
  });

  it('carries the base URL that gives the PDF document a real origin', () => {
    const source = { html: '<p>x</p>', baseUrl: 'https://artifact.usebeeline.app/' };
    expect(artifactWebViewProps({ source, guard }).source).toEqual(source);
  });

  it('routes every navigation request through the one-shot guard', () => {
    const table = props({ html: '<p>x</p>' });
    const request = { url: 'about:blank' };
    (table.onShouldStartLoadWithRequest as (r: { url: string }) => boolean)(request);
    expect(guard.allow).toHaveBeenCalledWith('about:blank');
  });
});
