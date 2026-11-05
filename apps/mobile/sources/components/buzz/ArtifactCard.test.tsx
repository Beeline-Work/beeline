import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { resetClientState } from '@/sync/client-reset';

const host = vi.hoisted(() => ({
  os: 'web', disk: new Map<string, Uint8Array>(), fetch: vi.fn(), operation: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return host.os; } },
  View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable',
}));
vi.mock('expo-crypto', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return { CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digest: async (_algorithm: string, bytes: Uint8Array) => sha256(bytes).buffer };
});
vi.mock('react-native-unistyles', async () => {
  const { groknight } = await import('@/buzz/groknight');
  return { StyleSheet: { create: (factory: any) => factory({ buzz: groknight }) } };
});
vi.mock('./IndexRow', () => ({ IndexRow: 'IndexRow', ContentTarget: 'ContentTarget', InlineRow: 'InlineRow' }));
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('./ArtifactMedia', () => ({ ArtifactImage: 'ArtifactImage', ArtifactText: 'ArtifactText' }));
vi.mock('./ArtifactViewer', () => ({ ArtifactViewerScreen: 'ArtifactViewerScreen' }));
vi.mock('./ChevronGlyph', () => ({ CHEVRON_ROW_SIZE: 16, ChevronGlyph: 'ChevronGlyph' }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: 'MonoMarkdown' }));
vi.mock('./sandbox-webview', () => ({ useSandboxWebView: () => 'WebView', useSandboxWebViewStatus: () => 'ready' }));
vi.mock('@/buzz/artifact-pdf', async importOriginal => ({
  ...await importOriginal<typeof import('@/buzz/artifact-pdf')>(),
  loadPdfViewerDocument: vi.fn(async () => '<html>PDF page one</html>'),
}));
vi.mock('@/buzz/chat-attachment', () => ({ formatAttachmentSize: (size: number) => `${size} B` }));
vi.mock('@/buzz/desktop-artifact-pane', () => ({ openArtifactInDesktopWorkPane: vi.fn() }));
vi.mock('@/buzz/viewer-conversation', () => ({ currentViewerConversation: () => null }));
vi.mock('@/buzz/use-artifact-recovery', () => ({ useArtifactRecoveryGeneration: () => 0 }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'reader' }) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: host.fetch } }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://media.test' }) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: host.operation }));
vi.mock('@/buzz/artifact-byte-store', () => ({ createArtifactByteStore: () => ({
  get: async (key: string) => host.disk.get(key) ?? null,
  set: async (key: string, bytes: Uint8Array) => { host.disk.set(key, bytes); },
  remove: async (key: string) => { host.disk.delete(key); }, clear: async () => host.disk.clear(),
  localUri: async () => 'file:///cache/spec.pdf',
}) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn() } }));

import { ArtifactCard } from './ArtifactCard';
import { fetchArtifactBytes } from '@/buzz/artifact-link';
import { ARTIFACT_MAX_PREVIEW_HEIGHT } from '@/buzz/artifact';
import { loadPdfViewerDocument } from '@/buzz/artifact-pdf';

const objectId = '11111111-1111-4111-8111-111111111111';
const html = `<html><body><h1>Agent mock</h1>${'markup '.repeat(4000)}</body></html>`;
const attachment = { url: `/v1/media/${objectId}`, name: 'mock.html', mimeType: 'text/html', size: new TextEncoder().encode(html).length, author: 'agent', kind: 'artifact' as const };
let renderers: ReactTestRenderer[] = [];
async function render(props: Partial<React.ComponentProps<typeof ArtifactCard>> = {}) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ArtifactCard attachment={attachment} {...props} />); });
  renderers.push(tree);
  for (let round = 0; round < 12; round++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  return tree;
}
function install(content = html, mimeType = 'text/html', thumbnail = false) {
  const bytes = new TextEncoder().encode(content);
  const metadata = { objectId, mimeType, sha256: bytesToHex(sha256(bytes)), size: bytes.length, expiresAt: Date.now() + 60_000 };
  host.operation.mockResolvedValue({ ...metadata, ...(thumbnail ? { thumbnail: { ...metadata, objectId: '22222222-2222-4222-8222-222222222222', mimeType: 'image/png', size: 3, sha256: bytesToHex(sha256(new Uint8Array([1, 2, 3]))) } } : {}) });
  host.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('22222222-2222-4222-8222-222222222222') ? new Uint8Array([1, 2, 3]) : bytes));
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetClientState();
  await Promise.resolve();
  host.disk.clear(); host.fetch.mockReset(); host.operation.mockReset(); host.os = 'web';
  install();
});
afterEach(() => { act(() => { for (const tree of renderers) tree.unmount(); }); renderers = []; });

