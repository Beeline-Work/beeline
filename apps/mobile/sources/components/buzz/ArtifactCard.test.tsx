vi.mock('@/buzz/router-owner', () => ({ routerOwnerArtifactAction: vi.fn() }));
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'android' as string },
  modalShow: vi.fn(),
  modalAlert: vi.fn(),
  probeArtifactPreview: vi.fn(),
  artifactImageSource: vi.fn(),
  releaseArtifactImageSource: vi.fn(),
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
    create: (factory: (theme: unknown) => unknown) =>
      factory({
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
vi.mock('@/buzz/artifact-link', () => ({
  artifactImageSource: mocks.artifactImageSource,
  releaseArtifactImageSource: mocks.releaseArtifactImageSource,
  subscribeArtifactBytesPurge: () => () => {},
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
  ArtifactImage: (props: Record<string, unknown>) =>
    React.createElement('ArtifactImage', props, null),
  ArtifactText: (props: Record<string, unknown>) =>
    React.createElement('ArtifactText', props, null),
}));
vi.mock('@/components/buzz/ArtifactPdfView', () => ({
  ArtifactPdfView: (props: Record<string, unknown>) =>
    React.createElement('ArtifactPdfView', props, null),
}));

import { ArtifactCard } from './ArtifactCard';
import { ChevronGlyph } from './ChevronGlyph';
import { ExternalGlyph } from './ExternalGlyph';
import { createInitialLoadGuard } from '@/buzz/artifact';

(globalThis as never as { __artifactMocks: unknown }).__artifactMocks = mocks;

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
beforeEach(() => {
  webviewCreated.length = 0;
  mocks.platformOS.value = 'android';
  mocks.artifactImageSource.mockReset().mockResolvedValue({ uri: 'file:///cache/bounded-thumb.png' });
  mocks.releaseArtifactImageSource.mockClear();
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
    .map((node: any) =>
      Array.isArray(node.props.children) ? node.props.children.join(' ') : node.props.children,
    )
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

describe('bounded artifact previews', () => {
  it('calls the runnable file type Interactive in the card caption', async () => {
    mocks.probeArtifactPreview.mockResolvedValue('file:///cache/artifact-preview-x.png');
    const renderer = render(<ArtifactCard attachment={artifactAttachment({
      mimeType: 'application/vnd.beeline.game+html', title: 'After midnight',
    })} />);
    await flush();
    expect(textOf(renderer)).toContain('@hoots · Interactive · 2.0 KB');
    act(() => renderer.unmount());
  });

  it('renders an HTML artifact as caption (title, author, size) with the two footer actions and no status label', async () => {
    mocks.probeArtifactPreview.mockResolvedValue('file:///cache/artifact-preview-x.png');
    const renderer = render(
      <ArtifactCard attachment={artifactAttachment()} authorHandle="hoots" />,
    );
    await flush();
    const text = textOf(renderer);
    expect(text).toContain('Login mock');
    expect(text).toContain('@hoots');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('Open in browser');
    expect(text).not.toMatch(/[↗→]/);
    expect(renderer.root.findAll((node: any) => node.props.children === 'Open').length).toBeGreaterThan(0);
    // Drawn marks say where each goes: out to the browser, or into Beeline's viewer.
    expect(renderer.root.findAllByType(ExternalGlyph)).toHaveLength(1);
    expect(renderer.root.findAllByType(ChevronGlyph)).toHaveLength(1);
    // The captain's rule: if you are showing it to me it is ready — no status word.
    expect(text).not.toMatch(/\b(ready|pending|failed)\b/i);
  });

  // The v0.1.106 footer is the one true footer: quiet "Open in browser" with
  // the leaves-Beeline mark on the left, a spacer, and the accent "Open" with
  // a chevron on the right. PR 2959 gave
  // previewable artifacts a shorter inline "Open"; this pins the restore for
  // every card that shares ArtifactCardShell.
  it.each([
    ['image', 'image/png', 'photo.png', true],
    ['PDF', 'application/pdf', 'spec.pdf', true],
    ['HTML', 'text/html', 'mock.html', true],
    ['file', 'application/zip', 'bundle.zip', false],
  ])('shows the same v0.1.106 footer on an %s card', async (_name, mimeType, fileName, hasOpen) => {
    mocks.platformOS.value = 'android';
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.fetchArtifactBytes.mockResolvedValue(
      new TextEncoder().encode('<html><body><p>mock</p></body></html>'),
    );
    mocks.artifactBase64.mockResolvedValue('JVBERi0xLjQK');
    mocks.loadPdfViewerDocument.mockResolvedValue('<!doctype html><html>pdf</html>');
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType, name: fileName, title: fileName })}
      />,
    );
    await flush();
    const text = textOf(renderer);
    expect(text).toContain('Open in browser');
    expect(text).not.toMatch(/[↗→]/);
    expect(hostNodes(renderer, 'artifact-open-browser')).toHaveLength(1);
    expect(renderer.root.findAllByType(ExternalGlyph)).toHaveLength(1);
    // A document card has no in-app viewer, so its only action is the browser
    // link; every previewable card also gets the accent Open on the right.
    expect(renderer.root.findAllByType(ChevronGlyph)).toHaveLength(hasOpen ? 1 : 0);
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(hasOpen ? 1 : 0);
  });

  it('uses the current bounded thumbnail without probing the old screenshot cache', async () => {
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} />);
    await flush();
    expect(mocks.artifactImageSource).toHaveBeenCalledWith(artifactAttachment(), { signal: expect.any(AbortSignal), preview: true, thumbnail: true });
    expect(mocks.probeArtifactPreview).not.toHaveBeenCalled();
    expect(mocks.fetchArtifactBytes).not.toHaveBeenCalled();
    expect(renderer.root.findAll((n: any) => n.type === 'Image')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('keeps the existing placeholder when no bounded thumbnail exists', async () => {
    mocks.artifactImageSource.mockRejectedValue(new Error('A bounded preview is unavailable.'));
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} />);
    await flush();
    expect(hostNodes(renderer, 'artifact-preview-loading')).toHaveLength(1);
    expect(mocks.fetchArtifactBytes).not.toHaveBeenCalled();
    expect(webviewCreated).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('renders markdown through the app message renderer', async () => {
    mocks.fetchArtifactText.mockResolvedValue('# Heading\n\nBody');
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({
          mimeType: 'text/markdown',
          name: 'notes.md',
          title: 'Notes',
        })}
      />,
    );
    await flush();
    expect(renderer.root.findByType('MonoMarkdown')).toBeDefined();
    expect(textOf(renderer)).toContain('Notes');
  });

  it.each(['android', 'ios', 'web'])('uses a bounded PDF thumbnail on %s without loading the PDF renderer', async platform => {
    mocks.platformOS.value = platform;
    const file = artifactAttachment({ mimeType: 'application/pdf', name: 'spec.pdf' });
    const renderer = render(<ArtifactCard attachment={file} isDesktop={platform === 'web'} />);
    await flush();
    expect(mocks.artifactImageSource).toHaveBeenCalledWith(file, { signal: expect.any(AbortSignal), preview: true, thumbnail: true });
    expect(mocks.artifactBase64).not.toHaveBeenCalled(); expect(mocks.artifactPdfLocalUri).not.toHaveBeenCalled();
    expect(mocks.loadPdfViewerDocument).not.toHaveBeenCalled(); expect(webviewCreated).toHaveLength(0);
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1); act(() => renderer.unmount());
  });

  it('overscan rows start no preview work and abort the request when they leave the viewport', async () => {
    const file = artifactAttachment();
    const renderer = render(<ArtifactCard attachment={file} visible={false} />);
    await flush(); expect(mocks.artifactImageSource).not.toHaveBeenCalled();
    act(() => renderer.update(<ArtifactCard attachment={file} visible />)); await flush();
    const signal = mocks.artifactImageSource.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => renderer.update(<ArtifactCard attachment={file} visible={false} />));
    expect(signal.aborted).toBe(true); expect(mocks.artifactImageSource).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it.each([
    ['plain text', 'text/plain', 'notes.txt'],
    ['JSON', 'application/json', 'payload.json'],
    ['CSV', 'text/csv', 'rows.csv'],
  ])('crops %s onto the card instead of the file-style row', async (_name, mimeType, fileName) => {
    mocks.platformOS.value = 'android';
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({ mimeType, name: fileName, title: fileName })}
      />,
    );
    await flush();
    expect(
      renderer.root.findAll((node: any) => node.props.testID === 'artifact-document-body'),
    ).toHaveLength(0);
    const text = renderer.root.findByType('ArtifactText' as any);
    expect(text.props.crop).toBe(true);
    expect(text.props.testID).toBe('artifact-preview-text');
    expect(hostNodes(renderer, 'artifact-open')).toHaveLength(1);
  });



  it('an unknown format falls back to the document card with open-in-browser only', async () => {
    const renderer = render(
      <ArtifactCard
        attachment={artifactAttachment({
          mimeType: 'application/zip',
          name: 'bundle.zip',
          title: 'Bundle',
        })}
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
    expect(
      renderer.root.findAll((node: any) => node.props.testID === 'artifact-document-body'),
    ).toHaveLength(0);
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

  it('navigates a message photo group inside one card and opens the selected photo', async () => {
    mocks.platformOS.value = 'android';
    const first = artifactAttachment({
      url: 'https://usebeeline.app/v1/media/11111111-1111-4111-8111-111111111111',
      mimeType: 'image/jpeg',
      name: 'first.jpg',
      title: 'First',
    });
    const second = artifactAttachment({
      url: 'https://usebeeline.app/v1/media/22222222-2222-4222-8222-222222222222',
      mimeType: 'image/png',
      name: 'second.png',
      title: 'Second',
    });
    const renderer = render(<ArtifactCard attachment={first} photoAttachments={[first, second]} />);
    await flush();

    expect(hostNodes(renderer, 'artifact-photo-group')).toHaveLength(1);
    expect(renderer.root.findByType('ArtifactImage' as any).props.attachment).toBe(first);
    expect(hostNodes(renderer, 'artifact-photo-position')[0]!.props.children.join('')).toBe(
      '1 of 2',
    );
    expect(hostNodes(renderer, 'artifact-photo-position')[0]!.props.accessibilityLabel).toBe(
      'Photo 1 of 2',
    );
    expect(hostNodes(renderer, 'artifact-photo-previous')[0]!.props.style).toMatchObject({
      width: 44,
      height: 44,
    });

    await act(async () => {
      hostNodes(renderer, 'artifact-photo-next')[0]!.props.onPress();
    });
    expect(renderer.root.findByType('ArtifactImage' as any).props.attachment).toBe(second);
    expect(hostNodes(renderer, 'artifact-title')[0]!.props.children).toBe('Second');
    expect(hostNodes(renderer, 'artifact-photo-position')[0]!.props.children.join('')).toBe(
      '2 of 2',
    );

    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
      hostNodes(renderer, 'artifact-open-browser')[0]!.props.onPress();
    });
    expect(mocks.modalShow).toHaveBeenCalledWith(
      expect.objectContaining({ props: expect.objectContaining({ attachment: second, photoAttachments: [first, second] }) }),
    );
    expect(mocks.openArtifactInBrowserOrExplain).toHaveBeenCalledWith(second);

    await act(async () => {
      hostNodes(renderer, 'artifact-photo-previous')[0]!.props.onPress();
    });
    expect(renderer.root.findByType('ArtifactImage' as any).props.attachment).toBe(first);
  });

  it('does not add photo navigation to a single-photo card', async () => {
    const photo = artifactAttachment({ mimeType: 'image/jpeg', name: 'photo.jpg' });
    const renderer = render(<ArtifactCard attachment={photo} />);
    await flush();
    expect(hostNodes(renderer, 'artifact-photo-next')).toHaveLength(0);
    expect(hostNodes(renderer, 'artifact-photo-previous')).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'artifact-photo-position' })).toHaveLength(0);
  });

  // The desktop work pane is for documents: a picture opens the same centered
  // full-screen viewer mobile gets, with the browser link still on the card.
  it('opens a desktop photo in the centered viewer, with the browser link still there', async () => {
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
    expect(mocks.modalShow).toHaveBeenCalled();
    expect(mocks.openArtifactInDesktopWorkPane).not.toHaveBeenCalled();
  });

  // The desktop host has no WebView to snapshot, so the card paints page one in
  // the frame itself rather than caching a thumbnail.


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

  it('Open on desktop sends a document to the work pane, never the modal', async () => {
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.openArtifactInDesktopWorkPane.mockReturnValueOnce(true);
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} isDesktop />);
    await flush();
    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
    });
    expect(mocks.modalShow).not.toHaveBeenCalled();
    expect(mocks.openArtifactInDesktopWorkPane).toHaveBeenCalled();
  });

  it('Open on desktop falls back to the full-screen viewer when no work pane takes it', async () => {
    mocks.probeArtifactPreview.mockResolvedValue(null);
    mocks.openArtifactInDesktopWorkPane.mockReturnValueOnce(false);
    const renderer = render(<ArtifactCard attachment={artifactAttachment()} isDesktop />);
    await flush();
    await act(async () => {
      hostNodes(renderer, 'artifact-open')[0]!.props.onPress();
    });
    expect(mocks.openArtifactInDesktopWorkPane).toHaveBeenCalled();
    expect(mocks.modalShow).toHaveBeenCalled();
  });



  it('the initial-load guard allows the first request and denies every later one', () => {
    const guard = createInitialLoadGuard();
    expect(guard.allow('about:blank')).toBe(true);
    expect(guard.allow('https://evil.example')).toBe(false);
  });
});
