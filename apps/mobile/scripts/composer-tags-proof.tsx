import React, { useRef, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { roomComposerTagHandles } from '../sources/buzz/composer-tags';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { MentionSuggestionMenu } from '../sources/components/buzz/MentionSuggestionMenu';
import type { RoomRosterParticipant } from '../sources/components/buzz/RoomRosterSheet';
import { beelineThemes, type BeelineThemeName } from '../sources/buzz/groknight';
import {
  activeMentionAtCursor,
  filterMentionCandidates,
  replaceActiveMention,
} from '../sources/buzz/room-participants';

// Room member tags in the web composer: plain text, one backspace deletes a
// whole tag, and the @ suggestions still open while a handle is typed.
// `?auto=1` runs the checks below; without it the page waits to be driven by
// real key presses (chrome-devtools-axi), reading `composerTagsProof.state()`.

const query = new URLSearchParams(location.search);
const theme = beelineThemes[(query.get('theme') ?? 'obsidian') as BeelineThemeName];
document.body.style.background = theme.bgBase;

const ROSTER: RoomRosterParticipant[] = ['Ruby', 'Sol', 'Speedy', 'Milo'].map((name) => ({
  pubkey: name.toLowerCase().padEnd(64, '0'),
  name,
  handle: name.toLowerCase(),
  kind: 'agent',
}));
const TAG_HANDLES = roomComposerTagHandles(ROSTER);

const state = {
  value: '',
  selection: { start: 0, end: 0 },
  setValue: (_: string) => undefined as void,
};

// The menu wiring follows _chat-surface.tsx: suggestions for the mention
// fragment at a collapsed cursor while the field is focused.
function Proof() {
  const [value, setValue] = useState(query.get('value') ?? '');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  state.value = value;
  state.selection = selection;
  state.setValue = setValue;
  const mention =
    selection.start === selection.end ? activeMentionAtCursor(value, selection.start) : null;
  const suggestions = mention
    ? filterMentionCandidates(ROSTER, mention.query)
    : { matches: [], overflow: 0 };
  return (
    <View
      style={{ width: 390, height: 360, justifyContent: 'flex-end', backgroundColor: theme.bgBase }}
    >
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.textSecondary }}>Ruby · Posted the composer tags mock.</Text>
      </View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        {focused && suggestions.matches.length > 0 && (
          <MentionSuggestionMenu
            highlightedIndex={0}
            keyboardOpen={false}
            matches={suggestions.matches}
            onSelect={(participant) => {
              if (!mention) return;
              const inserted = replaceActiveMention(value, mention, participant.handle);
              setValue(inserted.text);
              requestAnimationFrame(() =>
                inputRef.current?.setSelectionRange(inserted.cursor, inserted.cursor),
              );
            }}
            overflow={suggestions.overflow}
            personAvatar={() => undefined}
          />
        )}
        <ConversationComposer
          value={value}
          height={26}
          focused={focused}
          disabled={false}
          hasAgentMembers
          speechEnabled={false}
          tagHandles={TAG_HANDLES}
          inputRef={(node) => {
            inputRef.current = node as unknown as HTMLTextAreaElement | null;
          }}
          onAttach={() => undefined}
          onBlur={() => setFocused(false)}
          onChangeText={setValue}
          onContentSizeChange={() => undefined}
          onFocus={() => setFocused(true)}
          onKeyPress={() => undefined}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          onSend={() => undefined}
        />
      </View>
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Proof />);

const input = () => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!;
const byTestID = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
(globalThis as { composerTagsProof?: unknown }).composerTagsProof = {
  state: () => ({
    value: state.value,
    cursor: input().selectionStart,
    menu: [...document.querySelectorAll<HTMLElement>('[data-testid^="mention-suggestion-"]')]
      .map((row) => row.dataset.testid!.slice('mention-suggestion-'.length))
      .filter((handle) => !['scroll', 'overflow'].includes(handle)),
    tagNodes: document.querySelectorAll('[data-testid^="chat-tag"]').length,
    textIndent: getComputedStyle(input()).textIndent,
    paddingTop: getComputedStyle(input()).paddingTop,
    height: input().getBoundingClientRect().height,
  }),
  put: (value: string, cursor = value.length) => {
    state.setValue(value);
    setTimeout(() => {
      input().focus();
      input().setSelectionRange(cursor, cursor);
    }, 50);
  },
};