describe('agent-posted artifact card previews', () => {
  it('renders an HTML post without a thumbnail on web and shares original bytes with Open', async () => {
    const tree = await render({ isDesktop: true });
    const frame = tree.root.findByType('iframe');
    expect(frame.props.srcDoc).toContain('<h1>Agent mock</h1>');
    expect(frame.props.srcDoc).toContain("default-src 'none'");
    expect(frame.props.sandbox).toBe('');
    expect(frame.props.tabIndex).toBe(-1);
    expect(tree.root.findByProps({ testID: 'artifact-preview-render' }).props.style[0].height).toBe(ARTIFACT_MAX_PREVIEW_HEIGHT);
    expect(tree.root.findAllByProps({ testID: 'artifact-preview-failed' })).toHaveLength(0);
    expect(host.fetch).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(await fetchArtifactBytes(attachment))).toBe(html);
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['android', 'ios'])('renders the script-off HTML preview on %s', async os => {
    host.os = os;
    const tree = await render();
    const webview = tree.root.findByType('WebView');
    expect(webview.props.source.html).toContain('Agent mock');
    expect(webview.props.source.html).toContain('iframe sandbox=""');
    expect(webview.props.javaScriptEnabled).toBe(false);
    expect(webview.props.scrollEnabled).toBe(false);
    expect(webview.props.onShouldStartLoadWithRequest({ url: 'https://outside.test' })).toBe(false);
  });
  it('renders an SVG post in the same script-off web sandbox', async () => {
    install('<svg><text>Agent diagram</text></svg>', 'image/svg+xml');
    const tree = await render({ attachment: { ...attachment, mimeType: 'image/svg+xml', name: 'diagram.svg' } });
    expect(tree.root.findByType('iframe').props.srcDoc).toContain('<svg><text>Agent diagram</text></svg>');
    expect(tree.root.findByType('iframe').props.sandbox).toBe('');
  });
  it.each(['web', 'android', 'ios'])('renders a PDF post larger than the excerpt limit on %s', async os => {
    host.os = os;
    install('%PDF-' + 'data'.repeat(8000), 'application/pdf');
    const tree = await render({ attachment: { ...attachment, mimeType: 'application/pdf', name: 'spec.pdf' } });
    if (os === 'web') expect(tree.root.findByType('iframe').props.src).toMatch(/^blob:/);
    else if (os === 'ios') expect(tree.root.findByType('WebView').props.source).toEqual({ uri: 'file:///cache/spec.pdf' });
    else {
      expect(tree.root.findByType('WebView').props.javaScriptEnabled).toBe(true);
      expect(tree.root.findByType('WebView').props.scrollEnabled).toBe(false);
    }
    if (os !== 'ios') expect(loadPdfViewerDocument).toHaveBeenCalledWith({ pdfBase64: expect.any(String), mode: 'preview' });
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps an available thumbnail without downloading the original document', async () => {
    install(html, 'text/html', true);
    const tree = await render();
    expect(tree.root.findByProps({ testID: 'artifact-preview-snapshot' })).toBeDefined();
    expect(host.fetch).toHaveBeenCalledTimes(1);
    expect(host.fetch.mock.calls[0][0]).toContain('22222222-2222-4222-8222-222222222222');
  });
  it('does not start a hidden card preview', async () => {
    await render({ visible: false });
    expect(host.operation).not.toHaveBeenCalled();
    expect(host.fetch).not.toHaveBeenCalled();
  });
  it('clears a rendered preview when the identity is reset', async () => {
    const tree = await render();
    expect(tree.root.findByType('iframe')).toBeDefined();
    await act(async () => { resetClientState(); });
    expect(tree.root.findAllByType('iframe')).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'artifact-preview-failed' })).toBeDefined();
  });
  it('keeps real metadata failures visible without downloading a document', async () => {
    host.operation.mockRejectedValue(new Error('Access denied'));
    const tree = await render();
    expect(tree.root.findByProps({ testID: 'artifact-preview-failed' })).toBeDefined();
    expect(host.fetch).not.toHaveBeenCalled();
  });
});
