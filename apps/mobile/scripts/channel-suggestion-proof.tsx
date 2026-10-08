import React, { useMemo, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import {
  buildChannelReferenceIndex,
  findChannelReferences,
} from '../sources/buzz/channel-reference';
import {
  activeChannelAtCursor,
  channelSuggestionCandidates,
  filterChannelSuggestions,
  replaceActiveChannel,
} from '../sources/buzz/channel-suggestions';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { ChannelSuggestionMenu } from '../sources/components/buzz/MentionSuggestionMenu';

/**
 * The composer `#` menu as the chat screen wires it: the Room list's Rooms and
 * the current Room's corners. Types the reported `#exp`, taps a corner row and
 * checks the inserted token links to that corner once sent.
 */
const ROOMS = [
  { id: 'r-beeline', name: 'beeline' },
  { id: 'r-experiments', name: 'experiments' },
  { id: 'r-export', name: 'export-logs' },
];
const CORNERS = [
  { id: 'c-flags', name: 'experiment-flags' },
  { id: 'c-chip', name: 'composer-handle-chip' },
];
const stopAt = new URLSearchParams(location.search).get('stop');

let latest = '';
function Proof() {
  const [value, setValue] = useState('');
  latest = value;
  const active = activeChannelAtCursor(value, value.length);
  const suggestions = useMemo(
    () =>
      active
        ? filterChannelSuggestions(
            channelSuggestionCandidates(ROOMS, { name: 'beeline' }, CORNERS),
            active.query,
          )
        : { matches: [], overflow: 0 },
    [active?.query],
  );
  return (
    <View style={{ width: 390, padding: 12, backgroundColor: '#14091A' }}>
      {suggestions.matches.length > 0 && active && (
        <ChannelSuggestionMenu
          highlightedIndex={0}
          keyboardOpen
          matches={suggestions.matches}
          onSelect={(suggestion) =>
            setValue(replaceActiveChannel(value, active, suggestion.token).text)
          }
          overflow={suggestions.overflow}
        />
      )}
      <ConversationComposer
        value={value}
        height={26}
        focused
        disabled={false}
        speechEnabled={false}
        onBlur={() => undefined}
        onChangeText={setValue}
        onContentSizeChange={() => undefined}
        onFocus={() => undefined}
        onKeyPress={() => undefined}
        onSend={() => undefined}
      />
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
function type(text: string) {
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid^="channel-suggestion-"]')]
    .map((row) => row.dataset.testid!.slice('channel-suggestion-'.length))
    .filter((token) => token !== 'overflow');

async function run() {
  await pause();
  type('@ruby what is the difference between #exp');
  await pause();
  lines.push(`typed: ${latest}`);
  lines.push(`rows: ${rows().join(' | ')}`);
  check('typing #exp opens the Rooms and corners list', Boolean(byTestID('channel-suggestions')));
  check(
    'matching Rooms lead, then the current Room corner',
    rows().join(',') === 'experiments,export-logs,beeline/experiment-flags',
  );
  const cornerRow = byTestID('channel-suggestion-beeline/experiment-flags')!;
  check('the corner row draws the corner glyph', Boolean(cornerRow.querySelector('svg')));
  check(
    'a Room row draws the # glyph',
    byTestID('channel-suggestion-experiments')!.textContent!.startsWith('#'),
  );
  if (stopAt === 'menu') return;

  cornerRow.click();
  await pause();
  lines.push(`after tap: ${latest}`);
  check(
    'the tap inserts the exact corner token',
    latest === '@ruby what is the difference between #beeline/experiment-flags ',
  );
  check('the list closes after the pick', !byTestID('channel-suggestions'));
  const links = findChannelReferences(
    latest,
    buildChannelReferenceIndex(
      [{ channelId: 'r-beeline', name: 'beeline' }],
      [{ channelId: 'c-flags', parentChannelId: 'r-beeline', name: 'experiment-flags' }],
    ),
  );
  check('the sent text links to that corner', links[0]?.target.channelId === 'c-flags');

  type(`${latest}and #beeline/`);
  await pause();
  lines.push(`rows for #beeline/: ${rows().join(' | ')}`);
  check(
    '#beeline/ lists that Room corners',
    rows().join(',') === 'beeline/experiment-flags,beeline/composer-handle-chip',
  );
}

run()
  .catch((error) => lines.push(`FAIL proof threw ${String(error)}`))
  .finally(() => {
    const failed = lines.some((line) => line.startsWith('FAIL'));
    result.textContent = [...lines, `RESULT ${failed ? 'FAIL' : 'PASS'}`].join('\n');
  });
