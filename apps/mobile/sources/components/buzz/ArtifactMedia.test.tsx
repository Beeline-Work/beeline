import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  artifactImageSource: vi.fn(),
  purgeListeners: new Set<() => void>(),
  releaseArtifactImageSource: vi.fn(),
  fetchArtifactText: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    Image: host('Image'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: {
          textPrimary: '#eee',
          ledgerQuiet: '#777',
          space: { sm: 8, md: 12 },
          type: { machine: {}, meta: {} },
        },
      }),
  },
}));
vi.mock('@/buzz/artifact-link', () => ({
  subscribeArtifactBytesPurge: (_attachment: unknown, listener: () => void) => { mocks.purgeListeners.add(listener); return () => { mocks.purgeListeners.delete(listener); }; },
  artifactImageSource: mocks.artifactImageSource,
  releaseArtifactImageSource: mocks.releaseArtifactImageSource,
  fetchArtifactText: mocks.fetchArtifactText,
}));

import { resetClientState } from '@/sync/client-reset';
import { installMediaCacheConnection, mediaMetadataFor, suspendMediaCacheConnection } from '@/buzz/media-cache-connection';
import { ARTIFACT_TEXT_PREVIEW_LINES } from '@/buzz/artifact';
import { ArtifactImage, ArtifactText } from './ArtifactMedia';

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
  mocks.artifactImageSource.mockReset();
  mocks.purgeListeners.clear();
  mocks.releaseArtifactImageSource.mockReset();
  mocks.fetchArtifactText.mockReset();
});

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    size: 2048,
    kind: 'artifact' as const,
    title: 'Photo',
    ...overrides,
  };
}

const mountedRenderers: ReactTestRenderer[] = [];
afterEach(() => { act(() => mountedRenderers.splice(0).forEach(tree => tree.unmount())); });

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
    mountedRenderers.push(renderer);
  });
  return renderer;
}

