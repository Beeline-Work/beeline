import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { VOICE_QUOTA_MESSAGE } from '@beeline/api-contract/phone';
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'), Pressable: host('Pressable'),
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) } };
});
vi.mock('./IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('./MicGlyph', () => ({ COMPOSER_GLYPH_SIZE:20, MicGlyph:(props:any)=>React.createElement('MicGlyph',props), StopGlyph: (props: any) => React.createElement('StopGlyph', props) }));
vi.mock('./BeelineMarkSpinner', () => ({ BeelineMarkSpinner: () => null }));
vi.mock('./DictationWaveform', () => ({ DictationWaveform: () => React.createElement('Waveform') }));
vi.mock('./HullDialog', () => ({ HullModal: () => null }));
import { VoiceBar, VoiceAgentStrip } from './VoiceBar';

it('gives a group call one filled stop glyph with the Leave call accessibility label', async () => {
  const end = vi.fn(); let renderer: any;
  await act(async () => { renderer = create(<VoiceBar voice={{ call: null, agents: [], target: null,
    speaker: null, level: 0, connecting: false, error: null, endingWarning: undefined, quotaExhausted: false, budgetWarning: null,
    muted: false, toggleMute: async () => {}, firstAudioMs: null, humans: 2, unaddressed: 0, join: vi.fn(), end, aim: vi.fn() }} />); });
  try {
    expect(renderer.root.findAllByType('StopGlyph')[0].props.filled).toBe(true);
    const leave = renderer.root.findByProps({ testID: 'voice-mic' });
    expect(leave.props.accessibilityLabel).toBe('Leave call');
    await act(async () => leave.props.onPress()); expect(end).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer.unmount()); }
});

it('shows the exhausted daily quota inside the voice bar with an operable end mic', async () => {
  const end = vi.fn(); let renderer: any;
  await act(async () => { renderer = create(<VoiceBar voice={{ call: null, agents: [], target: null,
    speaker: null, level: 0, connecting: false, error: VOICE_QUOTA_MESSAGE, endingWarning: undefined, quotaExhausted: true, budgetWarning: null,
    muted: false, toggleMute: async () => {}, firstAudioMs: null, humans: 1, unaddressed: 0, join: vi.fn(), end, aim: vi.fn() }} />); });
  expect(renderer.root.findByProps({ testID: 'voice-quota-error' }).props.children).toBe(VOICE_QUOTA_MESSAGE);
  expect(renderer.root.findAllByType('Waveform')).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ testID: 'voice-mic' }).props.onPress());
  expect(renderer.root.findByProps({ testID: 'voice-mic' }).props.accessibilityLabel).toBe('End call');
  expect(end).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
});

it('keeps a readable join error with an operable end control', async () => {
  const end = vi.fn(), aim = vi.fn(); let renderer: any;
  const error = 'Conversation mode could not connect.';
  await act(async () => { renderer = create(<VoiceBar voice={{ call: null,
    agents: [{ pubkey: 'ruby', kind: 'agent', name: 'Ruby' }, { pubkey: 'goose', kind: 'agent', name: 'Goosey' }],
    target: null, speaker: null, level: 0, connecting: false, error, endingWarning: undefined, quotaExhausted: false, budgetWarning: null,
    muted: false, toggleMute: async () => {}, firstAudioMs: null, humans: 1, unaddressed: 0, join: vi.fn(), end, aim }} />); });
  try {
    expect(renderer.root.findByProps({ testID: 'voice-connection-error' }).props.children).toBe(error);
    await act(async () => renderer.root.findByProps({ testID: 'voice-mic' }).props.onPress());
    expect(end).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer.unmount()); }
});

it('ended call has no header pill or Join', async () => {
  const { VoiceCallCard } = await import('./VoiceCallCard');
  let renderer: any;
  await act(async () => { renderer = create(<VoiceCallCard call={{id:'old',roomId:'room',startedAt:10,endedAt:75,participants:[]}}
    joined={false} onJoin={vi.fn()} />); });
  expect(renderer.toJSON()).toBeNull();
  await act(async () => renderer.unmount());
});

it('puts the server countdown in the waveform slot in solo mode', async () => {
  let renderer: any;
  await act(async () => { renderer=create(<VoiceBar voice={{call:null,agents:[],target:null,speaker:null,
    level:0,connecting:false,error:null,quotaExhausted:false,budgetWarning:null,muted:false,toggleMute:async()=>{},firstAudioMs:null,humans:1,unaddressed:0,
    endingWarning:'Ending in 10s',join:vi.fn(),end:vi.fn(),aim:vi.fn()}} />); });
  try {
    const tip=renderer.root.findByProps({testID:'conversation-tip'});
    expect(tip.props.children).toBe('Ending in 10s');
    expect(tip.props.accessibilityLiveRegion).toBe('polite');
    expect(renderer.root.findAllByProps({testID:'conversation-mode-label'})).toHaveLength(0);
  } finally {await act(async()=>renderer.unmount());}
});

