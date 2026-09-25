import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'android' as string },
  safeAreaTop: { value: 42 },
  artifactImageSource: vi.fn(),
  fetchArtifactBytes: vi.fn(),
  fetchArtifactText: vi.fn(),
  openArtifactInBrowserOrExplain: vi.fn(),
  artifactPdfLocalUri: vi.fn(),
  copyPicture: vi.fn(async () => true),
  sharePicture: vi.fn(),
  showPictureActions: vi.fn(),
  copyText: vi.fn(async () => true),
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
    layout: { row: 64 },
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
    PanResponder: { create: (handlers: Record<string, unknown>) => ({ panHandlers: handlers }) },
    Image: host('Image'),
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
  artifactImageSource: mocks.artifactImageSource,
  artifactPdfLocalUri: mocks.artifactPdfLocalUri,
  fetchArtifactBytes: mocks.fetchArtifactBytes,
  fetchArtifactText: mocks.fetchArtifactText,
  openArtifactInBrowserOrExplain: mocks.openArtifactInBrowserOrExplain,
}));
vi.mock('@/buzz/picture-actions', () => ({
  copyPicture: mocks.copyPicture,
  sharePicture: mocks.sharePicture,
  showPictureActions: mocks.showPictureActions,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copyText }));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: (props: Record<string, unknown>) =>
      React.createElement('AnimatedView', props, props.children as React.ReactNode),
  },
  FadeInDown: {},
  FadeOutDown: {},
}));
vi.mock('@/components/buzz/MonoMarkdown', () => ({
  MonoMarkdown: (props: Record<string, unknown>) =>
    React.createElement('MonoMarkdown', props, null),
}));
vi.mock('@/components/buzz/CodeHighlighter', () => ({
  CodeHighlighter: (props: Record<string, unknown>) =>
    React.createElement('CodeHighlighter', props, null),
}));
// The media views have their own suites; here the viewer is on trial for which
// view it reaches for and what it hands it.
vi.mock('@/components/buzz/ArtifactMedia', () => ({
  ArtifactImage: (props: Record<string, unknown>) =>
    React.createElement('ArtifactImage', props, null),
  ArtifactText: (props: Record<string, unknown>) =>
    React.createElement('ArtifactText', props, null),
}));
vi.mock('@/components/buzz/ArtifactPdfView', () => ({
  ArtifactPdfView: (props: Record<string, unknown>) =>
    React.createElement('ArtifactPdfView', props, null),
}));

