import React, { useEffect } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { useVoiceCall } from '../sources/buzz/use-voice-call';
import { VoiceBar } from '../sources/components/buzz/VoiceBar';
import { VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

const fixture = (globalThis as any).__callFeedback;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let voice: ReturnType<typeof useVoiceCall>;
function Proof() {
  voice = useVoiceCall('proof-room', true);
  useEffect(() => { void voice.join(); }, []);
  return <div style={{ width: 450 }}><VoiceBar voice={voice} /></div>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
function lastBarHeight() {
  const bars = document.querySelector('[data-testid="voice-waveform"]')?.querySelectorAll<HTMLElement>('[style*="height:"]');
  return bars?.length ? parseFloat(bars[bars.length - 1].style.height) : 0;
}
async function run() {
  await pause(300);
  fixture.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'speaker', agentId: 'ruby' })),
    { identity: 'beeline-voice-proof-call' }, undefined, VOICE_DATA_TOPIC);
  fixture.room.localParticipant.audioLevel = 0.02;
  fixture.emit('levels');
  await pause(800);
  const quiet = lastBarHeight();
  fixture.room.localParticipant.audioLevel = 0.5;
  fixture.emit('levels');
  await pause(800);
  const loud = lastBarHeight();
  check(`call-feedback-1: rendered bars grow with mic input (${quiet} → ${loud})`, quiet > 2 && loud > quiet);
  fixture.room.remoteParticipants.get('beeline-voice-proof-call').audioLevel = 0.001;
  fixture.emit('levels');
  await pause(800);
  const agent = lastBarHeight();
  check(`audible agent keeps waveform priority (${loud} → ${agent})`, agent < quiet);
  check('call remains joined without leaving', Boolean(voice!.call));
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines,
    'RTC and provider input are simulated; hook, VoiceBar and waveform render are real.',
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
