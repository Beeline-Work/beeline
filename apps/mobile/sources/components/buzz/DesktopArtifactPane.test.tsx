import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'web' as string },
  fetchArtifactBytes: vi.fn(),
  fetchArtifactText: vi.fn(),
  openArtifactInBrowserOrExplain: vi.fn(),
  copyPicture: vi.fn(async () => true),
  sharePicture: vi.fn(),
  showPictureActions: vi.fn(),
  onClose: vi.fn(),
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
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: {
    View: (props: Record<string, unknown>) =>
      React.createElement('AnimatedView', props, props.children as React.ReactNode),
  },
  FadeInDown: {},
  FadeOutDown: {},
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const theme = vi.hoisted(() => ({
  buzz: {
    border: '#333',
    bgBase: '#111',
    textPrimary: '#eee',
    ledgerQuiet: '#777',
    accent: '#b08a4a',
    space: { sm: 8, md: 12 },
    layout: { row: 64 },
    type: { body: {}, bodyStrong: {}, machine: {}, meta: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) => factory(theme),
  },
  useUnistyles: () => ({ theme }),
}));
vi.mock('@/buzz/artifact-link', () => ({
  fetchArtifactBytes: mocks.fetchArtifactBytes,
  fetchArtifactText: mocks.fetchArtifactText,
  openArtifactInBrowserOrExplain: mocks.openArtifactInBrowserOrExplain,
}));
vi.mock('@/buzz/picture-actions', () => ({
  copyPicture: mocks.copyPicture,
  sharePicture: mocks.sharePicture,
  showPictureActions: mocks.showPictureActions,
}));
vi.mock('@/buzz/chat-attachment', () => ({
  formatAttachmentSize: (size: number) => `${(size / 1024).toFixed(1)} KB`,
}));
vi.mock('@/components/buzz/MonoMarkdown', () => ({
  MonoMarkdown: (props: Record<string, unknown>) =>
    React.createElement('MonoMarkdown', props, null),
}));
// The media views have their own suites; here the pane is on trial for which
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

