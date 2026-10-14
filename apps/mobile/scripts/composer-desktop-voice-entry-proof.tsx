import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';

let joins = 0;
let leaves = 0;
function Proof() {
  const [active, setActive] = useState(false);
  const voice = {
    call: active ? { id: 'fixture-call' } : null, agents: [], target: null,
    speaker: null, level: 0, connecting: false, error: null,
    quotaExhausted: false, firstAudioMs: null,
    join: async () => { joins++; setActive(true); },
    end: async () => { leaves++; setActive(false); }, aim: () => {},
  } as VoiceCallState;
  return <ConversationComposer voice={voice} value="" height={26} focused={false}
    disabled={false} onBlur={() => {}} onChangeText={() => {}}
    onContentSizeChange={() => {}} onFocus={() => {}} onKeyPress={() => {}}
    onSend={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
async function run() {
  await pause(150);
  const mic = node('chat-mic')!;
  check('desktop composer shows the existing mic', Boolean(mic));
  const bounds = mic.getBoundingClientRect();
  const pointer = { bubbles: true, button: 0, buttons: 1,
    clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
  mic.dispatchEvent(new MouseEvent('mousedown', pointer));
  await pause(1000);
  document.dispatchEvent(new MouseEvent('mouseup', { ...pointer, buttons: 0 }));
  await pause(150);
  check('Reproduction desktop-voice-gate-1: holding enters Conversation once', joins === 1 && Boolean(node('voice-bar')));
  check('release does not start dictation', !(globalThis as any).__dictationStarts);
  node('voice-mic')?.click();
  await pause(150);
  check('existing End control returns to composer', leaves === 1 && Boolean(node('chat-mic')) && !node('voice-bar'));
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines,
    'RTC and providers are stubbed; this proves entry and exit only.',
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
