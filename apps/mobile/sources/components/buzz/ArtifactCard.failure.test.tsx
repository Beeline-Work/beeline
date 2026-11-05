import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bytes = vi.hoisted(() => ({ image: vi.fn(), text: vi.fn(), full: vi.fn() }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Image: host('Image'), Pressable: host('Pressable'), Text: host('Text'), View: host('View'), Platform: { OS: 'android' } };
});
vi.mock('./IndexRow', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { IndexRow: host('IndexRow'), InlineRow: host('InlineRow'), ContentTarget: host('ContentTarget') };
});
vi.mock('./Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
vi.mock('@/buzz/use-artifact-recovery', () => ({ useArtifactRecoveryGeneration: () => 0 }));
vi.mock('@/buzz/chat-attachment', () => ({ formatAttachmentSize: () => '2 KB' }));
vi.mock('@/buzz/router-owner', () => ({ routerOwnerArtifactAction: vi.fn() }));
vi.mock('@/buzz/artifact-link', () => ({
  artifactImageSource: bytes.image, fetchArtifactText: bytes.text, fetchArtifactBytes: bytes.full,
  releaseArtifactImageSource: vi.fn(), subscribeArtifactBytesPurge: () => () => {},
  openArtifactInBrowserOrExplain: vi.fn(),
}));
vi.mock('@/buzz/desktop-artifact-pane', () => ({ openArtifactInDesktopWorkPane: vi.fn() }));
vi.mock('@/buzz/viewer-conversation', () => ({ currentViewerConversation: () => null }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), alert: vi.fn() } }));
vi.mock('./ArtifactMedia', () => ({ ArtifactImage: () => null, ArtifactText: () => null }));
vi.mock('./ArtifactViewer', () => ({ ArtifactViewerScreen: () => null }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: () => null }));
import { ArtifactCard } from './ArtifactCard';

const attachment = {
  url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
  name: 'preview.html', mimeType: 'text/html', size: 2048, kind: 'artifact' as const,
};
const failed = (tree: ReactTestRenderer) => tree.root.findAll((node: any) =>
  node.type === 'View' && node.props.testID === 'artifact-preview-failed');
async function mount(value = attachment) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ArtifactCard attachment={value} />); });
  return tree;
}
beforeEach(() => {
  bytes.image.mockReset().mockResolvedValue({ uri: 'file:///bounded-thumbnail.png' });
  bytes.text.mockReset();
  bytes.full.mockClear();
});

describe('Artifact preview failure recovery', () => {
  it('shows passive feedback for a rejected bounded thumbnail without fetching the artifact', async () => {
    bytes.image.mockRejectedValueOnce(new Error('offline'));
    const tree = await mount();
    expect(failed(tree)).toHaveLength(1);
    const row = tree.root.findByType('IndexRow');
    expect(row.props.title).toBe('Preview unavailable');
    expect(row.props.action).toBeUndefined();
    expect(row.props.onPress).toBeUndefined();
    expect(bytes.full).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
  it('explains thumbnail decoding failure without fetching the artifact', async () => {
    const tree = await mount();
    act(() => tree.root.findByType('Image').props.onError());
    expect(failed(tree)).toHaveLength(1);
    expect(bytes.image).toHaveBeenCalledTimes(1);
    expect(bytes.full).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
  it('clears a failed Markdown read for a new attachment', async () => {
    bytes.text.mockRejectedValueOnce(new Error('offline'));
    const first = { ...attachment, mimeType: 'text/markdown', name: 'notes.md' };
    const tree = await mount(first);
    expect(failed(tree)).toHaveLength(1);
    bytes.text.mockResolvedValueOnce('# Recovered');
    await act(async () => tree.update(<ArtifactCard attachment={{ ...first, url: first.url + '?revision=2' }} />));
    expect(failed(tree)).toHaveLength(0);
    expect(tree.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'artifact-preview-markdown')).toHaveLength(1);
    expect(bytes.full).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
