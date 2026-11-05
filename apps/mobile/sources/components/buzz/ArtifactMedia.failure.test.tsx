import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const bytes = vi.hoisted(() => ({ image: vi.fn(), text: vi.fn() }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Image: host('Image'), View: host('View'), Text: host('Text'), ScrollView: host('ScrollView') };
});
vi.mock('./IndexRow', () => ({ IndexRow: (props: any) => React.createElement('IndexRow', props) }));
vi.mock('@/buzz/use-artifact-recovery', () => ({ useArtifactRecoveryGeneration: () => 0 }));
vi.mock('@/buzz/artifact-link', () => ({
  artifactImageSource: bytes.image, fetchArtifactText: bytes.text,
  releaseArtifactImageSource: vi.fn(), subscribeArtifactBytesPurge: () => () => {},
}));
import { ArtifactImage, ArtifactText } from './ArtifactMedia';

const attachment = { url: 'https://usebeeline.app/v1/media/file', name: 'file', mimeType: 'image/png', size: 10 };
describe('Passive media failures', () => {
  it('uses the shared row for an image decode failure', async () => {
    bytes.image.mockResolvedValueOnce({ uri: 'file:///image.png' });
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<ArtifactImage attachment={attachment} fit="contain" testID="image" />); });
    act(() => tree.root.findByType('Image').props.onError());
    const row = tree.root.findByType('IndexRow');
    expect(row.props.title).toBe('Image unavailable');
    expect(row.props.description).toContain('could not be loaded');
    expect(row.props.action).toBeUndefined();
    act(() => tree.unmount());
  });
  it('uses the shared row for a rejected text read', async () => {
    bytes.text.mockRejectedValueOnce(new Error('offline'));
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<ArtifactText crop={false} attachment={{ ...attachment, mimeType: 'text/plain' }} testID="text" />); });
    const row = tree.root.findByType('IndexRow');
    expect(row.props.title).toBe('File unavailable');
    expect(row.props.description).toContain('could not be loaded');
    expect(row.props.action).toBeUndefined();
    act(() => tree.unmount());
  });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