const result = document.getElementById('result')!;
const lines: string[] = [];
function check(label: string, pass: boolean, detail = '') {
  lines.push(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

async function put(value: string, cursor = value.length) {
  state.setValue(value);
  await pause();
  input().focus();
  input().setSelectionRange(cursor, cursor);
  // React reads a caret move from the browser's selection events.
  document.dispatchEvent(new Event('selectionchange'));
  input().dispatchEvent(new Event('select', { bubbles: true }));
  await pause();
}

/** A Backspace (or other) key press; true when the composer handled it itself. */
async function backspace(key = 'Backspace') {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  input().dispatchEvent(event);
  await pause();
  return event.defaultPrevented;
}

async function run() {
  await pause();
  await put('hello make it smaller');
  const plainHeight = input().getBoundingClientRect().height;

  // A leading tag is ordinary text of the field.
  await put('@ruby make it smaller');
  const style = getComputedStyle(input());
  check('the field holds the leading tag as its own text', input().value === '@ruby make it smaller');
  check('no tag pill or overlay', document.querySelectorAll('[data-testid^="chat-tag"]').length === 0);
  check('no first-line indent', style.textIndent === '0px' && style.paddingTop === '0px',
    `${style.textIndent} ${style.paddingTop}`);
  check('one line high, as without a tag', input().getBoundingClientRect().height === plainHeight,
    `${input().getBoundingClientRect().height} vs ${plainHeight}`);

  // One backspace after a tag deletes it, at the start, middle and end.
  for (const [text, at, next, cursor] of [
    ['@ruby make it smaller', 5, ' make it smaller', 0],
    ['ask @speedy and @sol now', 11, 'ask  and @sol now', 4],
    ['thanks @sol', 11, 'thanks ', 7],
  ] as const) {
    await put(text, at);
    const handled = await backspace();
    check(`backspace after the tag in "${text}" deletes the whole tag`,
      handled && state.value === next, JSON.stringify(state.value));
    check(`the cursor lands where the tag began (${cursor})`, input().selectionStart === cursor,
      String(input().selectionStart));
  }
  await put('@ruby');
  await backspace();
  check('the only tag goes and the placeholder shows',
    input().value === '' && input().placeholder === 'Tag an agent with @');

  // Everything else is the browser's own one-character delete.
  await put('@ruby ', 6);
  check('after the space, backspace is left to the browser', !(await backspace()));
  await put('@spee', 5);
  check('a half-typed handle that is no member is left to the browser', !(await backspace()));
  await put('@ruby hi', 4);
  check('a forward delete inside a tag is left to the browser', !(await backspace('Delete')));

  // The @ suggestions still open while typing a handle, at the start and mid-message.
  await put('@ru');
  check('typing @ru at the start opens the suggestions',
    Boolean(byTestID('mention-suggestions')) && Boolean(byTestID('mention-suggestion-ruby')));
  await put('thanks @sp');
  check('typing @sp mid-message opens the suggestions',
    Boolean(byTestID('mention-suggestion-speedy')));
  byTestID('mention-suggestion-speedy')!.click();
  await pause();
  check('picking a suggestion completes the tag', state.value.trimEnd() === 'thanks @speedy',
    JSON.stringify(state.value));
  lines.push(`RESULT ${lines.every((line) => line.startsWith('PASS')) ? 'PASS' : 'FAIL'}`);
}

if (query.get('auto') === '1') {
  run()
    .catch((error: unknown) => lines.push(`FAIL ${String(error)}`, 'RESULT FAIL'))
    .finally(() => {
      result.textContent = lines.join('\n');
    });
} else {
  result.textContent = '';
}
