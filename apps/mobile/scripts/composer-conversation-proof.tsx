import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { AttachmentPickerSheet } from '../sources/components/buzz/AttachmentPickerSheet';
import { createChatAttachmentUploader, type PickedChatAttachment } from '../sources/buzz/chat-attachment';
import type { VoiceCallState } from '../sources/buzz/use-voice-call';
const byID = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const pause = () => new Promise(resolve => setTimeout(resolve, 120));
const lines: string[] = [];
const check = (label: string, pass: boolean) => lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
let setPhase: (phase: string) => void;
let sent: readonly { name?: string }[] | undefined;
const uploader = createChatAttachmentUploader();
let uploads = 0;
const client = { uploadMedia: async () => { uploads++; return { url: 'https://example.invalid/document.txt', sha256: 'proof', size: 4 }; } } as never;
const theme = new URLSearchParams(location.search).get('theme') ?? 'obsidian';
function Proof() {
  const [phase, changePhase] = useState('silence'); setPhase = changePhase;
  const [picker, setPicker] = useState(false);
  const [pending, setPending] = useState<PickedChatAttachment[]>([]);
  const [value, setValue] = useState('');
  const voice = { call: phase === 'ended' ? null : { id: 'proof' }, connecting: phase === 'connecting',
    agents: [{ kind: 'agent', pubkey: 'ruby', name: 'Ruby', face: null }, { kind: 'agent', pubkey: 'jellybean', name: 'Jellybean', face: null }],
    speaker: phase === 'speaking' ? 'ruby' : null, target: 'ruby', level: phase === 'silence' ? 0 : 0.4,
    error: null, quotaExhausted: false, firstAudioMs: null, join: async () => {},
    aim: () => {}, end: async () => changePhase('ended') } as unknown as VoiceCallState;
  return <View style={{ minHeight: 800, padding: 16, backgroundColor: theme === 'bone' ? '#F3EEE4' : '#14091A' }}>
    <Text style={{ color: theme === 'bone' ? '#171310' : '#f0f0f3', marginBottom: 24 }}>Conversation mode · {phase}</Text>
    <ConversationComposer value={value} height={26} focused={false} disabled={false} voice={voice} canSend={Boolean(value.trim() || pending.length)}
      onBlur={() => {}} onFocus={() => {}} onKeyPress={() => {}} onContentSizeChange={() => {}}
      onChangeText={setValue} onAttach={() => setPicker(true)}
      attachments={pending.map(a => ({ ...a, sizeLabel: '4 B', uploadState: 'uploaded' as const }))}
      onSend={async () => { sent = await uploader.uploadAll(client, pending); setPending([]); setValue(''); }} />
    <AttachmentPickerSheet visible={picker} onClose={() => setPicker(false)} onPickPhoto={() => {}}
      onPickDocument={() => { const attachment: PickedChatAttachment = { uri: 'data:text/plain;base64,dGVzdA==', name: 'document.txt', mimeType: 'text/plain', size: 4, source: 'file' };
        setPending(current => [...current, attachment]); uploader.start(client, [attachment]); }} />
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
async function run() {
  await pause();
  for (const phase of ['silence', 'connecting', 'listening', 'speaking']) {
    setPhase(phase); await pause();
    const strip = byID('conversation-target-strip')!.getBoundingClientRect();
    const label = byID('conversation-mode-label')!.getBoundingClientRect();
    check(`${phase}: label right-aligned on avatar row`, Math.abs(label.right - strip.right + 8) < 2 && label.top >= strip.top && label.bottom <= strip.bottom);
    check(`${phase}: attachment, waveform and mic visible`, Boolean(byID('chat-attach-button')) && Boolean(byID('voice-waveform')) && Boolean(byID('voice-mic')));
  }
  byID('chat-attach-button')!.click(); await pause();
  check('attach opens existing picker during agent speech', Boolean(byID('attachment-picker-document')));
  byID('attachment-picker-document')!.click(); await pause();
  check('picked document pending during call', Boolean(byID('pending-chat-attachment-0')));
  byID('voice-mic')!.click(); await pause();
  check('call end restores composer and retains attachment', !byID('conversation-mode-label') && Boolean(document.querySelector('textarea')) && Boolean(byID('pending-chat-attachment-0')));
  byID('chat-send')!.click(); await pause();
  check('next message sends attachment and reuses upload', sent?.[0]?.name === 'document.txt' && uploads === 1 && !byID('pending-chat-attachment-0'));
  setPhase('speaking'); await pause();
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, `RESULT ${lines.some(l => l.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
