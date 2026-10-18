import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';
let joins = 0;
function Proof() {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState('');
  const voice = { call: active ? { id: 'fixture-call' } : null, agents: [], target: null,
    speaker: null, level: 0, connecting: false, error: null, quotaExhausted: false, budgetWarning: null, warningAudio: null, clearWarningAudio() {}, firstAudioMs: null, humans: 1, unaddressed: 0,
    join: async () => { joins++; setActive(true); }, end: async () => setActive(false), aim() {} } as VoiceCallState;
  return <View style={{ margin: 16 }}><ConversationComposer voice={voice} value={value} height={26}
    focused={false} disabled={false} onAttach={() => {}} onBlur={() => {}}
    onChangeText={setValue} onContentSizeChange={() => {}} onFocus={() => {}}
    onKeyPress={() => {}} onSend={() => setValue('')} /></View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
const type = async (value: string) => {
  const input = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await pause(100);
};
async function run() {
  await pause(200);
  const width = document.querySelector('textarea')!.getBoundingClientRect().width;
  check('empty composer has mic and waveform', Boolean(node('chat-mic') && node('chat-conversation')) && !node('chat-send'));
  check('desktop hover title names Conversation mode', node('chat-conversation')?.title === 'Conversation mode');
  node('chat-mic')!.click();
  await pause(50);
  check('mic tap starts dictation only', (globalThis as any).__dictationStarts === 1 && joins === 0);
  node('chat-conversation')!.click();
  await pause(100);
  check('waveform tap enters Conversation once', joins === 1 && Boolean(node('voice-bar')));
  node('voice-mic')!.click();
  await pause(100);
  check('desktop hover title survives ending Conversation', node('chat-conversation')?.title === 'Conversation mode');
  const mic = node('chat-mic')!;
  const bounds = mic.getBoundingClientRect();
  const pointer = { bubbles: true, button: 0, buttons: 1,
    clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
  mic.dispatchEvent(new MouseEvent('mousedown', pointer));
  await pause(1000);
  document.dispatchEvent(new MouseEvent('mouseup', { ...pointer, buttons: 0 }));
  await pause(100);
  check('long press still enters Conversation without another dictation', joins === 2 && Boolean(node('voice-bar')) && (globalThis as any).__dictationStarts === 1);
  node('voice-mic')!.click();
  await pause(100);
  await type('Ruby, what merged today?');
  check('typing replaces waveform with Send and keeps mic', Boolean(node('chat-send') && node('chat-mic')) && !node('chat-conversation'));
  check('input width stays fixed across swap', document.querySelector('textarea')!.getBoundingClientRect().width === width);
  if (new URLSearchParams(location.search).get('state') !== 'typed') await type('');
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, 'Transport is stubbed; proof covers the production composer entry.',
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