it('header lists only humans with the viewer first and offers Join after leaving', async () => {
  const { VoiceCallCard } = await import('./VoiceCallCard');
  const join = vi.fn(); let renderer: any;
  const call = {id:'call',roomId:'room',startedAt:Date.now()/1000,participants:[
    {pubkey:'sam',kind:'human' as const,name:'Sam'}, {pubkey:'ruby',kind:'agent' as const,name:'Ruby'},
    {pubkey:'alex',kind:'human' as const,name:'Alex'}]};
  await act(async () => {renderer=create(<VoiceCallCard call={call} viewer="alex" joined={false} onJoin={join} />);});
  try {
    const text=renderer.root.findAllByType('Text').map((node:any)=>React.Children.toArray(node.props.children)
      .filter(value=>typeof value==='string').join('')).join('');
    expect(text).toContain('You, Sam'); expect(text).not.toContain('Ruby');
    const leftCall = {...call,participants:call.participants.filter(person=>person.pubkey!=='alex')};
    await act(async()=>renderer.update(<VoiceCallCard call={leftCall} viewer="alex" joined={false} onJoin={join} />));
    const leftText=renderer.root.findAllByType('Text').map((node:any)=>React.Children.toArray(node.props.children)
      .filter(value=>typeof value==='string').join('')).join('');
    expect(leftText).toContain('Sam'); expect(leftText).not.toContain('You'); expect(leftText).not.toContain('Ruby');
    await act(async()=>renderer.root.findByProps({testID:'voice-call-join'}).props.onPress());
    expect(join).toHaveBeenCalledOnce();
    await act(async()=>renderer.update(<VoiceCallCard call={call} viewer="alex" joined onJoin={join} />));
    expect(renderer.root.findAllByProps({testID:'voice-call-join'})).toHaveLength(0);
  } finally {await act(async()=>renderer.unmount());}
});



it.each([1, 2])('uses the existing warning slot for %s humans and prioritizes call ending', async humans => {
  const voice = { call: null, agents: [], target: null, speaker: null, level: 0, connecting: false,
    error: null, muted: false, toggleMute: async () => {}, endingWarning: undefined, quotaExhausted: false, budgetWarning: '2 min left today',
     firstAudioMs: null, humans, unaddressed: 0, join: vi.fn(), end: vi.fn(), aim: vi.fn() };
  let renderer: any;
  await act(async () => { renderer = create(<VoiceBar voice={voice} />); });
  const id = 'conversation-tip';
  expect(renderer.root.findByProps({ testID: id }).props.children).toBe('2 min left today');
  expect(renderer.root.findByProps({ testID: id }).props.accessibilityLiveRegion).toBe('polite');
  expect(renderer.root.findAllByProps({ testID: 'voice-budget-warning' })).toHaveLength(0);
  await act(async () => renderer.update(<VoiceBar voice={{ ...voice, endingWarning: 'Ending in 15s' }} />));
  expect(renderer.root.findByProps({ testID: id }).props.children).toBe('Ending in 15s');
  await act(async () => renderer.unmount());
});

it('Reproduction CONVERSATION-2: tapping a face immediately marks selection and keeps it across level updates', async () => {
  let renderer: any;
  let updateLevel!: (level: number) => void;
  function Probe() {
    const [target, aim] = React.useState('ruby');
    const [level, setLevel] = React.useState(0); updateLevel = setLevel;
    return <VoiceAgentStrip voice={{ agents: [
      { pubkey: 'ruby', kind: 'agent', name: 'Ruby' }, { pubkey: 'goose', kind: 'agent', name: 'Goosey' },
    ], target, aim, level, speaker: null } as any} />;
  }
  await act(async () => { renderer = create(<Probe />); });
  const face = (name: string) => renderer.root.findAllByType('Pressable')
    .find((node: any) => node.props.accessibilityLabel === `Speak to ${name}`);
  const outline = (name: string) => face(name).findAllByType('View')[0].props.style
    .flat(Infinity).filter((style: any) => style?.borderColor).at(-1)?.borderColor;
  const underlined = () => renderer.root.findAllByType('Text').some((node: any) =>
    [node.props.style].flat(Infinity).some((style: any) => style?.textDecorationLine === 'underline'));
  try {
    await act(async () => face('Goosey').props.onPress());
    expect(face('Goosey').props.accessibilityState.selected).toBe(true);
    expect(face('Ruby').props.accessibilityState.selected).toBe(false);
    expect(outline('Goosey')).not.toBe('transparent');
    expect(outline('Ruby')).toBe('transparent');
    expect(underlined()).toBe(false);
    await act(async () => updateLevel(0.8));
    expect(outline('Goosey')).not.toBe('transparent');
    expect(outline('Ruby')).toBe('transparent');
    expect(underlined()).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});