import { ARTIFACT_DEFAULT_CANVAS } from '@/buzz/artifact';
import { ArtifactViewerSandbox, ArtifactViewerScreen } from './ArtifactViewer';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
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
  it('renders code in the existing viewer shell and copies the complete document', async () => {
    mocks.copyText.mockClear();
    const document = {
      type: 'code' as const,
      title: 'typescript',
      inscription: 'typescript · 2 lines · 24 B',
      code: 'const first = 1;\nsecond();',
      language: 'typescript',
    };
    const renderer = render(<ArtifactViewerScreen document={document} onClose={mocks.onClose} />);

    expect(renderer.root.findByProps({ testID: 'artifact-viewer-code' })).toBeDefined();
    expect(renderer.root.findByType('CodeHighlighter').props).toMatchObject({
      code: document.code,
      language: 'typescript',
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'artifact-viewer-copy' }).props.onPress();
      await Promise.resolve();
    });
    expect(mocks.copyText).toHaveBeenCalledWith(document.code);
    const toast = renderer.root.findByProps({ testID: 'artifact-viewer-copied' });
    expect(toast.findAllByType('Text' as any).map((t: any) => t.props.children)).toContain(
      'Code copied to clipboard',
    );
  });

  it('confirms a copied picture with a toast that dismisses itself', async () => {
    vi.useFakeTimers();
    try {
      const photo = attachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
      const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
      await act(async () => {
        renderer.root.findByProps({ testID: 'artifact-viewer-copy' }).props.onPress();
        await Promise.resolve();
      });
      const toast = renderer.root.findByProps({ testID: 'artifact-viewer-copied' });
      expect(toast.findAllByType('Text' as any).map((t: any) => t.props.children)).toContain(
        'Image copied to clipboard',
      );
      act(() => vi.advanceTimersByTime(2000));
      expect(renderer.root.findAllByProps({ testID: 'artifact-viewer-copied' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed picture copy with a failure toast that dismisses itself', async () => {
    vi.useFakeTimers();
    try {
      mocks.copyPicture.mockResolvedValueOnce(false);
      const photo = attachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
      const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
      await act(async () => {
        renderer.root.findByProps({ testID: 'artifact-viewer-copy' }).props.onPress();
        await Promise.resolve();
      });
      const toast = renderer.root.findByProps({ testID: 'artifact-viewer-copied' });
      const texts = toast.findAllByType('Text' as any).map((t: any) => t.props.children);
      expect(texts).toContain("Couldn't copy image");
      expect(texts).toContain('!');
      act(() => vi.advanceTimersByTime(2000));
      expect(renderer.root.findAllByProps({ testID: 'artifact-viewer-copied' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['resolves false', () => mocks.copyText.mockResolvedValueOnce(false)],
    ['rejects', () => mocks.copyText.mockRejectedValueOnce(new Error('denied'))],
  ])('reports a failed code copy with a failure toast when the clipboard %s', async (_name, fail) => {
    fail();
    const document = {
      type: 'code' as const,
      title: 'typescript',
      inscription: 'typescript · 1 line · 8 B',
      code: 'second()',
      language: 'typescript',
    };
    const renderer = render(<ArtifactViewerScreen document={document} onClose={mocks.onClose} />);
    await act(async () => {
      renderer.root.findByProps({ testID: 'artifact-viewer-copy' }).props.onPress();
      await Promise.resolve();
    });
    const toast = renderer.root.findByProps({ testID: 'artifact-viewer-copied' });
    expect(toast.findAllByType('Text' as any).map((t: any) => t.props.children)).toContain(
      "Couldn't copy code",
    );
  });

  it('renders HTML in the sandboxed WebView: script off, guarded, no message bridge', async () => {
    mocks.fetchArtifactBytes.mockResolvedValue(
      new TextEncoder().encode('<html><body><p>mock</p></body></html>'),
    );
    const renderer = render(
      <ArtifactViewerScreen attachment={attachment()} onClose={mocks.onClose} />,
    );
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
    mocks.fetchArtifactBytes.mockResolvedValue(
      new TextEncoder().encode('<html><body></body></html>'),
    );
    const renderer = render(
      <ArtifactViewerScreen attachment={attachment()} onClose={mocks.onClose} />,
    );
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
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>',
      ),
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

  it('fits a photo to the screen in-app, never handing it to the browser', async () => {
    const photo = attachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
    const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
    await flush();
    const image = renderer.root.findByType('ArtifactImage' as any);
    expect(image.props.fit).toBe('contain');
    expect(image.props.testID).toBe('artifact-viewer-image');
    expect(image.props.attachment).toBe(photo);
    expect(mocks.openArtifactInBrowserOrExplain).not.toHaveBeenCalled();
  });

  it('offers labeled zoom controls and restores the fitted view', () => {
    const photo = attachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
    const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
    const plus = renderer.root.findByProps({ testID: 'artifact-viewer-zoom-in' });
    const minus = renderer.root.findByProps({ testID: 'artifact-viewer-zoom-out' });
    const reset = renderer.root.findByProps({ testID: 'artifact-viewer-zoom-reset' });
    expect(plus.props.accessibilityLabel).toBe('Zoom in');
    expect(minus.props.accessibilityState.disabled).toBe(true);
    act(() => plus.props.onPress());
    expect(minus.props.accessibilityState.disabled).toBe(false);
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Image zoom 150 percent' }),
    ).toBeDefined();
    act(() => reset.props.onPress());
    expect(minus.props.accessibilityState.disabled).toBe(true);
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Image zoom 100 percent' }),
    ).toBeDefined();
  });

  it('pinches to zoom and pans within the image viewport', () => {
    const photo = attachment({ mimeType: 'image/jpeg', name: 'photo.jpg' });
    const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
    const viewport = renderer.root.findByProps({ testID: 'artifact-viewer-image-viewport' });
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 400, height: 300 } } }));
    const point = (x: number, y: number) => ({ pageX: x, pageY: y });
    act(() => {
      viewport.props.onPanResponderGrant({
        nativeEvent: { touches: [point(100, 100), point(200, 100)] },
      });
      viewport.props.onPanResponderMove({
        nativeEvent: { touches: [point(50, 100), point(250, 100)] },
      });
    });
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Image zoom 200 percent' }),
    ).toBeDefined();
    act(() => {
      viewport.props.onPanResponderRelease();
      viewport.props.onPanResponderGrant({ nativeEvent: { touches: [point(100, 100)] } });
      viewport.props.onPanResponderMove({ nativeEvent: { touches: [point(180, 100)] } });
    });
    const image = renderer.root.findByProps({ testID: 'artifact-viewer-image-actions' });
    expect(image.props.style[1].transform).toEqual([
      { translateX: 80 },
      { translateY: 0 },
      { scale: 2 },
    ]);
  });

  it('zooms with the desktop wheel and allows reset', () => {
    mocks.platformOS.value = 'web';
    try {
      const photo = attachment({ mimeType: 'image/png', name: 'photo.png' });
      const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
      const viewport = renderer.root.findByProps({ testID: 'artifact-viewer-image-viewport' });
      act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 400, height: 300 } } }));
      const preventDefault = vi.fn();
      act(() =>
        viewport.props.onWheel({
          preventDefault,
          nativeEvent: { deltaY: -200, offsetX: 200, offsetY: 150 },
        }),
      );
      expect(preventDefault).toHaveBeenCalled();
      expect(
        renderer.root.findByProps({ testID: 'artifact-viewer-zoom-reset' }).props.disabled,
      ).toBe(false);
      act(() =>
        renderer.root.findByProps({ testID: 'artifact-viewer-zoom-reset' }).props.onPress(),
      );
      expect(
        renderer.root.findByProps({ accessibilityLabel: 'Image zoom 100 percent' }),
      ).toBeDefined();
    } finally {
      mocks.platformOS.value = 'android';
    }
  });

  it('gives a full-screen picture the same direct copy, share, and long-press actions', async () => {
    const photo = attachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
    const renderer = render(<ArtifactViewerScreen attachment={photo} onClose={mocks.onClose} />);
    await flush();

    await act(async () => {
      renderer.root.findByProps({ testID: 'artifact-viewer-copy' }).props.onPress();
      renderer.root.findByProps({ testID: 'artifact-viewer-share' }).props.onPress();
      renderer.root.findByProps({ testID: 'artifact-viewer-image-actions' }).props.onLongPress();
    });

    expect(mocks.copyPicture).toHaveBeenCalledWith(photo);
    expect(mocks.sharePicture).toHaveBeenCalledWith(photo);
    expect(mocks.showPictureActions).toHaveBeenCalledWith(photo);
  });

  it('does not add picture controls to other full-screen artifacts', async () => {
    mocks.fetchArtifactText.mockResolvedValue('notes');
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType: 'text/plain', name: 'notes.txt' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(renderer.root.findAllByProps({ testID: 'artifact-viewer-copy' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'artifact-viewer-share' })).toHaveLength(0);
  });

  it.each([
    ['plain text', 'text/plain', 'notes.txt'],
    ['JSON', 'application/json', 'payload.json'],
    ['CSV', 'text/csv', 'rows.csv'],
  ])('reads %s in-app, whole and uncropped', async (_name, mimeType, fileName) => {
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType, name: fileName })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    const text = renderer.root.findByType('ArtifactText' as any);
    expect(text.props.crop).toBe(false);
    expect(text.props.testID).toBe('artifact-viewer-text');
    expect(mocks.openArtifactInBrowserOrExplain).not.toHaveBeenCalled();
  });

  it('every navigation after the initial load is denied', async () => {
    mocks.fetchArtifactBytes.mockResolvedValue(
      new TextEncoder().encode('<html><body></body></html>'),
    );
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
    expect(renderer.root.findByType('MonoMarkdown').props.document).toBe(true);
  });

  // The audit found Android had no PDF viewer: opening one threw the reader
  // out to a browser tab and shut the modal behind them.
  it('on Android a PDF renders in the viewer instead of bouncing out to the browser', async () => {
    mocks.platformOS.value = 'android';
    mocks.openArtifactInBrowserOrExplain.mockClear();
    mocks.onClose.mockClear();
    const renderer = render(
      <ArtifactViewerScreen
        attachment={attachment({ mimeType: 'application/pdf', name: 'spec.pdf' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    const pdf = renderer.root.findByType('ArtifactPdfView' as any);
    // The whole file, not the card's page-one crop.
    expect(pdf.props.mode).toBe('viewer');
    expect(pdf.props.testID).toBe('artifact-viewer-pdf');
    expect(mocks.openArtifactInBrowserOrExplain).not.toHaveBeenCalled();
    expect(mocks.onClose).not.toHaveBeenCalled();
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
    const renderer = render(
      <ArtifactViewerScreen attachment={attachment()} onClose={mocks.onClose} />,
    );
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
