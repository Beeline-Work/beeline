import React, { useRef, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Platform, Pressable, Text, View } from 'react-native';
import { splitComposerTags, toggleComposerTag } from '../sources/buzz/composer-tags';
import {
  ConversationComposer,
  type DictatedSend,
} from '../sources/components/buzz/ConversationComposer';
import { MentionSuggestionMenu } from '../sources/components/buzz/MentionSuggestionMenu';
import type { RoomRosterParticipant } from '../sources/components/buzz/RoomRosterSheet';
import { beelineThemes, type BeelineThemeName } from '../sources/buzz/groknight';
import { prepareMessageReply } from '../sources/buzz/message-reply';
import { mentionedAgentPubkey } from '../sources/buzz/room-participants';
import { speechProofRecognizer } from './composer-dictation-proof-recognizer';

// An Android 14 phone with Google's recognition service, so dictation starts
// on the first mic tap.
Object.defineProperty(Platform, 'OS', { value: 'android' });
Object.defineProperty(Platform, 'Version', { value: 34 });
speechProofRecognizer.services = ['com.google.android.googlequicksearchbox'];

const query = new URLSearchParams(location.search);
const stopAt = query.get('stop');
const theme = beelineThemes[(query.get('theme') ?? 'obsidian') as BeelineThemeName];
document.body.style.background = theme.bgBase;

const AGENTS: RoomRosterParticipant[] = ['Ruby', 'Sol', 'Fathom', 'Goosy', 'Hoots', 'Milo'].map(
  (name) => ({
    pubkey: name.toLowerCase().padEnd(64, '0'),
    name,
    handle: name.toLowerCase(),
    kind: 'agent',
  }),
);
const TAG_HANDLES = new Set(AGENTS.map((agent) => agent.handle));
const RUBY_MESSAGE = 'Posted the v5 mock. The mic stays plain white with no ring or glow…';

// `wakes` is the agent the Room's send would address (_chat-surface.tsx handleSend).
type Sent = { text: string; replyTo?: string; wakes?: string };
const RUBY_REPLY_TARGET = {
  messageId: 'ruby-message',
  authorName: 'Ruby',
  authorHandle: 'ruby',
  authorPubkey: AGENTS[0].pubkey,
  isAgent: true,
  preview: RUBY_MESSAGE,
};
const state = {
  value: '',
  sent: [] as Sent[],
  // A send waits here, as a queued send waits on the network, until released.
  held: [] as (() => void)[],
  // Groq answers a take here when the proof releases it.
  groq: [] as ((text: string) => void)[],
  setReply: (_: boolean) => undefined as void,
  setValue: (_: string) => undefined as void,
};

// The Groq upload the hook starts for a recorded take.
(globalThis as { __groqUpload?: unknown }).__groqUpload = () => ({
  add: () => undefined,
  finish: () => new Promise<string>((answer) => state.groq.push(answer)),
  discard: () => undefined,
});

// The tag menu, the backdrop and the send wiring follow _chat-surface.tsx.
function Proof() {
  const [value, setValue] = useState('@ruby ');
  const [reply, setReply] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sent, setSent] = useState<Sent[]>([]);
  const valueRef = useRef(value);
  valueRef.current = value;
  state.value = value;
  state.sent = sent;
  state.setReply = setReply;
  state.setValue = (next) => {
    valueRef.current = next;
    setValue(next);
  };
  const send = async (dictated?: DictatedSend) => {
    const text = valueRef.current.trim();
    setTagMenuOpen(false);
    await new Promise<void>((release) => state.held.push(release));
    if (dictated?.cancelled) return;
    if (dictated) dictated.committed = true;
    const prepared = reply ? prepareMessageReply(text, RUBY_REPLY_TARGET) : undefined;
    const wakes = prepared?.agentPubkey ?? mentionedAgentPubkey(text, AGENTS);
    setSent((current) => [
      ...current,
      {
        text,
        ...(reply ? { replyTo: 'ruby' } : {}),
        ...(wakes ? { wakes: AGENTS.find((agent) => agent.pubkey === wakes)!.handle } : {}),
      },
    ]);
    state.setValue('');
    setRevision((current) => current + 1);
    setReply(false);
  };
  return (
    <View
      style={{ width: 390, height: 640, justifyContent: 'flex-end', backgroundColor: theme.bgBase }}
    >
      <View style={{ padding: 16 }} testID="room-messages">
        <Text style={{ color: theme.textSecondary }}>Ruby · {RUBY_MESSAGE}</Text>
        {sent.map((message, index) => (
          <Text
            key={index}
            style={{ color: theme.textPrimary, marginTop: 8 }}
            testID={`sent-${index}`}
          >
            {message.replyTo ? `↩ @${message.replyTo} · ` : ''}
            {message.text}
          </Text>
        ))}
      </View>
      {tagMenuOpen && (
        <Pressable
          accessibilityLabel="Close tag menu"
          onPress={() => setTagMenuOpen(false)}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          testID="tag-menu-backdrop"
        />
      )}
      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        {tagMenuOpen && (
          <MentionSuggestionMenu
            checkedHandles={new Set(splitComposerTags(value, TAG_HANDLES).tags)}
            highlightedIndex={-1}
            keyboardOpen={false}
            matches={AGENTS}
            onSelect={(agent) =>
              state.setValue(toggleComposerTag(valueRef.current, TAG_HANDLES, agent.handle))
            }
            overflow={0}
            personAvatar={() => undefined}
          />
        )}
        <ConversationComposer
          value={value}
          height={26}
          focused={false}
          disabled={false}
          inputRevision={revision}
          tagHandles={TAG_HANDLES}
          onEditTags={() => setTagMenuOpen((open) => !open)}
          reply={reply ? { handle: 'ruby', preview: RUBY_MESSAGE } : undefined}
          onCancelReply={() => setReply(false)}
          onAttach={() => undefined}
          onBlur={() => undefined}
          onChangeText={state.setValue}
          onContentSizeChange={() => undefined}
          onFocus={() => setTagMenuOpen(false)}
          onKeyPress={() => undefined}
          onSend={send}
        />
      </View>
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Proof />);