import { DesktopArtifactFrame, DesktopArtifactPane } from './DesktopArtifactPane';

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

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('the desktop work pane artifact view', () => {
  it('renders the page in a sandboxed iframe from srcdoc with no script origin', async () => {
    mocks.fetchArtifactBytes.mockResolvedValue(
      new TextEncoder().encode('<html><body><p>mock</p></body></html>'),
    );
    const renderer = render(<DesktopArtifactFrame attachment={attachment()} format="html" />);
    await flush();
    const frame = renderer.root.findByProps({ 'data-testid': 'desktop-artifact-frame' });
    // sandbox with neither allow-scripts nor allow-same-origin; bytes ride srcdoc.
    expect(frame.props.sandbox).toBe('');
    expect(frame.props.srcDoc as string).toContain('<p>mock</p>');
    expect(frame.props.srcDoc as string).toContain('Content-Security-Policy');
  });

  it('the pane carries the caption grammar and markdown renders through the app renderer', async () => {
    mocks.fetchArtifactText.mockResolvedValue('# Heading');
    const renderer = render(
      <DesktopArtifactPane
        attachment={attachment({ mimeType: 'text/markdown', name: 'notes.md', title: 'Notes' })}
        authorHandle="hoots"
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-markdown' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-title' }).props.children).toBe(
      'Notes',
    );
    expect(renderer.root.findByType('MonoMarkdown')).toBeDefined();
    expect(renderer.root.findByType('MonoMarkdown').props.document).toBe(true);
  });

  // The audit found the pane sent a PDF to the browser and had no way to paint
  // one at all. It renders the fitted pdf.js document now.
  it('renders a PDF in the pane rather than sending it to the browser', async () => {
    const renderer = render(
      <DesktopArtifactPane
        attachment={attachment({ mimeType: 'application/pdf', name: 'spec.pdf', title: 'Spec' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(
      renderer.root.findAll((node: any) => node.props.testID === 'desktop-artifact-handoff'),
    ).toHaveLength(0);
    const pdf = renderer.root.findByType('ArtifactPdfView' as any);
    // The whole file, not the card's page-one crop.
    expect(pdf.props.mode).toBe('viewer');
    expect(pdf.props.attachment.name).toBe('spec.pdf');
  });

  it('paints a raster in the pane, fitted rather than cropped', async () => {
    const photo = attachment({ mimeType: 'image/png', name: 'chart.png', title: 'Chart' });
    const renderer = render(<DesktopArtifactPane attachment={photo} onClose={mocks.onClose} />);
    await flush();
    const image = renderer.root.findByType('ArtifactImage' as any);
    expect(image.props.fit).toBe('contain');
    expect(image.props.testID).toBe('desktop-artifact-image');

    await act(async () => {
      renderer.root.findByProps({ testID: 'desktop-artifact-copy' }).props.onPress();
      renderer.root.findByProps({ testID: 'desktop-artifact-share' }).props.onPress();
      renderer.root.findByProps({ testID: 'desktop-artifact-image-actions' }).props.onContextMenu({
        preventDefault: vi.fn(),
      });
    });
    expect(mocks.copyPicture).toHaveBeenCalledWith(photo);
    expect(mocks.sharePicture).toHaveBeenCalledWith(photo);
    expect(mocks.showPictureActions).toHaveBeenCalledWith(photo);
  });

  it('confirms a copied picture with a toast, and reports a failed copy with a failure toast', async () => {
    vi.useFakeTimers();
    try {
      const photo = attachment({ mimeType: 'image/png', name: 'chart.png', title: 'Chart' });
      const renderer = render(<DesktopArtifactPane attachment={photo} onClose={mocks.onClose} />);
      await act(async () => {
        renderer.root.findByProps({ testID: 'desktop-artifact-copy' }).props.onPress();
        await Promise.resolve();
      });
      const toast = renderer.root.findByProps({ testID: 'desktop-artifact-copied' });
      expect(toast.findAllByType('Text' as any).map((t: any) => t.props.children)).toContain(
        'Image copied to clipboard',
      );
      act(() => vi.advanceTimersByTime(2000));
      expect(renderer.root.findAllByProps({ testID: 'desktop-artifact-copied' })).toHaveLength(0);

      mocks.copyPicture.mockResolvedValueOnce(false);
      await act(async () => {
        renderer.root.findByProps({ testID: 'desktop-artifact-copy' }).props.onPress();
        await Promise.resolve();
      });
      const failed = renderer.root.findByProps({ testID: 'desktop-artifact-copied' });
      expect(failed.findAllByType('Text' as any).map((t: any) => t.props.children)).toContain(
        "Couldn't copy image",
      );
      act(() => vi.advanceTimersByTime(2000));
      expect(renderer.root.findAllByProps({ testID: 'desktop-artifact-copied' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('zooms a desktop raster with the wheel and resets from an accessible control', () => {
    const renderer = render(
      <DesktopArtifactPane
        attachment={attachment({ mimeType: 'image/png' })}
        onClose={mocks.onClose}
      />,
    );
    const viewport = renderer.root.findByProps({ testID: 'desktop-artifact-image-viewport' });
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 500, height: 300 } } }));
    const preventDefault = vi.fn();
    act(() =>
      viewport.props.onWheel({
        preventDefault,
        nativeEvent: { deltaY: -200, offsetX: 250, offsetY: 150 },
      }),
    );
    expect(preventDefault).toHaveBeenCalled();
    act(() => {
      viewport.props.onPanResponderGrant({ nativeEvent: { pageX: 100, pageY: 100 } });
      viewport.props.onPanResponderMove({ nativeEvent: { pageX: 140, pageY: 100 } });
    });
    expect(
      renderer.root.findByProps({ testID: 'desktop-artifact-image-actions' }).props.style[1]
        .transform[0],
    ).toEqual({ translateX: 40 });
    const reset = renderer.root.findByProps({ testID: 'desktop-artifact-zoom-reset' });
    expect(reset.props.accessibilityLabel).toBe('Reset image zoom');
    expect(reset.props.disabled).toBe(false);
    act(() => reset.props.onPress());
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Image zoom 100 percent' }),
    ).toBeDefined();
  });

  it.each([
    ['plain text', 'text/plain', 'notes.txt'],
    ['JSON', 'application/json', 'payload.json'],
    ['CSV', 'text/csv', 'rows.csv'],
  ])('reads %s in the pane, whole and uncropped', async (_name, mimeType, fileName) => {
    const renderer = render(
      <DesktopArtifactPane
        attachment={attachment({ mimeType, name: fileName, title: fileName })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    const text = renderer.root.findByType('ArtifactText' as any);
    expect(text.props.crop).toBe(false);
    expect(text.props.testID).toBe('desktop-artifact-text');
  });

  it('a format the pane cannot paint is explained and keeps the browser path', async () => {
    mocks.openArtifactInBrowserOrExplain.mockClear();
    const renderer = render(
      <DesktopArtifactPane
        attachment={attachment({
          mimeType: 'application/zip',
          name: 'bundle.zip',
          title: 'Bundle',
        })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-handoff' })).toBeDefined();
    await act(async () => {
      renderer.root.findByProps({ testID: 'desktop-artifact-open-browser' }).props.onPress();
    });
    expect(mocks.openArtifactInBrowserOrExplain).toHaveBeenCalled();
  });

  // The fallback when a render fails, and the way out for a reader who wants
  // the file in a tab of their own — so it stays on every format, not only the
  // ones the pane cannot paint.
  it.each([
    ['markup', 'text/html'],
    ['markdown', 'text/markdown'],
    ['a raster', 'image/png'],
    ['plain text', 'text/plain'],
    ['a PDF', 'application/pdf'],
    ['an unknown format', 'application/zip'],
  ])('keeps Open in browser on %s', async (_name, mimeType) => {
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html></html>'));
    mocks.fetchArtifactText.mockResolvedValue('# Heading');
    const renderer = render(
      <DesktopArtifactPane attachment={attachment({ mimeType })} onClose={mocks.onClose} />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-open-browser' })).toBeDefined();
  });

  it('the close affordance clears the pane', async () => {
    const renderer = render(
      <DesktopArtifactPane attachment={attachment()} onClose={mocks.onClose} />,
    );
    await flush();
    await act(async () => {
      renderer.root.findByProps({ testID: 'desktop-artifact-close' }).props.onPress();
    });
    expect(mocks.onClose).toHaveBeenCalled();
  });
});