/** Host-level lookup: the mocked RN components render a host twin with the same props. */
function hostNode(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.find(
    (node: any) => typeof node.type === 'string' && node.props.testID === testID,
  );
}

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('the raster artifact view', () => {
  it('paints the file through the app session at the fit it was given', async () => {
    const source = {
      uri: 'https://server.usebeeline.app/v1/media/x',
      headers: { authorization: 'Bearer t' },
    };
    mocks.artifactImageSource.mockResolvedValue(source);
    const renderer = render(
      <ArtifactImage attachment={attachment()} fit="contain" testID="artifact-image" />,
    );
    await flush();
    const image = hostNode(renderer, 'artifact-image');
    expect(image.props.source).toEqual(source);
    expect(image.props.resizeMode).toBe('contain');
    expect(image.props.accessibilityLabel).toBe('Photo');
  });

  it('reports intrinsic size from native and browser image load events', async () => {
    mocks.artifactImageSource.mockResolvedValue({ uri: 'blob:x' });
    const onLoadImageSize = vi.fn();
    const renderer = render(
      <ArtifactImage
        attachment={attachment()}
        fit="contain"
        onLoadImageSize={onLoadImageSize}
        testID="artifact-image"
      />,
    );
    await flush();
    const image = hostNode(renderer, 'artifact-image');
    act(() => image.props.onLoad({ nativeEvent: { source: { width: 800, height: 200 } } }));
    act(() =>
      image.props.onLoad({ nativeEvent: { target: { naturalWidth: 640, naturalHeight: 480 } } }),
    );
    expect(onLoadImageSize.mock.calls).toEqual([
      [800, 200],
      [640, 480],
    ]);
  });

  it('falls back to the file name when the artifact was posted without a title', async () => {
    mocks.artifactImageSource.mockResolvedValue({ uri: 'blob:x' });
    const renderer = render(
      <ArtifactImage
        attachment={attachment({ title: undefined, name: 'chart.png' })}
        fit="cover"
        testID="artifact-image"
      />,
    );
    await flush();
    expect(hostNode(renderer, 'artifact-image').props.accessibilityLabel).toBe('chart.png');
  });

  it('says it is loading, then says it failed — never a blank box', async () => {
    let settle!: (source: { uri: string }) => void;
    mocks.artifactImageSource.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const renderer = render(
      <ArtifactImage attachment={attachment()} fit="cover" testID="artifact-image" />,
    );
    expect(renderer.root.findByProps({ testID: 'artifact-image-loading' })).toBeDefined();
    await act(async () => {
      settle({ uri: 'blob:x' });
      await Promise.resolve();
    });
    // A decode failure after the bytes arrive is spoken too.
    await act(async () => {
      hostNode(renderer, 'artifact-image').props.onError();
    });
    const failed = renderer.root.findByProps({ testID: 'artifact-image-failed' });
    expect(failed.findByType('Text' as any).props.children).toContain('could not be loaded');
  });

  it('speaks a fetch that never arrives', async () => {
    mocks.artifactImageSource.mockRejectedValue(new Error('403'));
    const renderer = render(
      <ArtifactImage attachment={attachment()} fit="cover" testID="artifact-image" />,
    );
    await flush();
    expect(renderer.root.findByProps({ testID: 'artifact-image-failed' })).toBeDefined();
  });

  // On web the source is an object URL; leaving it unreleased leaks the file's
  // bytes for the lifetime of the document.
  it('releases the source when the view goes away', async () => {
    const source = { uri: 'blob:https://app.usebeeline.app/artifact-1' };
    mocks.artifactImageSource.mockResolvedValue(source);
    const renderer = render(
      <ArtifactImage attachment={attachment()} fit="cover" testID="artifact-image" />,
    );
    await flush();
    act(() => renderer.unmount());
    expect(mocks.releaseArtifactImageSource).toHaveBeenCalledWith(source);
  });

  it('a committed removal aborts and clears the current image without reloading it', async () => {
    const source = { uri: 'blob:private-image' }; mocks.artifactImageSource.mockResolvedValue(source);
    const renderer = render(<ArtifactImage attachment={attachment()} fit="contain" testID="artifact-image" />);
    await flush(); const signal = mocks.artifactImageSource.mock.calls[0]![1].signal as AbortSignal;
    act(() => { for (const clear of mocks.purgeListeners) clear(); });
    expect(signal.aborted).toBe(true); expect(mocks.releaseArtifactImageSource).toHaveBeenCalledWith(source);
    expect(renderer.root.findAll((node: any) => node.type === 'Image')).toHaveLength(0);
    expect(mocks.artifactImageSource).toHaveBeenCalledTimes(1); act(() => renderer.unmount());
  });

  it('a healthy capable reconnect retries a parked visible source once, without remount or a fabricated focus', async () => {
    mocks.artifactImageSource.mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue({ uri: 'blob:recovered' });
    const renderer = render(<ArtifactImage attachment={attachment()} fit="contain" testID="artifact-image" />);
    await flush(); expect(renderer.root.findAllByProps({ testID: 'artifact-image-failed' }).length).toBeGreaterThan(0);
    const connection = { origin: 'https://synthetic.test', principal: 'reader', generation: 10, mediaMetadataV1: true, executeMetadata: async () => { throw new Error('not used by mocked bytes'); } };
    act(() => { installMediaCacheConnection(connection); }); await flush();
    expect(hostNode(renderer, 'artifact-image').props.source.uri).toBe('blob:recovered');
    expect(mocks.artifactImageSource).toHaveBeenCalledTimes(2);
    act(() => { installMediaCacheConnection(connection); }); await flush();
    expect(mocks.artifactImageSource).toHaveBeenCalledTimes(2);
    act(() => { suspendMediaCacheConnection(); }); await flush();
    expect(mocks.artifactImageSource).toHaveBeenCalledTimes(2);
  });

  it('a visible old-server source recovers once after explicit legacy negotiation without a metadata read or remount', async () => {
    resetClientState();
    mocks.artifactImageSource.mockImplementation(async () => {
      await mediaMetadataFor('https://synthetic.test', 'reader', '11111111-1111-4111-8111-111111111111');
      return { uri: 'blob:legacy-recovered' };
    });
    const renderer = render(<ArtifactImage attachment={attachment()} fit="contain" testID="artifact-image" />);
    await flush(); expect(renderer.root.findAllByProps({ testID: 'artifact-image-failed' }).length).toBeGreaterThan(0);
    const executeMetadata = vi.fn(async () => { throw new Error('Legacy must not send metadata JSON.'); });
    const receipt = { origin: 'https://synthetic.test', principal: 'reader', generation: 1, mediaMetadataV1: false, executeMetadata };
    act(() => { installMediaCacheConnection(receipt); }); await flush();
    expect(hostNode(renderer, 'artifact-image').props.source.uri).toBe('blob:legacy-recovered');
    expect(mocks.artifactImageSource).toHaveBeenCalledTimes(2); expect(executeMetadata).not.toHaveBeenCalled();
    act(() => { installMediaCacheConnection(receipt); }); await flush();
    expect(mocks.artifactImageSource).toHaveBeenCalledTimes(2);
  });

  it('releases a source that lands after the view is already gone', async () => {
    const source = { uri: 'blob:https://app.usebeeline.app/artifact-2' };
    let settle!: (value: { uri: string }) => void;
    mocks.artifactImageSource.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const renderer = render(
      <ArtifactImage attachment={attachment()} fit="cover" testID="artifact-image" />,
    );
    act(() => renderer.unmount());
    await act(async () => {
      settle(source);
      await Promise.resolve();
    });
    expect(mocks.releaseArtifactImageSource).toHaveBeenCalledWith(source);
  });
});