const result = document.getElementById('result')!;
const lines: string[] = [];
function check(label: string, pass: boolean) {
  lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
const byTestID = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const tap = async (id: string) => {
  const node = byTestID(id);
  if (!node) throw new Error(`no ${id}`);
  node.click();
  await pause();
};
const chips = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid^="chat-tag-"]')]
    .map((node) => node.dataset.testid!)
    .filter((id) => /^chat-tag-[a-z]+$/.test(id) && id !== 'chat-tag-empty')
    .map((id) => id.slice('chat-tag-'.length));
const menuRow = (handle: string) => byTestID(`mention-suggestion-${handle}`)!;
const menuChecks = () =>
  AGENTS.filter((agent) => byTestID(`mention-suggestion-${agent.handle}-checked`)).map(
    (agent) => agent.handle,
  );
// What a person can read: the hidden input under the waveform does not count.
const visibleText = () => {
  const page = document.body.cloneNode(true) as HTMLElement;
  page.querySelectorAll('textarea, #result').forEach((node) => node.remove());
  return page.textContent ?? '';
};
const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;

async function dictate(words: string) {
  await tap('chat-mic');
  await pause();
  speechProofRecognizer.emit('volumechange', { value: 6 });
  speechProofRecognizer.emit('result', { isFinal: true, results: [{ transcript: words }] });
  await pause();
}

