import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { VoiceCallState } from '@/buzz/use-voice-call';

vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'android' }, View: host('View'), Text: host('Text'), Image: host('Image'),
    ScrollView: host('ScrollView'), Pressable: host('Pressable') };
});
vi.mock('./MonoHull', () => ({ HullLivePulse: (props: any) => React.createElement('View', props, props.children) }));
vi.mock('./Button', () => ({ Button: (props: any) => React.createElement('Button', props, props.icon) }));
vi.mock('./IndexRow', () => ({ InlineRow: 'View' }));
vi.mock('./SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: 'View' }));
vi.mock('./DictationWaveform', () => ({ DictationWaveform: 'View' }));
vi.mock('./MicGlyph', () => ({ MicGlyph: 'View', StopGlyph: 'View', COMPOSER_GLYPH_SIZE: 24 }));
import { IdentityMark } from './IdentityMark';
import { VoiceAgentStrip } from './VoiceBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('renders the same generated agent portrait as other IdentityMark surfaces', async () => {
  const agent = { pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', face: 'bat', avatar: 'https://proof/v1/agent-avatars/33333333-3333-4333-8333-333333333333' };
  const voice = { agents: [agent], target: null, speaker: null, aim: vi.fn() } as unknown as VoiceCallState;
  let tree: any;
  await act(async () => { tree = create(<>
    <VoiceAgentStrip voice={voice} />
    <IdentityMark kind="agent" seed={agent.pubkey} name={agent.name} face={agent.face} avatarUrl={agent.avatar} />
  </>); });
  try {
    const images = tree.root.findAll((node: any) => node.type === 'Image' && node.props.testID === 'generated-agent-avatar');
    expect(images).toHaveLength(2);
    expect(images[0].props.source).toEqual(images[1].props.source);
    expect(images[0].props.source.uri).toBe(agent.avatar);
  } finally { await act(async () => tree.unmount()); }
});
