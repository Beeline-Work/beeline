import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';
const agents = [['a', 'Ruby'], ['b', 'Goosy'], ['c', 'Candy']].map(([seed, name]) => ({ pubkey: seed!.repeat(64), kind: 'agent' as const, name: name! }));
const control: { humans?: (count: number) => void; drop?: () => void; mute?: () => void; warning?: () => void; aimed: string[] } = { aimed: [] };
function Proof() {
  const [humans, setHumans] = useState(1);
  const [unaddressed, setUnaddressed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [endingWarning, setWarning] = useState<string>();
  control.mute = () => setMuted(value => !value);
  control.warning = () => setWarning('Ending in 10s');
  control.humans = setHumans; control.drop = () => setUnaddressed(count => count + 1);
  const voice = { call: { id: 'fixture-call' }, agents, target: agents[0]!.pubkey, speaker: null, level: 0, connecting: false,
    muted, endingWarning, toggleMute: async () => control.mute!(), error: null, quotaExhausted: false, firstAudioMs: null, humans, unaddressed,
    join: async () => {}, end: async () => {}, aim: (id: string) => { control.aimed.push(id); } } as unknown as VoiceCallState;
  return <View style={{ margin: 16 }}><ConversationComposer voice={voice} value="" height={26}
    focused={false} disabled={false} onAttach={() => {}} onBlur={() => {}} onChangeText={() => {}}
    onContentSizeChange={() => {}} onFocus={() => {}} onKeyPress={() => {}} onSend={() => {}} /></View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lines: string[] = [];
const check = (label: string, pass: boolean, seen = '') => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}${seen ? ` — saw "${seen}"` : ''}`);
async function run() {
  await pause(200);
  check('no caption or attachment during a call', !node('conversation-mode-label') && !node('chat-attach-button'));
  const rects = () => ['chat-mic', 'voice-mic'].map(id => {
    const r = node(id)!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(',');
  }).join(';');
  const initial = rects();
  control.humans!(2); await pause(100);
  check('group keeps controls fixed', rects() === initial);
  node('chat-mic')!.click(); await pause(100);
  check('mute keeps controls fixed', rects() === initial && node('chat-mic')!.getAttribute('aria-label') === 'Unmute microphone');
  control.warning!(); await pause(100);
  check('countdown takes waveform slot without moving controls', rects() === initial && node('conversation-tip')?.textContent === 'Ending in 10s');
  document.querySelector<HTMLElement>('[aria-label="Speak to Goosy"]')!.click(); await pause(50);
  check('tapping an avatar aims that agent', control.aimed.at(-1) === agents[1]!.pubkey);

}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, 'Transport is stubbed; proof covers the production Conversation panel.',
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
