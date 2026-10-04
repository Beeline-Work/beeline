import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Platform, View } from 'react-native';
import { buildSpeechLexicon } from '../sources/buzz/speech-lexicon';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { speechProofRecognizer } from './composer-dictation-proof-recognizer';

// An Android 14 phone with Google's recognition service installed, as on a
// Samsung A15 whose default service is Samsung's own.
Object.defineProperty(Platform, 'OS', { value: 'android' });
Object.defineProperty(Platform, 'Version', { value: 34 });
const GOOGLE = 'com.google.android.googlequicksearchbox';
speechProofRecognizer.services = ['com.samsung.android.bixby.agent', GOOGLE];

// A Room that has been talking about speech providers.
const ROOM_LEXICON = buildSpeechLexicon({
  roomName: 'Speech to text',
  memberNames: ['Ruby'],
  messages: [
    'Calling Groq directly bills every request for at least 10 s, so OpenRouter is cheaper.',
    'OpenRouter can fail over between DeepInfra and Groq.',
  ],
});
// What the recognizer heard when the person said "compare Groq and OpenRouter pricing".
const HEARD = [
  { transcript: 'compare crack and open router pricing' },
  { transcript: 'compare croc and open rotor pricing' },
];

let latest = '';
function Proof() {
  const [value, setValue] = useState('');
  latest = value;
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
  lines.push(`Room lexicon: ${ROOM_LEXICON.join(', ')}`);
  byTestID('chat-mic')!.click();
  await pause();
  check('mic tap does not offer the on-device model', !byTestID('chat-speech-model-dialog'));
  const options = speechProofRecognizer.lastStartOptions;
  lines.push(
    `recognizer started: service=${options?.androidRecognitionServicePackage} ` +
      `onDevice=${options?.requiresOnDeviceRecognition}`,
  );
  check(
    "dictation runs on Google's server recognizer",
    speechProofRecognizer.started === 1 &&
      options?.androidRecognitionServicePackage === GOOGLE &&
      options?.requiresOnDeviceRecognition === false,
  );
  lines.push(`recognizer heard: ${HEARD.map((alternative) => alternative.transcript).join(' | ')}`);
  speechProofRecognizer.emit('result', { isFinal: true, results: HEARD });
  await pause();
  lines.push(`composer shows: ${latest}`);
  check(
    'the composer shows the Room terms spelled right',
    latest === 'compare Groq and OpenRouter pricing',
  );
}

run()
  .catch((error) => lines.push(`FAIL proof threw ${String(error)}`))
  .finally(() => {
    const failed = lines.some((line) => line.startsWith('FAIL'));
    result.textContent = [...lines, `RESULT ${failed ? 'FAIL' : 'PASS'}`].join('\n');
  });
