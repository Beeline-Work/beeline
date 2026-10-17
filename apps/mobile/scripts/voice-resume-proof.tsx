import React, { useEffect } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { useVoiceCall } from '../sources/buzz/use-voice-call';
import { VoiceBar } from '../sources/components/buzz/VoiceBar';
import { VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

const fixture = (globalThis as any).__voiceResume;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let voice: ReturnType<typeof useVoiceCall>;
const errors: string[] = [];
function Proof() {
  voice = useVoiceCall('proof-room', true);
  useEffect(() => { void voice.join(); }, []);
  useEffect(() => { if (voice.error) errors.push(voice.error); }, [voice.error]);
  return <><VoiceBar voice={voice} /><div role="alert">{voice.error}</div></>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
async function run() {
  await pause(300);
  await fixture.idle();
  await pause(100);
  fixture.offline = true;
  fixture.ready = true;
  fixture.reconnect();
  await pause(100);
  check('R1: DNS fails during parked resume without a rendered error', errors.length === 0 && !document.querySelector('[role="alert"]')?.textContent);
  fixture.offline = false;
  await pause(1_100);
  const bridge = { identity: 'beeline-voice-proof-call' };
  fixture.emit('data', new TextEncoder().encode(JSON.stringify({ type: 'speaker', agentId: null })), bridge, undefined, VOICE_DATA_TOPIC);
  await pause(100);
  check('R1: call resumes audio and microphone after network returns', fixture.resumed && fixture.mic && Boolean(voice!.call));
  check('R1: no raw error reaches the rendered voice surface', errors.length === 0 && !document.body.textContent?.includes('UnknownHostException'));
  await voice!.end();
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines,
    'Stand-in: native transport and network are simulated; useVoiceCall and VoiceBar render in Chrome.',
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
