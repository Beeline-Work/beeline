import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'android' as string },
  safeAreaTop: { value: 42 },
  fetchArtifactBytes: vi.fn(),
  fetchArtifactText: vi.fn(),
  openArtifactInBrowserOrExplain: vi.fn(),
  artifactPdfLocalUri: vi.fn(),
  onClose: vi.fn(),
}));

// Shared between the StyleSheet.create factory and useUnistyles so the test
// can assert against the same spacing the header reads.
const theme = vi.hoisted(() => ({
  buzz: {
    border: '#333',
    bgBase: '#111',
    textPrimary: '#eee',
    ledgerQuiet: '#777',
    space: { sm: 8, md: 12 },
    type: { body: {}, bodyStrong: {}, meta: {} },
  },
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    Platform: {
      get OS() {
        return mocks.platformOS.value;
      },
      select: (choices: Record<string, unknown>) => choices.default,
    },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-webview', () => ({
  default: (props: Record<string, unknown>) => React.createElement('WebView', props, null),
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) => factory({ buzz: theme.buzz }),
  },
  useUnistyles: () => ({ theme }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: mocks.safeAreaTop.value, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/buzz/artifact-link', () => ({
  artifactPdfLocalUri: mocks.artifactPdfLocalUri,
  fetchArtifactBytes: mocks.fetchArtifactBytes,
  fetchArtifactText: mocks.fetchArtifactText,
  openArtifactInBrowserOrExplain: mocks.openArtifactInBrowserOrExplain,
}));
vi.mock('@/components/buzz/MonoMarkdown', () => ({
  MonoMarkdown: (props: Record<string, unknown>) => React.createElement('MonoMarkdown', props, null),
}));

import { ARTIFACT_DEFAULT_CANVAS } from '@/buzz/artifact';
import { ArtifactViewerSandbox, ArtifactViewerScreen } from './ArtifactViewer';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
    name: 'login-mock.html',
    mimeType: 'text/html',
    size: 2048,
    kind: 'artifact' as const,
    title: 'Login mock',
    ...overrides,
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

async function flush(): Promise<void> {
  // Real macrotask ticks, not just microtasks: under a loaded test worker the
  // dynamic `import('react-native-webview')` a full suite run contends with
  // needs more than a handful of Promise.resolve() turns to settle.
  for (let round = 0; round < 20; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('the full-screen artifact viewer (mock 1c)', () => {
  it('renders HTML in the sandboxed WebView: script off, guarded, no message bridge', async () => {
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html><body><p>mock</p></body></html>'));
    const renderer = render(<ArtifactViewerScreen attachment={attachment()} onClose={mocks.onClose} />);
    await flush();
    const webview = renderer.root.findByType('WebView');
    expect(webview.props.javaScriptEnabled).toBe(false);
    expect(webview.props.originWhitelist).toEqual([]);
    expect(webview.props.setSupportMultipleWindows).toBe(false);
    expect(webview.props.allowFileAccess).toBe(false);
    expect(Object.hasOwn(webview.props, 'onMessage')).toBe(false);
    expect(webview.props.scrollEnabled).toBe(true);
    // The wrapped source carries the CSP meta ahead of the page.
    const html = (webview.props.source as { html: string }).html;
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<body>'));
    // Closing is the header affordance only.
    await act(async () => {
      renderer.root.findByProps({ testID: 'artifact-viewer-close' }).props.onPress();
    });
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('the header clears the Android status tray: top inset over its own spacing', async () => {
    mocks.safeAreaTop.value = 42;
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html><body></body></html>'));
    const renderer = render(<ArtifactViewerScreen attachment={attachment()} onClose={mocks.onClose} />);
    await flush();
    // The header row is the parent of the ✕ control that closes the viewer.
    const header = renderer.root.findByProps({ testID: 'artifact-viewer-close' }).parent;
    const resolved = Object.assign(
      {},
      ...[header.props.style].flat(Infinity).filter(Boolean),
    ) as Record<string, unknown>;
    expect(resolved.paddingTop).toBe(mocks.safeAreaTop.value + theme.buzz.space.md);
    mocks.safeAreaTop.value = 0;
  });

  it('renders an SVG attachment on the browser-default canvas in the sandbox', async () => {
    mocks.fetchArtifactBytes.mockResolvedValue(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'),
    );
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType: 'image/svg+xml', name: 'mark.svg' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    const html = (renderer.root.findByType('WebView').props.source as { html: string }).html;
    expect(html).toContain(ARTIFACT_DEFAULT_CANVAS);
    // The transparent-page regression painted the SVG over the app ink plate.
    expect(html.includes('background:transparent')).toBe(false);
  });

  it('every navigation after the initial load is denied', async () => {
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html><body></body></html>'));
    const renderer = render(<ArtifactViewerSandbox attachment={attachment()} format="html" />);
    await flush();
    const webview = renderer.root.findByType('WebView');
    const guard = webview.props.onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    expect(guard({ url: 'about:blank' })).toBe(true);
    expect(guard({ url: 'https://evil.example/next' })).toBe(false);
  });

  it('renders markdown through the app renderer with its own scroll', async () => {
    mocks.fetchArtifactText.mockResolvedValue('# Heading');
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType: 'text/markdown', name: 'notes.md' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'artifact-viewer-markdown' })).toBeDefined();
    expect(renderer.root.findByType('MonoMarkdown')).toBeDefined();
  });

  it('on Android a PDF is one handoff to the system viewer, then the modal closes', async () => {
    mocks.platformOS.value = 'android';
    mocks.openArtifactInBrowserOrExplain.mockResolvedValue(undefined);
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType: 'application/pdf', name: 'spec.pdf' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'artifact-viewer-handoff' })).toBeDefined();
    expect(mocks.openArtifactInBrowserOrExplain).toHaveBeenCalled();
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('on iOS a PDF rides the local cache file in the sandbox', async () => {
    mocks.platformOS.value = 'ios';
    mocks.artifactPdfLocalUri.mockResolvedValue('file:///cache/artifact-pdf-x.pdf');
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType: 'application/pdf', name: 'spec.pdf' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    const webview = renderer.root.findByType('WebView');
    expect((webview.props.source as { uri: string }).uri).toBe('file:///cache/artifact-pdf-x.pdf');
    expect(webview.props.javaScriptEnabled).toBe(false);
  });

  it('a failed fetch is a spoken state, never a blank screen', async () => {
    mocks.fetchArtifactBytes.mockRejectedValue(new Error('404'));
    const renderer = render(<ArtifactViewerScreen attachment={attachment()} onClose={mocks.onClose} />);
    await flush();
    expect(renderer.root.findByProps({ testID: 'artifact-viewer-failed' })).toBeDefined();
  });

  it('a format with no inline preview is explained, never a blank screen', async () => {
    const renderer = render(
      <ArtifactViewerSandbox
        attachment={attachment({ mimeType: 'application/octet-stream', name: 'blob.bin' })}
        format="document"
      />,
    );
    await flush();
    const failed = renderer.root.findByProps({ testID: 'artifact-viewer-failed' });
    const text = failed.findByType('Text' as any).props.children;
    expect(text).toContain('no inline preview');
  });
});
