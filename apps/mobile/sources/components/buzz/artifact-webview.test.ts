import { describe, expect, it, vi } from 'vitest';

import { artifactWebViewProps, type ArtifactSource } from './artifact-webview';

const guard = { allow: vi.fn(() => true) };

function props(source: ArtifactSource['source'], scrollEnabled?: boolean) {
  return artifactWebViewProps({
    source,
    guard,
    ...(scrollEnabled !== undefined ? { scrollEnabled } : {}),
  });
}

describe('the one sandbox prop table', () => {
  it('renders script off, guarded navigation, no windows, no file access', () => {
    const table = props({ html: '<p>mock</p>' });
    expect(table.javaScriptEnabled).toBe(false);
    expect(table.originWhitelist).toEqual(['*']);
    expect(table.setSupportMultipleWindows).toBe(false);
    expect(table.allowFileAccess).toBe(false);
    expect(table.scrollEnabled).toBe(false);
  });

  it('carries no onMessage bridge at all — the key is absent, not undefined', () => {
    expect(Object.hasOwn(props({ html: '<p>x</p>' }), 'onMessage')).toBe(false);
    expect(Object.hasOwn(props({ uri: 'file:///cache/a.pdf' }), 'onMessage')).toBe(false);
  });

  it('contains authored markup in an empty browser sandbox; local PDF inputs stay local', () => {
    const html = (props({ html: '<p>x</p>' }).source as { html: string }).html;
    expect(html).toContain('<iframe sandbox="" srcdoc="');
    expect(html).toContain('&lt;p&gt;x&lt;/p&gt;');
    expect(html).not.toContain('<p>x</p>');
    expect(props({ uri: 'file:///cache/a.pdf' }).source).toEqual({ uri: 'file:///cache/a.pdf' });
    expect(props({ html: '<p>x</p>' }, true).scrollEnabled).toBe(true);
  });

  it('turns script on only when asked, and keeps the rest of the table either way', () => {
    // The one caller that asks is the generated PDF document, which IS the
    // renderer; artifact markup never gets it.
    const table = artifactWebViewProps({ source: { html: '<p>x</p>', baseUrl: 'https://artifact.usebeeline.app/' }, guard, javaScript: true });
    expect(table.javaScriptEnabled).toBe(true);
    expect(table.originWhitelist).toEqual(['*']);
    expect(table.setSupportMultipleWindows).toBe(false);
    expect(table.allowFileAccess).toBe(false);
    expect(Object.hasOwn(table, 'onMessage')).toBe(false);
  });

  it('carries the base URL that gives the PDF document a real origin', () => {
    const source = { html: '<p>x</p>', baseUrl: 'https://artifact.usebeeline.app/' };
    expect(artifactWebViewProps({ source, guard, javaScript: true }).source).toEqual(source);
  });

  it('forces every scheme through our guard and denies redirects before touching its one shot', () => {
    guard.allow.mockClear(); const table = props({ html: '<p>x</p>' });
    const navigation = table.onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    for (const url of ['https://untrusted.invalid/', 'javascript:alert(1)', 'file:///etc/passwd', 'beeline://rooms', 'data:text/html,escape'])
      expect(navigation({ url })).toBe(false);
    expect(guard.allow).not.toHaveBeenCalled(); expect(table.originWhitelist).toEqual(['*']);
  });

  it('the first-party renderer rejects remote URI and arbitrary base URL inputs', () => {
    for (const uri of ['https://untrusted.invalid/private.html', 'data:text/html,escape', 'file://remote/share/file.pdf'])
      expect(() => props({ uri })).toThrow('private renderer');
    expect(() => artifactWebViewProps({ source: { html: '<p>x</p>', baseUrl: 'https://untrusted.invalid/' }, guard, javaScript: true })).toThrow('private renderer');
    expect(() => artifactWebViewProps({ source: { html: '<p>x</p>' }, guard, javaScript: true })).toThrow('private renderer');
  });

  it('admits one local inline-child bootstrap without granting remote or repeated navigation', () => {
    guard.allow.mockClear();
    const navigate = props({ html: '<p>x</p>' }).onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    expect(navigate({ url: 'about:srcdoc' })).toBe(true);
    expect(navigate({ url: 'about:srcdoc' })).toBe(false);
    expect(guard.allow).not.toHaveBeenCalled();
    const pdfNavigate = artifactWebViewProps({ source: { html: '<p>x</p>', baseUrl: 'https://artifact.usebeeline.app/' }, guard, javaScript: true }).onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    expect(pdfNavigate({ url: 'about:srcdoc' })).toBe(false);
  });

  it('isolates file, cookies, storage, permissions and arbitrary media capabilities', () => {
    const table = props({ uri: 'file:///cache/object.pdf' });
    expect(table.allowingReadAccessToURL).toBe('file:///cache/object.pdf');
    for (const option of ['allowFileAccess', 'allowFileAccessFromFileURLs', 'allowUniversalAccessFromFileURLs',
      'javaScriptCanOpenWindowsAutomatically', 'sharedCookiesEnabled', 'thirdPartyCookiesEnabled', 'domStorageEnabled', 'geolocationEnabled', 'allowsFullscreenVideo'])
      expect(table[option]).toBe(false);
    expect(table.mediaCapturePermissionGrantType).toBe('deny'); expect(table.mixedContentMode).toBe('never');
  });

  it('routes every navigation request through the one-shot guard', () => {
    const table = props({ html: '<p>x</p>' });
    const request = { url: 'about:blank' };
    (table.onShouldStartLoadWithRequest as (r: { url: string }) => boolean)(request);
    expect(guard.allow).toHaveBeenCalledWith('about:blank');
  });
});
