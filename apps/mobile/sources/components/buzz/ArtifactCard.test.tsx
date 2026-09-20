import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'android' as string },
  modalShow: vi.fn(),
  modalAlert: vi.fn(),
  probeArtifactPreview: vi.fn(),
  snapshotArtifactPreview: vi.fn(),
  resetArtifactPreviewCache: vi.fn(),
  fetchArtifactBytes: vi.fn(),
  fetchArtifactText: vi.fn(),
  openArtifactInBrowserOrExplain: vi.fn(),
  artifactPdfLocalUri: vi.fn(),
  artifactBase64: vi.fn(),
  loadPdfViewerDocument: vi.fn(),
  openArtifactInDesktopWorkPane: vi.fn(),
  webViewProps: vi.fn(async () => undefined),
}));

const webviewCreated: Record<string, unknown>[] = [];

vi.mock('react-native', () => {
  // Synchronous factory: react-native is already loaded in node for unit tests
  // and native modules are unavailable anyway. Return minimal stubs.
  const host = (name: string) => (props: Record<string, unknown>) => {
    if (name === 'WebView') webviewCreated.push(props);
    const children = props.children as React.ReactNode;
    // createElement is resolved lazily: React is loaded by now.
    return React.createElement(name, props, children);
  };
  return {
    Platform: {
      get OS() {
        return mocks.platformOS.value;
      },
      select: (choices: Record<string, unknown>) => choices.default,
    },
    Image: host('Image'),
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-webview', () => ({
  default: (props: Record<string, unknown>) => {
    webviewCreated.push(props);
    return React.createElement('WebView', props, null);
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) => factory({
      buzz: {
        border: '#333',
        bgBase: '#111',
        bgHighlight: '#222',
        textPrimary: '#eee',
        steel: '#888',
        ledgerQuiet: '#777',
        accent: '#b08a4a',
        space: { sm: 8, md: 12 },
        transcriptCard: { cornerRadius: 3, footerMinHeight: 40, footerVertical: 6, side: 12 },
        type: { body: {}, bodyStrong: {}, machine: {} },
      },
    }),
  },
}));
vi.mock('@/modal', () => ({
  Modal: { show: mocks.modalShow, alert: mocks.modalAlert },
}));
vi.mock('@/buzz/artifact-preview-cache', () => ({
  artifactPreviewCachePath: (id: string) => `file:///cache/artifact-preview-${id}.png`,
  probeArtifactPreview: mocks.probeArtifactPreview,
  snapshotArtifactPreview: mocks.snapshotArtifactPreview,
  resetArtifactPreviewCache: mocks.resetArtifactPreviewCache,
}));
vi.mock('@/buzz/artifact-link', () => ({
  artifactBase64: mocks.artifactBase64,
  artifactPdfLocalUri: mocks.artifactPdfLocalUri,
  fetchArtifactBytes: mocks.fetchArtifactBytes,
  fetchArtifactText: mocks.fetchArtifactText,
  openArtifactInBrowserOrExplain: mocks.openArtifactInBrowserOrExplain,
}));
// The generated document has its own suite; stubbing the loader here keeps the
// megabyte of vendored pdf.js source out of a card render.
vi.mock('@/buzz/artifact-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/artifact-pdf')>()),
  loadPdfViewerDocument: mocks.loadPdfViewerDocument,
}));
vi.mock('@/buzz/chat-attachment', () => ({
  formatAttachmentSize: (size: number) => `${(size / 1024).toFixed(1)} KB`,
}));
vi.mock('@/buzz/desktop-artifact-pane', () => ({
  openArtifactInDesktopWorkPane: mocks.openArtifactInDesktopWorkPane,
}));
vi.mock('@/components/buzz/MonoMarkdown', () => ({
  MonoMarkdown: (props: Record<string, unknown>) =>
    React.createElement('MonoMarkdown', props, null),
}));
vi.mock('@/components/buzz/ArtifactViewer', () => ({
  ArtifactViewerScreen: (props: Record<string, unknown>) =>
    React.createElement('ArtifactViewerScreen', props, null),
}));
// The media views have their own suites; here the card is on trial for which
// view it reaches for and what it hands it.
vi.mock('@/components/buzz/ArtifactMedia', () => ({
  ArtifactImage: (props: Record<string, unknown>) => React.createElement('ArtifactImage', props, null),
  ArtifactText: (props: Record<string, unknown>) => React.createElement('ArtifactText', props, null),
}));
vi.mock('@/components/buzz/ArtifactPdfView', () => ({
  ArtifactPdfView: (props: Record<string, unknown>) =>
    React.createElement('ArtifactPdfView', props, null),
}));

