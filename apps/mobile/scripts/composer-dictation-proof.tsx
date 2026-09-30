import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Platform, View } from 'react-native';
import { buildSpeechLexicon } from '../sources/buzz/speech-lexicon';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { speechProofRecognizer } from './composer-dictation-proof-recognizer';

// The composer dictates on Android; the page stands in for an Android 14 phone
// whose recognizer is the scripted one in composer-dictation-proof-recognizer.
Object.defineProperty(Platform, 'OS', { value: 'android' });
Object.defineProperty(Platform, 'Version', { value: 34 });

const stopAt = new URLSearchParams(location.search).get('stop');
const DICTATION =
  'so the issue is not that the nav thing exists. It is that the screen for the Beeline app ' +
  'does not terminate as a mass screen. So here is a good example. You go to the workbench, ' +
  'the bottom of the page shows the corner list and the last words I said are right here';

// The #beeline Room as the screenshot in the report shows it.
const ROOM_LEXICON = buildSpeechLexicon({
  roomName: 'beeline',
  repositoryName: 'Beeline-Work/beeline',
  memberNames: ['Niglet', 'Sol', 'Emberus'],
  memberHandles: ['niglet', 'sol', 'emberus'],
  messages: [
    'The corner checks passed; Sol reviews the brief next.',
    'Open the Workbench and run `pr_checks_status` after the handoff.',
    'The Workbench keys are wired to useSpeechInput now.',
    'Did useSpeechInput pick up the Room names?',
  ],
});

function Proof() {
  const [value, setValue] = useState('');
  return (
    <View style={{ width: 390, padding: 12 }}>
      <ConversationComposer
        value={value}
        height={26}
        focused
        disabled={false}
        onBlur={() => undefined}
        onChangeText={setValue}
        onContentSizeChange={() => undefined}
        onFocus={() => undefined}
        onKeyPress={() => undefined}
        onSend={() => undefined}
        speechHints={ROOM_LEXICON}
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

async function run() {
  await pause();
  byTestID('chat-mic')!.click();
  await pause();
  const dialog = byTestID('chat-speech-model-dialog');
  check(
    'mic tap without the on-device model opens the Beeline model dialog',
    Boolean(dialog?.textContent?.includes('Download the voice model?')),
  );
  check(
    'the platform is not asked for the model before the person answers',
    speechProofRecognizer.downloadRequests.length === 0,
  );
  if (stopAt === 'dialog') return;
  byTestID('chat-speech-model-decline')?.click();
  await pause();
  check('Not now starts dictation', speechProofRecognizer.started > 0);
  const primed = speechProofRecognizer.lastStartOptions?.contextualStrings ?? [];
  lines.push(`recognizer primed with: ${primed.join(', ')}`);
  check(
    'the recognizer is primed with the Room name and the project lexicon',
    ['beeline', 'Beeline', 'Beeline-Work', 'Workbench', 'useSpeechInput', 'handoff'].every((term) =>
      primed.includes(term),
    ),
  );

  // The recognizer revises one growing hypothesis, as Android does.
  const words = DICTATION.split(' ');
  for (let count = 4; count <= words.length; count += 4) {
    speechProofRecognizer.emit('result', {
      isFinal: false,
      results: [{ transcript: words.slice(0, count).join(' ') }],
    });
    await pause();
  }
  speechProofRecognizer.emit('result', { isFinal: false, results: [{ transcript: DICTATION }] });
  // The person is still talking, so the silence stop never fires.
  setInterval(() => speechProofRecognizer.emit('volumechange', { value: 6 }), 500);
  await pause();

  const overlay = byTestID('chat-speech-interim')!;
  const box = overlay.getBoundingClientRect();
  const walker = document.createTreeWalker(overlay, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent ?? '').trim()) last = walker.currentNode as Text;
  }
  const range = document.createRange();
  range.setStart(last!, last!.length - 'right here'.length);
  range.setEnd(last!, last!.length);
  const newest = range.getBoundingClientRect();
  lines.push(
    `overlay top=${box.top.toFixed(1)} bottom=${box.bottom.toFixed(1)}; ` +
      `newest words top=${newest.top.toFixed(1)} bottom=${newest.bottom.toFixed(1)}`,
  );
  check(
    'the transcript outgrows the composer field',
    (overlay.firstElementChild as HTMLElement).getBoundingClientRect().height > box.height,
  );
  check(
    'the newest dictated words are inside the visible field',
    newest.top >= box.top - 0.5 && newest.bottom <= box.bottom + 0.5,
  );
}

run()
  .catch((error) => lines.push(`FAIL proof threw ${String(error)}`))
  .finally(() => {
    const failed = lines.some((line) => line.startsWith('FAIL'));
    result.textContent = [...lines, `RESULT ${failed ? 'FAIL' : 'PASS'}`].join('\n');
  });
