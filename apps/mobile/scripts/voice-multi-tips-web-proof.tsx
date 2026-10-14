import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';
const agents = [['a', 'Ruby'], ['b', 'Goosy'], ['c', 'Candy']].map(([seed, name]) => ({ pubkey: seed!.repeat(64), kind: 'agent' as const, name: name! }));
const control: { humans?: (count: number) => void; drop?: () => void; aimed: string[] } = { aimed: [] };
function Proof() {
  const [humans, setHumans] = useState(1);
  const [unaddressed, setUnaddressed] = useState(0);
  control.humans = setHumans; control.drop = () => setUnaddressed(count => count + 1);
  const voice = { call: { id: 'fixture-call' }, agents, target: agents[0]!.pubkey, speaker: null, level: 0, connecting: false,
    error: null, quotaExhausted: false, firstAudioMs: null, humans, unaddressed,
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
  check('one human keeps the Conversation mode label', node('conversation-mode-label')?.textContent === 'Conversation mode' && !node('conversation-tip'));
  control.humans!(2); await pause(100);
  const tip = () => node('conversation-tip')?.textContent ?? '';
  check('two humans replace the label with the name tip', !node('conversation-mode-label') && tip() === 'Start with a name: “Ruby, …”', tip());
  await pause(4100);
  check('tip 2 after about 4 s', tip() === 'Tap an avatar to talk to it once', tip());
  await pause(4000);
  check('tip 3 after about 8 s', tip() === 'Talk over an agent to stop it', tip());
  const plain = getComputedStyle(node('conversation-tip')!).color;
  control.drop!(); await pause(100);
  const flash = getComputedStyle(node('conversation-tip')!).color;
  check('a dropped unnamed turn returns to the name tip and highlights it', tip() === 'Start with a name: “Ruby, …”' && flash !== plain, `${plain} -> ${flash}`);
  await pause(1600);
  check('the highlight clears after about 1.5 s', getComputedStyle(node('conversation-tip')!).color === plain);
  document.querySelector<HTMLElement>('[aria-label="Speak to Goosy"]')!.click(); await pause(50);
  check('tapping an avatar aims that agent', control.aimed.at(-1) === agents[1]!.pubkey);
  const bar = node('conversation-target-strip')!.getBoundingClientRect(), box = node('conversation-tip')!.getBoundingClientRect();
  check('tip line sits in the agent strip without overflowing it', box.right <= bar.right + 1 && box.top >= bar.top - 1 && box.bottom <= bar.bottom + 1,
    `${Math.round(box.width)}x${Math.round(box.height)} in ${Math.round(bar.width)}x${Math.round(bar.height)}`);
  if (new URLSearchParams(location.search).get('shot') === 'flash') { control.drop!(); await pause(100); }
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, 'Transport is stubbed; proof covers the production Conversation panel.',
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