import { ArtifactCard } from './ArtifactCard';
import { createInitialLoadGuard } from '@/buzz/artifact';
import { ARTIFACT_PDF_BASE_URL, ARTIFACT_PDF_RENDERED_URL } from '@/buzz/artifact-pdf';

(globalThis as never as { __artifactMocks: unknown }).__artifactMocks = mocks;

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  webviewCreated.length = 0;
  mocks.platformOS.value = 'android';
  mocks.modalShow.mockClear();
  mocks.modalAlert.mockClear();
  mocks.probeArtifactPreview.mockReset();
  mocks.snapshotArtifactPreview.mockReset();
  mocks.resetArtifactPreviewCache.mockClear();
  mocks.fetchArtifactBytes.mockReset();
  mocks.fetchArtifactText.mockReset();
  mocks.openArtifactInBrowserOrExplain.mockReset();
  mocks.artifactPdfLocalUri.mockReset();
  mocks.artifactBase64.mockReset();
  mocks.loadPdfViewerDocument.mockReset();
  mocks.openArtifactInDesktopWorkPane.mockClear();
});

function artifactAttachment(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
    name: 'login-mock.html',
    mimeType: 'text/html',
    size: 2048,
    kind: 'artifact' as const,
    title: 'Login mock',
    author: 'hoots',
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

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll(
      (node: any) => typeof node.props.children === 'string' || Array.isArray(node.props.children),
    )
    .map((node: any) => (Array.isArray(node.props.children) ? node.props.children.join(' ') : node.props.children))
    .join(' | ');
}

/** Host-level node lookup: mocked RN components render a nested host twin with the same props. */
function hostNodes(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props.testID === testID,
  );
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

