import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
// @ts-expect-error Standalone proof uses installed react-dom.
import { flushSync } from 'react-dom';
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
  const [target, aim] = useState('ruby');
  const voice = { call: phase === 'ended' ? null : { id: 'proof' }, connecting: phase === 'connecting',
    agents: [{ kind: 'agent', pubkey: 'ruby', name: 'Ruby', face: null }, { kind: 'agent', pubkey: 'jellybean', name: 'Jellybean', face: null }, { kind: 'agent', pubkey: 'goose', name: 'Goosey', face: null }],
    speaker: phase === 'speaking' ? 'ruby' : null, target, level: phase === 'silence' ? 0 : 0.4,
    muted: false, toggleMute: async () => {}, humans: 2, error: null, quotaExhausted: false, firstAudioMs: null, join: async () => {},
    aim, end: async () => changePhase('ended') } as unknown as VoiceCallState;
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
  const selected = () => document.querySelector<HTMLElement>('[aria-label="Speak to Jellybean"]');
  selected()!.click(); await pause();
  const outlined = () => getComputedStyle(selected()!.firstElementChild!).borderTopColor ===
    'rgb(0, 0, 0)';
  check('CONVERSATION-2: tap selects Jellybean with an avatar outline', outlined());
  const selectedLabel = Array.from(selected()!.querySelectorAll<HTMLElement>('*')).find(element => element.textContent === 'Jellybean');
  check('CONVERSATION-2: selected name has no underline', !!selectedLabel && !getComputedStyle(selectedLabel).textDecorationLine.includes('underline'));
  const latest = () => byID('waveform-live-level')!;
  check('CONVERSATION-3: visible newest bar is quiet in silence', getComputedStyle(latest()).height === '2px');
  for (const phase of ['silence', 'connecting', 'listening', 'speaking']) {
    flushSync(() => setPhase(phase));
    if (phase === 'listening') check('CONVERSATION-3: volume changes the visible newest bar before timers advance', parseFloat(getComputedStyle(latest()).height) > 2);
    await pause();
    check(`${phase}: tap stays selected`, outlined());
    const faceColor = (name: string) => getComputedStyle(document.querySelector<HTMLElement>(`[aria-label="Speak to ${name}"]`)!.firstElementChild!).borderTopColor;
    check(`${phase}: inactive agent has no frame`, faceColor('Goosey') === 'rgba(0, 0, 0, 0)');
    if (phase === 'speaking') check('CONVERSATION-2: speaking frame is brass and selection stays black', getComputedStyle(byID('voice-speaking-frame-ruby')!).borderTopColor !== faceColor('Jellybean'));
    if (phase === 'connecting') {
      check('connecting: startup glyph replaces waveform until audio is ready', !!byID('voice-startup-loader') && !latest());
      const control = byID('chat-conversation')!;
      const loader = byID('voice-startup-loader')!;
      const slot = control.getBoundingClientRect();
      const glyph = loader.getBoundingClientRect();
      check('connecting: conversation control is disabled and busy', control.getAttribute('aria-disabled') === 'true' && control.getAttribute('aria-busy') === 'true');
      check('connecting: existing 20px loader replaces the glyph in its 26px slot', control.contains(loader) &&
        slot.width === 26 && slot.height === 26 && glyph.width === 20 && glyph.height === 20 &&
        Math.abs((slot.left + slot.right) - (glyph.left + glyph.right)) < 1 &&
        Math.abs((slot.top + slot.bottom) - (glyph.top + glyph.bottom)) < 1);
    } else {
      check(`${phase}: startup glyph clears when ready`, !byID('voice-startup-loader'));
      check(`${phase}: current level stays at the visible right edge`, latest().getBoundingClientRect().right <= byID('voice-waveform')!.getBoundingClientRect().right);
    }
    if (phase === 'listening') check('CONVERSATION-3: current level grows immediately', parseFloat(getComputedStyle(latest()).height) > 2);
    const strip = byID('conversation-target-strip')!.getBoundingClientRect();
    const field = byID(phase === 'connecting' ? 'chat-composer-input-row' : 'voice-waveform')!.getBoundingClientRect();
    check(`${phase}: avatars above waveform, no caption`, strip.bottom <= field.top && !byID('conversation-mode-label'));
    if (phase === 'connecting') {
      check('connecting: normal composer remains visible with the loading conversation control',
        Boolean(byID('chat-input')) && Boolean(byID('chat-attach-button')) && Boolean(byID('chat-conversation')) && !byID('voice-mic'));
    } else {
      check(`${phase}: mute, waveform and stop visible; attachment hidden`, !byID('chat-attach-button') && Boolean(byID('chat-mic')) && Boolean(byID('voice-mic')));
    }
  }
  byID('voice-mic')!.click(); await pause();
  check('call end restores normal composer', Boolean(document.querySelector('textarea')) && Boolean(byID('chat-attach-button')));
  byID('chat-attach-button')!.click(); await pause();
  check('attach opens existing picker after leaving', Boolean(byID('attachment-picker-document')));
  byID('attachment-picker-document')!.click(); await pause();
  check('picked document is pending', Boolean(byID('pending-chat-attachment-0')));
  byID('chat-send')!.click(); await pause();
  check('next message sends attachment and reuses upload', sent?.[0]?.name === 'document.txt' && uploads === 1 && !byID('pending-chat-attachment-0'));
  setPhase('speaking'); await pause();
}
run().catch(error => lines.push(`FAIL ${String(error)}`)).finally(() => {
  document.getElementById('result')!.textContent = [...lines, `RESULT ${lines.some(l => l.startsWith('FAIL')) ? 'FAIL' : 'PASS'}`].join('\n');
});