describe('the plain-text artifact view', () => {
  const file = Array.from({ length: 40 }, (_, line) => `line ${line + 1}`).join('\n');

  it('crops the card to what the preview box can show', async () => {
    mocks.fetchArtifactText.mockResolvedValue(file);
    const renderer = render(
      <ArtifactText
        attachment={attachment({ mimeType: 'text/plain', name: 'notes.txt' })}
        crop
        testID="artifact-text"
      />,
    );
    await flush();
    const body = hostNode(renderer, 'artifact-text').findByType('Text' as any);
    expect((body.props.children as string).split('\n')).toHaveLength(ARTIFACT_TEXT_PREVIEW_LINES);
    expect(body.props.children).not.toContain('line 40');
  });

  it('reads the whole file in the viewer, scrollable and selectable', async () => {
    mocks.fetchArtifactText.mockResolvedValue(file);
    const renderer = render(
      <ArtifactText
        attachment={attachment({ mimeType: 'text/plain', name: 'notes.txt' })}
        crop={false}
        testID="artifact-text"
      />,
    );
    await flush();
    const scroll = hostNode(renderer, 'artifact-text');
    expect(scroll.type).toBe('ScrollView');
    const body = scroll.findByType('Text' as any);
    expect(body.props.children).toBe(file);
    expect(body.props.selectable).toBe(true);
  });

  // No reformatting and no highlighting: a JSON artifact reads as the author
  // wrote it, and a CSV's columns stay the columns in the file.
  it.each([
    ['JSON', '{\n  "a": 1,\n  "b": [2, 3]\n}'],
    ['CSV', 'name,count\nhoots,3\nmilo,4'],
  ])('leaves %s exactly as the file has it', async (_name, content) => {
    mocks.fetchArtifactText.mockResolvedValue(content);
    const renderer = render(
      <ArtifactText attachment={attachment()} crop={false} testID="artifact-text" />,
    );
    await flush();
    expect(hostNode(renderer, 'artifact-text').findByType('Text' as any).props.children).toBe(
      content,
    );
  });

  it('says it is loading, then says it failed — never a blank box', async () => {
    let reject!: (error: Error) => void;
    mocks.fetchArtifactText.mockReturnValue(new Promise((_resolve, no) => (reject = no)));
    const renderer = render(<ArtifactText attachment={attachment()} crop testID="artifact-text" />);
    expect(renderer.root.findByProps({ testID: 'artifact-text-loading' })).toBeDefined();
    await act(async () => {
      reject(new Error('404'));
      await Promise.resolve();
    });
    const failed = renderer.root.findByProps({ testID: 'artifact-text-failed' });
    expect(failed.findByType('Text' as any).props.children).toContain('could not be loaded');
  });

  it('paints an empty file as an empty body, not as a stuck loading line', async () => {
    mocks.fetchArtifactText.mockResolvedValue('');
    const renderer = render(<ArtifactText attachment={attachment()} crop testID="artifact-text" />);
    await flush();
    expect(
      renderer.root.findAll((node: any) => node.props.testID === 'artifact-text-loading'),
    ).toHaveLength(0);
    expect(hostNode(renderer, 'artifact-text')).toBeDefined();
  });
});
