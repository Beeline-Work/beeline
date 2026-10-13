import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';

// Script only the browser's recognition engine, keeping Expo's web event
// conversion, the speech adapter, hook and rendered composer real.
class Recognizer extends EventTarget {
  static current: Recognizer;
  static starts = 0;
  static stops = 0;
  start() { Recognizer.current = this; Recognizer.starts++; }
  stop() { Recognizer.stops++; this.dispatchEvent(new Event('end')); }
  abort() { this.dispatchEvent(new Event('end')); }
  result(transcript: string, isFinal: boolean) {
    const alternatives = Object.assign([{ transcript, confidence: 1 }], { isFinal });
    this.dispatchEvent(Object.assign(new Event('result'), { resultIndex: 0, results: [alternatives] }));
  }
  denied() {
    this.dispatchEvent(Object.assign(new Event('error'), { error: 'not-allowed', message: 'Permission denied' }));
    this.dispatchEvent(new Event('end'));
  }
  networkError() {
    this.dispatchEvent(Object.assign(new Event('error'), { error: 'network', message: 'Network unavailable' }));
    this.dispatchEvent(new Event('end'));
  }
}
const mode = new URLSearchParams(location.search).get('api') ?? 'prefixed';
Object.defineProperty(globalThis, 'webkitSpeechRecognition', { configurable: true, value: mode === 'prefixed' ? Recognizer : undefined });
Object.defineProperty(globalThis, 'SpeechRecognition', { configurable: true, value: mode === 'standard' ? Recognizer : undefined });

let latest = ''; let sent = '';
function Proof() {
  const [value, setValue] = useState(''); latest = value;
  return <ConversationComposer value={value} height={26} focused={false} disabled={false}
    onBlur={() => {}} onChangeText={setValue} onContentSizeChange={() => {}}
    onFocus={() => {}} onKeyPress={() => {}} onSend={() => { sent = latest; }} />;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const lines: string[] = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="chat-${id}"]`);
const check = (label: string, pass: boolean) => { lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`); };
async function run() {
  await pause();
  check('opening the composer does not start capture or request permission', Recognizer.starts === 0);
  if (mode === 'unsupported') {
    check('unsupported browser hides the mic', !node('mic'));
    check('unsupported browser keeps send', Boolean(node('send')));
    return;
  }
  check(`${mode} browser shows the mic`, Boolean(node('mic')));
  node('mic')!.click(); await pause();
  check('tap starts browser recognition once', Recognizer.starts === 1);
  Recognizer.current.result('hello', false); await pause();
  check('interim speech stays in the active take', Boolean(node('speech-waveform')) && latest === '');
  Recognizer.current.result('hello web', true); await pause();
  check('final browser transcript reaches the composer', latest === 'hello web');
  node('mic')!.click(); await pause();
  check('stop ends capture and sends the committed transcript', Recognizer.stops === 1 && sent === 'hello web' && !node('speech-waveform'));
  node('mic')!.click(); await pause();
  Recognizer.current.denied(); await pause();
  check('permission denial stops the take and explains browser site settings', !node('speech-waveform') && Boolean(node('speech-status')?.textContent?.includes('browser site settings')));
  const starts = Recognizer.starts;
  node('mic')!.click(); await pause();
  check('mic retries browser recognition after permission denial', Recognizer.starts === starts + 1);
  const beforeError = Recognizer.starts;
  Recognizer.current.networkError(); await pause();
  check('a transient error restarts once on end', Recognizer.starts === beforeError + 1 && Boolean(node('speech-waveform')));
  Recognizer.current.result('discard me', false); await pause();
  node('speech-discard')!.click(); await pause();
  check('discard drops the take without sending it', latest === 'hello web' && sent === 'hello web' && !node('speech-waveform'));
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