async function run() {
  // The person keeps talking, so the silence stop never ends a take early.
  setInterval(() => speechProofRecognizer.emit('volumechange', { value: 4 }), 500);
  await pause();
  // 1 Idle: the prefilled agent is a chip; the field is empty and keeps the mic.
  check('idle: the prefilled @ruby shows as a chip', chips().join() === 'ruby');
  check(
    'idle: the field reads empty',
    (byTestID('chat-input') as HTMLTextAreaElement).value === '',
  );
  check('idle: the mic is available', Boolean(byTestID('chat-mic')));
  const edit = byTestID('chat-tag-ruby-edit')!.getBoundingClientRect();
  const remove = byTestID('chat-tag-ruby-remove')!.getBoundingClientRect();
  const row = byTestID('chat-composer-input-row')!.getBoundingClientRect();
  lines.push(
    `chip targets: body ${edit.width}x${edit.height}, × ${remove.width}x${remove.height}, row ${row.height}`,
  );
  const face = byTestID('chat-tag-ruby')!.getBoundingClientRect();
  const xFace = (
    byTestID('chat-tag-ruby-remove')!.firstElementChild as HTMLElement
  ).getBoundingClientRect();
  lines.push(
    `pill: ${Math.round(xFace.right - face.left)}px wide, × cell ${Math.round(xFace.width)}px`,
  );
  check(
    'idle: the × target is 44 wide over the ×, and both targets are 26 tall with 9 px slop like ＋',
    remove.width === 44 &&
      remove.left <= xFace.left &&
      remove.right >= xFace.right &&
      edit.height === 26 &&
      remove.height === 26,
  );
  check(
    'idle: the pill is the handle plus a 20 px ×, in one piece',
    xFace.width === 20 && Math.abs(xFace.left - face.right) < 0.5,
  );
  if (stopAt === 'idle') return;

  // 2 Tap the chip: MENTION lists the agents, ✓ on the tagged ones; taps toggle.
  await tap('chat-tag-ruby-edit');
  check('menu: tapping the chip opens MENTION', Boolean(byTestID('mention-suggestions')));
  check('menu: ✓ marks Ruby only', menuChecks().join() === 'ruby');
  check('menu: the keyboard does not open', document.activeElement !== byTestID('chat-input'));
  menuRow('sol').click();
  await pause();
  check('menu: tapping Sol adds a second chip', chips().join() === 'ruby,sol');
  check('menu: the menu stays open with ✓ on Ruby and Sol', menuChecks().join() === 'ruby,sol');
  check('menu: the text sends as "@ruby @sol "', state.value === '@ruby @sol ');
  if (stopAt === 'menu') return;
  menuRow('sol').click();
  await pause();
  check('menu: tapping Sol again removes its chip', chips().join() === 'ruby');
  await tap('tag-menu-backdrop');
  check('menu: a tap outside closes it', !byTestID('mention-suggestions'));

  // 3 Many tags: the chips scroll in a capped strip; the field and mic keep their room.
  await tap('chat-tag-ruby-edit');
  for (const handle of ['sol', 'fathom', 'goosy', 'hoots', 'milo']) {
    menuRow(handle).click();
    await pause();
  }
  await tap('tag-menu-backdrop');
  const strip = byTestID('chat-tags')!.getBoundingClientRect();
  const inputRow = byTestID('chat-composer-input-row')!.getBoundingClientRect();
  const mic = byTestID('chat-mic')!.getBoundingClientRect();
  lines.push(
    `six chips: strip ${Math.round(strip.width)}px of row ${Math.round(inputRow.width)}px`,
  );
  check('many: all six agents are tagged', chips().length === 6);
  const rubyEnd = (
    byTestID('chat-tag-ruby-remove')!.firstElementChild as HTMLElement
  ).getBoundingClientRect();
  const solStart = byTestID('chat-tag-sol')!.getBoundingClientRect();
  lines.push(`gap between pills: ${Math.round(solStart.left - rubyEnd.right)}px`);
  // The × target reaches over its own handle and the next pill, and is drawn above both.
  const rubyX = byTestID('chat-tag-ruby-remove')!;
  const rubyXTarget = rubyX.getBoundingClientRect();
  const solEdit = byTestID('chat-tag-sol-edit')!.getBoundingClientRect();
  const rubyEdit = byTestID('chat-tag-ruby-edit')!.getBoundingClientRect();
  lines.push(
    `× target ${Math.round(rubyXTarget.left)}–${Math.round(rubyXTarget.right)}, handle ends ${Math.round(rubyEdit.right)}, next handle starts ${Math.round(solEdit.left)}, z ${getComputedStyle(rubyX).zIndex}`,
  );
  check(
    'many: the × target overlaps the handle and the next pill and sits above them',
    rubyXTarget.left < rubyEdit.right &&
      rubyXTarget.right > solEdit.left &&
      Number(getComputedStyle(rubyX).zIndex) >
        (Number(getComputedStyle(byTestID('chat-tag-sol-edit')!).zIndex) || 0),
  );
  check('many: pills sit 4 px apart, as in v6', Math.abs(solStart.left - rubyEnd.right - 4) < 0.5);
  check('many: the chip strip takes at most half the row', strip.width <= inputRow.width / 2 + 0.5);
  check('many: the mic stays fully inside the composer', mic.width > 0 && inside(mic, inputRow));
  if (stopAt === 'many') return;
  for (const handle of ['milo', 'hoots', 'goosy', 'fathom', 'sol'])
    await tap(`chat-tag-${handle}-remove`);
  check('many: × removes chips back to @ruby', chips().join() === 'ruby');

  // R1 Quote reply: the banner sits above; the agent is a chip; the mic stays.
  state.setReply(true);
  await pause();
  check('R1: the reply banner shows', Boolean(byTestID('reply-composer-banner')));
  check(
    'R1: the agent is a chip and the field is empty',
    chips().join() === 'ruby' && !byTestID('chat-send'),
  );

  // R2 Recording in a quote reply: only the input row changes.
  await dictate('make the stop button keep the reply');
  check('R2: the waveform shows', Boolean(byTestID('chat-speech-waveform')));
  check(
    'R2: ■ takes the ＋ slot',
    Boolean(byTestID('chat-speech-discard')) && !byTestID('chat-attach-button'),
  );
  check('R2: the banner stays', Boolean(byTestID('reply-composer-banner')));
  check(
    'R2: no dictated words show',
    !visibleText().includes('keep the reply') &&
      getComputedStyle(byTestID('chat-input')!).opacity === '0',
  );
  if (stopAt === 'reply-recording') return;

  // R3 Remove the chip while recording: the dashed @ chip takes its place.
  await tap('chat-tag-ruby-remove');
  check('R3: the dashed @ chip shows', Boolean(byTestID('chat-tag-empty')));
  check('R3: the reply stays threaded', Boolean(byTestID('reply-composer-banner')));
  await tap('chat-tag-empty');
  check(
    'R3: the dashed chip opens MENTION while recording',
    Boolean(byTestID('mention-suggestions')),
  );
  menuRow('ruby').click();
  await pause();
  await tap('tag-menu-backdrop');
  check(
    'R3: the pick replaces the dashed chip',
    chips().join() === 'ruby' && !byTestID('chat-tag-empty'),
  );
  check(
    'R3: recording kept going',
    Boolean(byTestID('chat-speech-waveform')) && speechProofRecognizer.started === 1,
  );
  if (stopAt === 'reply-dashed') return;

  // R4 Stop and send: the message waits to publish; ■ still drops it.
  await tap('chat-mic');
  await pause();
  check('R4: the message is on its way', state.held.length === 1);
  check(
    'R4: the gold mark replaces the mic while it is sent',
    Boolean(byTestID('chat-speech-finalizing')),
  );
  check('R4: ■ stays while it is sent', Boolean(byTestID('chat-speech-discard')));
  check(
    'R4: the waveform stays, frozen, while it is sent',
    (byTestID('chat-speech-waveform')?.children.length ?? 0) > 0,
  );
  if (stopAt === 'sending') return;
  await tap('chat-speech-discard');
  state.held.shift()!();
  await pause();
  check('R4 ■: nothing reaches the Room', state.sent.length === 0);
  check(
    'R4 ■: the chip and the banner stay',
    chips().join() === 'ruby' && Boolean(byTestID('reply-composer-banner')),
  );
  check('R4 ■: the dictated words are gone', state.value === '@ruby ');
  check('R4 ■: ＋ returns', Boolean(byTestID('chat-attach-button')));

  await dictate('make the stop button keep the reply');
  await tap('chat-mic');
  state.held.shift()!();
  await pause();
  check(
    'R4 sent: a quote reply to Ruby with the @ruby tag',
    state.sent.length === 1 &&
      state.sent[0].replyTo === 'ruby' &&
      state.sent[0].text === '@ruby make the stop button keep the reply' &&
      state.sent[0].wakes === 'ruby',
  );
  check(
    'R4 sent: the banner and chip clear',
    !byTestID('reply-composer-banner') && chips().length === 0,
  );
  check(
    'R4 sent: ＋ returns',
    Boolean(byTestID('chat-attach-button')) && !byTestID('chat-speech-discard'),
  );

  // G: a recorded take that Groq transcribes, sent as an untagged quote reply.
  speechProofRecognizer.recording = true;
  state.setValue('@ruby ');
  state.setReply(true);
  await pause();
  await tap('chat-tag-ruby-remove');
  check('G: the reply is untagged', chips().length === 0 && state.value === '');
  await tap('chat-mic');
  for (let level = 1; level <= 8; level += 1) {
    speechProofRecognizer.emit('volumechange', { value: level });
    await pause();
  }
  // The on-device guess, which Groq's text replaces.
  speechProofRecognizer.emit('result', {
    isFinal: false,
    results: [{ transcript: 'keep the reply thread it' }],
  });
  await pause();
  await tap('chat-mic');
  const bars = [...(byTestID('chat-speech-waveform')?.children ?? [])] as HTMLElement[];
  check('G: Groq is transcribing the take', state.groq.length === 1);
  check(
    'G: the gold mark replaces the mic while Groq transcribes',
    Boolean(byTestID('chat-speech-finalizing')),
  );
  check(
    'G: the waveform freezes grey',
    bars.length > 0 &&
      bars.every((bar) => getComputedStyle(bar).backgroundColor === rgb(theme.textMuted)),
  );
  check('G: nothing is sent before Groq answers', state.held.length === 0);
  if (stopAt === 'groq') return;
  state.groq.shift()!('Keep the reply threaded.');
  await pause();
  check('G: the Groq text goes out', state.held.length === 1);
  state.held.shift()!();
  await pause();
  const last = state.sent.at(-1);
  lines.push(`G sent: ${JSON.stringify(last)}`);
  check(
    "G sent: Groq's text, as a quote reply to Ruby, waking no one",
    last?.text === 'Keep the reply threaded.' && last.replyTo === 'ruby' && !last.wakes,
  );
}

function rgb(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

run()
  .catch((error) => lines.push(`FAIL proof threw ${String(error)}`))
  .finally(() => {
    const failed = lines.some((line) => line.startsWith('FAIL'));
    result.textContent = [...lines, `RESULT ${failed ? 'FAIL' : 'PASS'}`].join('\n');
  });
