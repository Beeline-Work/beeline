import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'android' as string },
  artifactBase64: vi.fn(),
  loadPdfViewerDocument: vi.fn(),
  sandboxStatus: { value: 'ready' as string },
  sandboxWebView: { value: null as unknown },
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
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: { ledgerQuiet: '#777', space: { md: 12 }, type: { meta: {} } },
      }),
  },
}));
vi.mock('@/buzz/artifact-link', () => ({ artifactBase64: mocks.artifactBase64 }));
// The generated document has its own suite; stubbing the loader keeps the
// megabyte of vendored pdf.js source out of a component render.
vi.mock('@/buzz/artifact-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/artifact-pdf')>()),
  loadPdfViewerDocument: mocks.loadPdfViewerDocument,
}));
vi.mock('@/components/buzz/sandbox-webview', () => ({
  useSandboxWebView: () => mocks.sandboxWebView.value,
  useSandboxWebViewStatus: () => mocks.sandboxStatus.value,
}));

import { ARTIFACT_PDF_BASE_URL, ARTIFACT_PDF_FAILURE_TEXT } from '@/buzz/artifact-pdf';
import { ArtifactPdfView } from './ArtifactPdfView';

const WebViewStub = (props: Record<string, unknown>) => React.createElement('WebView', props, null);

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  mocks.platformOS.value = 'android';
  mocks.sandboxStatus.value = 'ready';
  mocks.sandboxWebView.value = WebViewStub;
  mocks.artifactBase64.mockReset();
  mocks.loadPdfViewerDocument.mockReset();
  mocks.artifactBase64.mockResolvedValue('JVBERi0xLjQK');
  mocks.loadPdfViewerDocument.mockResolvedValue('<!doctype html><html>pdf</html>');
});

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    kind: 'artifact' as const,
    title: 'Spec',
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('the Android PDF render', () => {
  it('gives the document a real origin and the script it is made of', async () => {
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    const webview = renderer.root.findByType('WebView' as any);
    expect(webview.props.source).toEqual({
      html: '<!doctype html><html>pdf</html>',
      baseUrl: ARTIFACT_PDF_BASE_URL,
    });
    // pdf.js inside an opaque origin never finishes loading; the base URL is
    // what keeps the page out of one.
    expect(webview.props.javaScriptEnabled).toBe(true);
  });

  it('keeps the rest of the sandbox table even with script on', async () => {
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    const webview = renderer.root.findByType('WebView' as any);
    expect(webview.props.originWhitelist).toEqual([]);
    expect(webview.props.setSupportMultipleWindows).toBe(false);
    expect(webview.props.allowFileAccess).toBe(false);
    expect(Object.hasOwn(webview.props, 'onMessage')).toBe(false);
  });

  it('allows the initial load and denies every request after it', async () => {
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    const guard = renderer.root.findByType('WebView' as any).props
      .onShouldStartLoadWithRequest as (request: { url: string }) => boolean;
    expect(guard({ url: ARTIFACT_PDF_BASE_URL })).toBe(true);
    expect(guard({ url: 'https://evil.example/next' })).toBe(false);
  });

  it('lets the reader scroll the whole file and holds the card crop still', async () => {
    const viewer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    expect(viewer.root.findByType('WebView' as any).props.scrollEnabled).toBe(true);
    const preview = render(<ArtifactPdfView attachment={attachment()} mode="preview" />);
    await flush();
    expect(preview.root.findByType('WebView' as any).props.scrollEnabled).toBe(false);
  });

  it('asks the document for page one on the card and the whole file in the viewer', async () => {
    render(<ArtifactPdfView attachment={attachment()} mode="preview" />);
    await flush();
    expect(mocks.loadPdfViewerDocument).toHaveBeenCalledWith({
      pdfBase64: 'JVBERi0xLjQK',
      mode: 'preview',
    });
    mocks.loadPdfViewerDocument.mockClear();
    render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    expect(mocks.loadPdfViewerDocument).toHaveBeenCalledWith({
      pdfBase64: 'JVBERi0xLjQK',
      mode: 'viewer',
    });
  });

  it('reports the render finished so the card can snapshot it', async () => {
    const onLoadEnd = vi.fn();
    const renderer = render(
      <ArtifactPdfView attachment={attachment()} mode="preview" onLoadEnd={onLoadEnd} />,
    );
    await flush();
    act(() => renderer.root.findByType('WebView' as any).props.onLoadEnd());
    expect(onLoadEnd).toHaveBeenCalled();
  });

  it('says so when the WebView the render needs is not there', async () => {
    mocks.sandboxWebView.value = null;
    mocks.sandboxStatus.value = 'unavailable';
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    const failed = renderer.root.findByProps({ testID: 'artifact-pdf-failed' });
    expect(failed.findByType('Text' as any).props.children).toBe(ARTIFACT_PDF_FAILURE_TEXT);
  });
});

describe('the desktop PDF render', () => {
  it('rides a blob URL, because a srcdoc origin leaves pdf.js hanging blank', async () => {
    mocks.platformOS.value = 'web';
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:https://app.usebeeline.app/pdf-1';
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    const frame = renderer.root.findByType('iframe' as any);
    expect(frame.props.src).toBe('blob:https://app.usebeeline.app/pdf-1');
    expect(frame.props.title).toBe('spec.pdf');
    expect(created[0]!.type).toBe('text/html');
    vi.unstubAllGlobals();
  });

  it('frees the blob URL when the frame goes away', async () => {
    mocks.platformOS.value = 'web';
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:https://app.usebeeline.app/pdf-2',
      revokeObjectURL,
    });
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    act(() => renderer.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.usebeeline.app/pdf-2');
    vi.unstubAllGlobals();
  });
});

describe('a PDF that cannot be fetched at all', () => {
  it('speaks the failure and names the way out, never a blank frame', async () => {
    mocks.artifactBase64.mockRejectedValue(new Error('404'));
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    await flush();
    const failed = renderer.root.findByProps({ testID: 'artifact-pdf-failed' });
    expect(failed.findByType('Text' as any).props.children).toBe(ARTIFACT_PDF_FAILURE_TEXT);
    expect(ARTIFACT_PDF_FAILURE_TEXT).toContain('Open in browser');
  });

  it('says it is loading while the bytes are still on the way', () => {
    mocks.artifactBase64.mockReturnValue(new Promise(() => {}));
    const renderer = render(<ArtifactPdfView attachment={attachment()} mode="viewer" />);
    expect(renderer.root.findByProps({ testID: 'artifact-pdf-loading' })).toBeDefined();
  });
});