describe('the artifact card is the preview (mock 1b)', () => {
  it('renders an HTML artifact as caption (title, author, size) with the two footer actions and no status label', async () => {
    mocks.probeArtifactPreview.mockResolvedValue('file:///cache/artifact-preview-x.png');
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} authorHandle="hoots" />);
    await flush();
    const text = textOf(renderer);
    expect(text).toContain('Login mock');
    expect(text).toContain('@hoots');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('Open in browser');
    expect(text).toContain('Open');
    // The captain's rule: if you are showing it to me it is ready — no status word.
    expect(text).not.toMatch(/\b(ready|pending|failed)\b/i);
  });

  it('shows the cached snapshot instead of re-rendering the page', async () => {
    mocks.probeArtifactPreview.mockResolvedValue('file:///cache/artifact-preview-x.png');
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} />);
    await flush();
    expect(mocks.fetchArtifactBytes).not.toHaveBeenCalled();
    expect(renderer.root.findAll((n: any) => typeof n.type === 'string' && n.type === 'Image')).toHaveLength(1);
  });

  it('renders the page itself in the script-off sandbox once, then snapshots it', async () => {
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html><body><p>mock</p></body></html>'));
    mocks.snapshotArtifactPreview.mockResolvedValue('file:///cache/artifact-preview-x.png');
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} />);
    await flush();
    const webview = renderer.root.findByProps({ testID: 'artifact-preview-render' });
    expect(webview).toBeDefined();
    // The delayed-capture timer is the fallback for a load-end that never
    // fires; the WebView mock never calls onLoadEnd, so it is what fires here.
    await act(async () => {
      renderer.root.findByType('WebView').props.onLoadEnd();
      await Promise.resolve();
    });
    expect(mocks.snapshotArtifactPreview).toHaveBeenCalledWith(
      artifactAttachment().url,
      expect.anything(),
    );
  });

  it('renders markdown through the app message renderer', async () => {
    mocks.fetchArtifactText.mockResolvedValue('# Heading\n\nBody');
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'text/markdown', name: 'notes.md', title: 'Notes' })}
      />,
    );
    await flush();
    expect(renderer.root.findByType('MonoMarkdown')).toBeDefined();
    expect(textOf(renderer)).toContain('Notes');
  });

  // The audit found the Android card gave a PDF the file-style row and no
  // thumbnail at all. It renders page one through the pdf.js document now, and
  // snapshots it the same way markup is snapshotted.
  it('previews a PDF on Android through the pdf.js document, page one only', async () => {
    mocks.platformOS.value = 'android';
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.artifactBase64.mockResolvedValue('JVBERi0xLjQK');
    mocks.loadPdfViewerDocument.mockResolvedValue('<!doctype html><html>pdf</html>');
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'application/pdf', name: 'spec.pdf', title: 'Spec' })}
      />,
    );
    await flush();
    expect(mocks.artifactPdfLocalUri).not.toHaveBeenCalled();
    expect(mocks.loadPdfViewerDocument).toHaveBeenCalledWith({
      pdfBase64: 'JVBERi0xLjQK',
      mode: 'preview',
      signalRendered: true,
    });
    expect(renderer.root.findByProps({ testID: 'artifact-preview-render' })).toBeDefined();
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
    expect(hostNodes(renderer, 'artifact-open-browser')).toHaveLength(1);
  });

  it('gives the Android PDF document a real origin and the script it is made of', async () => {
    mocks.platformOS.value = 'android';
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.artifactBase64.mockResolvedValue('JVBERi0xLjQK');
    mocks.loadPdfViewerDocument.mockResolvedValue('<!doctype html><html>pdf</html>');
    render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'application/pdf', name: 'spec.pdf' })}
      />,
    );
    await flush();
    const props = webviewCreated.at(-1)!;
    expect(props.source).toEqual({
      html: '<!doctype html><html>pdf</html>',
      baseUrl: ARTIFACT_PDF_BASE_URL,
    });
    // The renderer itself is script; the rest of the sandbox table holds.
    expect(props.javaScriptEnabled).toBe(true);
    expect(props.originWhitelist).toEqual([]);
    expect(props.allowFileAccess).toBe(false);
    expect(Object.hasOwn(props, 'onMessage')).toBe(false);
  });

  // pdf.js paints well after the page's load event, so snapshotting on load
  // would cache a blank thumbnail. The document says when it is done instead,
  // through a navigation the guard refuses on its way past.
  it('snapshots the PDF thumbnail on the page cue, not on load end', async () => {
    mocks.platformOS.value = 'android';
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.artifactBase64.mockResolvedValue('JVBERi0xLjQK');
    mocks.loadPdfViewerDocument.mockResolvedValue('<!doctype html><html>pdf</html>');
    mocks.snapshotArtifactPreview.mockResolvedValue('file:///cache/artifact-preview-x.png');
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'application/pdf', name: 'spec.pdf' })}
      />,
    );
    await flush();
    const webview = renderer.root.findByType('WebView');
    expect(webview.props.onLoadEnd).toBeUndefined();
    expect(mocks.snapshotArtifactPreview).not.toHaveBeenCalled();
    const guard = webview.props.onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    await act(async () => {
      // The cue is a refused request; the refusal is the message.
      expect(guard({ url: ARTIFACT_PDF_RENDERED_URL })).toBe(false);
      await Promise.resolve();
    });
    expect(mocks.snapshotArtifactPreview).toHaveBeenCalledWith(
      artifactAttachment().url,
      expect.anything(),
    );
  });

  it.each([
    ['plain text', 'text/plain', 'notes.txt'],
    ['JSON', 'application/json', 'payload.json'],
    ['CSV', 'text/csv', 'rows.csv'],
  ])('crops %s onto the card instead of the file-style row', async (_name, mimeType, fileName) => {
    mocks.platformOS.value = 'android';
    const renderer = render(
      <ArtifactCard attachment={artifactAttachment({ mimeType, name: fileName, title: fileName })} />,
    );
    await flush();
    expect(renderer.root.findAll((node: any) => node.props.testID === 'artifact-document-body')).toHaveLength(0);
    const text = renderer.root.findByType('ArtifactText' as any);
    expect(text.props.crop).toBe(true);
    expect(text.props.testID).toBe('artifact-preview-text');
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
  });

  it('previews a PDF on iOS from the local cache file (first page)', async () => {
    mocks.platformOS.value = 'ios';
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.artifactPdfLocalUri.mockResolvedValue('file:///cache/artifact-pdf-x.pdf');
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'application/pdf', name: 'spec.pdf', title: 'Spec' })}
      />,
    );
    await flush();
    expect(mocks.artifactPdfLocalUri).toHaveBeenCalled();
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
  });

  it('an unknown format falls back to the document card with open-in-browser only', async () => {
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'application/zip', name: 'bundle.zip', title: 'Bundle' })}
      />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'artifact-document-body' })).toBeDefined();
    expect(hostNodes(renderer, 'artifact-open-browser')).toHaveLength(1);
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(0);
  });

  // The audit found a raster had no thumbnail on any surface — the card showed
  // the file-style row for a picture it could simply have painted.
  it('paints a photo as its own thumbnail, cropped to the card', async () => {
    mocks.platformOS.value = 'android';
    const photo = artifactAttachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
    const renderer = render(<ArtifactCard attachment={photo} />);
    await flush();
    expect(renderer.root.findAll((node: any) => node.props.testID === 'artifact-document-body')).toHaveLength(0);
    const image = renderer.root.findByType('ArtifactImage' as any);
    expect(image.props.fit).toBe('cover');
    expect(image.props.testID).toBe('artifact-preview-image');
    expect(image.props.attachment).toBe(photo);
  });

  it('offers an in-app viewer for a photo artifact', async () => {
    mocks.platformOS.value = 'android';
    const photo = artifactAttachment({ mimeType: 'image/jpeg', name: 'photo.jpg', title: 'Photo' });
    const renderer = render(<ArtifactCard attachment={photo} />);
    await flush();
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
    });
    expect(mocks.modalShow).toHaveBeenCalledWith(
      expect.objectContaining({
        component: expect.any(Function),
        props: expect.objectContaining({ attachment: photo }),
        placement: 'fill',
      }),
    );
    expect(mocks.openArtifactInBrowserOrExplain).not.toHaveBeenCalled();
  });

  // The audit found desktop had no image viewer at all: Open was gone and the
  // browser link was the only way to see the picture.
  it('opens a photo in the desktop work pane, with the browser link still there', async () => {
    mocks.platformOS.value = 'web';
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'image/png', name: 'photo.png' })}
        isDesktop
      />,
    );
    await flush();
    expect(renderer.root.findByType('ArtifactImage' as any)).toBeDefined();
    expect(hostNodes(renderer, 'artifact-open-browser')).toHaveLength(1);
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
    });
    expect(mocks.openArtifactInDesktopWorkPane).toHaveBeenCalled();
  });

  // The desktop host has no WebView to snapshot, so the card paints page one in
  // the frame itself rather than caching a thumbnail.
  it('previews a PDF on desktop in the frame, page one only', async () => {
    mocks.platformOS.value = 'web';
    mocks.probeArtifactPreview.mockResolvedValue(null);
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType: 'application/pdf', name: 'spec.pdf' })}
        isDesktop
      />,
    );
    await flush();
    const pdf = renderer.root.findByType('ArtifactPdfView' as any);
    expect(pdf.props.mode).toBe('preview');
    expect(pdf.props.testID).toBe('artifact-preview-pdf');
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
  });

  it('Open in browser mints the signed link at tap time; Open full screen shows the viewer', async () => {
    mocks.probeArtifactPreview.mockResolvedValue(null);
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} />);
    await flush();
    await act(async () => {
      hostNodes(renderer, 'artifact-open-browser')[0]!.props.onPress();
    });
    expect(mocks.openArtifactInBrowserOrExplain).toHaveBeenCalledWith(artifactAttachment());
    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
    });
    expect(mocks.modalShow).toHaveBeenCalled();
  });

  it('Open on desktop routes to the work pane, never the modal', async () => {
    mocks.probeArtifactPreview.mockResolvedValue(null);
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} isDesktop />);
    await flush();
    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
    });
    expect(mocks.modalShow).not.toHaveBeenCalled();
    expect(mocks.openArtifactInDesktopWorkPane).toHaveBeenCalled();
  });

  it('the sandbox props ride the preview render', async () => {
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html><body></body></html>'));
    render(<ArtifactCard attachment={artifactAttachment()} />);
    await flush();
    expect(webviewCreated.length).toBeGreaterThan(0);
    const props = webviewCreated[0]!;
    expect(props.javaScriptEnabled).toBe(false);
    expect(props.originWhitelist).toEqual([]);
    expect(props.setSupportMultipleWindows).toBe(false);
    expect(props.allowFileAccess).toBe(false);
    expect(Object.hasOwn(props, 'onMessage')).toBe(false);
  });

  it('the initial-load guard allows the first request and denies every later one', () => {
    const guard = createInitialLoadGuard();
    expect(guard.allow('about:blank')).toBe(true);
    expect(guard.allow('https://evil.example')).toBe(false);
  });
});
