import React, { useRef, useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';

// The three locked v4 states, each a real composer driven the way a person does.
const voice = { call: null, agents: [], target: null, speaker: null, level: 0, connecting: false,
  error: null, quotaExhausted: false, firstAudioMs: null, join: async () => {}, end: async () => {},
  aim() {} } as unknown as VoiceCallState;
const sent: { text: string; files: number }[] = [];
const tags = new Set(['ruby']);
function Composer({ id, initial }: { id: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [height, setHeight] = useState(26);
  // The Room reads the draft at send time, after a take's words land.
  const latest = useRef(value);
  latest.current = value;
  const filesRef = useRef(0);
  const [files, setFiles] = useState<{ uri: string; name: string; mimeType: string; sizeLabel: string;
    uploadState: 'uploaded' }[]>([]);
  return <View testID={`${id}-row`} style={{ marginBottom: 12 }}>
    <ConversationComposer voice={voice} value={value} height={height} focused={false} disabled={false}
      testIDPrefix={id} tagHandles={tags} attachments={files}
      onAttach={() => setFiles(current => { filesRef.current = current.length + 1; return [...current,
        { uri: `file:${current.length}`, name: 'notes.pdf', mimeType: 'application/pdf', sizeLabel: '12 KB', uploadState: 'uploaded' }]; })}
      onBlur={() => {}} onChangeText={next => { latest.current = next; setValue(next); }} onContentSizeChange={event => setHeight(Math.max(26, Math.ceil(event.nativeEvent.contentSize.height)))} onFocus={() => {}}
      onKeyPress={() => {}} onSend={() => { sent.push({ text: latest.current, files: filesRef.current }); setValue(''); setFiles([]); }} />
  </View>;
}
function Proof() {
  return <View style={{ padding: 16, width: Number(new URLSearchParams(location.search).get('width') ?? 390) }}>
    <Text style={{ color: '#888', marginBottom: 4 }}>Empty</Text>
    <Composer id="empty" initial="" />
    <Text style={{ color: '#888', marginBottom: 4 }}>Has text</Text>
    <Composer id="text" initial="@ruby check the multiway corner" />
    <Text style={{ color: '#888', marginBottom: 4 }}>Dictating</Text>
    <Composer id="dict" initial="@ruby " />
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
const right = (id: string) => Math.round(node(id)?.getBoundingClientRect().right ?? -1);
async function run() {
  await pause(300);
  node('dict-mic')!.click();
  await pause(900);
  const go = (prefix: string) => node(`${prefix}-send`) ?? node(`${prefix}-conversation`);
  lines.push(`slots empty: attach ${!!node('empty-attach-button')} mic ${!!node('empty-mic')} conversation ${!!node('empty-conversation')} send ${!!node('empty-send')}`);
  lines.push(`slots text: attach ${!!node('text-attach-button')} mic ${!!node('text-mic')} conversation ${!!node('text-conversation')} send ${!!node('text-send')}`);
  lines.push(`slots dictating: attach ${!!node('dict-attach-button')} stop ${!!node('dict-speech-discard')} mic ${!!node('dict-mic')} send ${!!node('dict-send')}`);
  check('empty: + attach, mic, Conversation', Boolean(node('empty-attach-button') && node('empty-mic') && node('empty-conversation')) && !node('empty-send'));
  check('text: + attach, mic, Send', Boolean(node('text-attach-button') && node('text-mic') && node('text-send')) && !node('text-conversation'));
  check('dictating: + attach, Stop, Send', Boolean(node('dict-attach-button') && node('dict-speech-discard') && node('dict-send')) && !node('dict-mic'));
  check('go slot right edge equal in all states', right('empty-row') - right(go('empty')?.dataset.testid ?? '') === right('text-row') - right('text-send') &&
    right('text-row') - right('text-send') === right('dict-row') - right('dict-send'));
  check('Stop in the mic spot', right('dict-speech-discard') === right('text-mic'));
  if (new URLSearchParams(location.search).get('act') === '1') {
    node('dict-attach-button')!.click();
    await pause(100);
    node('dict-send')!.click();
    await pause(300);
    lines.push(`sent ${JSON.stringify(sent)}`);
    check('a file attached while dictating goes with the voice text', sent.length === 1 && sent[0].text === '@ruby the voice text' && sent[0].files === 1);
  }
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines,
    `RESULT ${lines.some(line => line.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
