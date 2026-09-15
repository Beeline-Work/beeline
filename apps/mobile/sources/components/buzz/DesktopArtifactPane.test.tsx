import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformOS: { value: 'web' as string },
  fetchArtifactBytes: vi.fn(),
  fetchArtifactText: vi.fn(),
  openArtifactInBrowserOrExplain: vi.fn(),
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
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: {
          border: '#333',
          bgBase: '#111',
          textPrimary: '#eee',
          ledgerQuiet: '#777',
          accent: '#b08a4a',
          space: { sm: 8, md: 12 },
          type: { body: {}, bodyStrong: {}, machine: {}, meta: {} },
        },
      }),
  },
}));
vi.mock('@/buzz/artifact-link', () => ({
  fetchArtifactBytes: mocks.fetchArtifactBytes,
  fetchArtifactText: mocks.fetchArtifactText,
  openArtifactInBrowserOrExplain: mocks.openArtifactInBrowserOrExplain,
}));
vi.mock('@/buzz/chat-attachment', () => ({
  formatAttachmentSize: (size: number) => `${(size / 1024).toFixed(1)} KB`,
}));
vi.mock('@/components/buzz/MonoMarkdown', () => ({
  MonoMarkdown: (props: Record<string, unknown>) => React.createElement('MonoMarkdown', props, null),
}));

import { DesktopArtifactFrame, DesktopArtifactPane } from './DesktopArtifactPane';

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
    mocks.fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode('<html><body><p>mock</p></body></html>'));
    const renderer = render(
      <DesktopArtifactFrame attachment={attachment()} format="html" />,
    );
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
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-title' }).props.children).toBe('Notes');
    expect(renderer.root.findByType('MonoMarkdown')).toBeDefined();
  });

  it('a PDF gets the browser handoff explanation, never an unsandboxed frame', async () => {
    const renderer = render(
      <DesktopArtifactPane
        attachment={attachment({ mimeType: 'application/pdf', name: 'spec.pdf', title: 'Spec' })}
        onClose={mocks.onClose}
      />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-handoff' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'desktop-artifact-open-browser' })).toBeDefined();
    await act(async () => {
      renderer.root.findByProps({ testID: 'desktop-artifact-open-browser' }).props.onPress();
    });
    expect(mocks.openArtifactInBrowserOrExplain).toHaveBeenCalled();
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
