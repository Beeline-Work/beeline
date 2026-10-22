import React, { useEffect, useState } from 'react';
// @ts-expect-error Standalone browser proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { answerPrefillCandidate, planAnswerPrefill } from '../sources/buzz/composer-prefill';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

const messages: ChatDisplayMessage[] = [
  { id: 'question', relayId: 'relay-question', pubkey: 'giselle', isUser: true, timestamp: 1,
    text: '@charles can you find me this for luna?' },
];
function Viewer({ pubkey }: { pubkey: string }) {
  const [rows, setRows] = useState(messages);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setRows([...messages, {
      id: 'answer', pubkey: 'charles-agent', isUser: false, isAgentAuthor: true,
      timestamp: 2, text: 'Found it for Luna.', requestId: 'relay-question',
    }]), 100);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const candidate = answerPrefillCandidate(rows, pubkey, () => 'charles');
    const plan = planAnswerPrefill({ draft: '', prefill: null, candidate, offered: new Set() });
    if (plan.kind === 'fill') setDraft(plan.text);
  }, [rows, pubkey]);
  return <section><h2>{pubkey}</h2>{rows.map(row => <p key={row.id}>{row.text}</p>)}
    <ConversationComposer value={draft} height={26} focused={false} disabled={false}
      testIDPrefix={pubkey} tagHandles={new Set(['charles'])} speechEnabled={false}
      onBlur={() => {}} onChangeText={setDraft} onContentSizeChange={() => {}}
      onFocus={() => {}} onKeyPress={() => {}} onSend={() => {}} />
  </section>;
}
createRoot(document.getElementById('root')!).render(<><Viewer pubkey="giselle" /><Viewer pubkey="other-human" /></>);
setTimeout(() => {
  const inputs = [...document.querySelectorAll('textarea,input')].filter(node => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) as (HTMLInputElement | HTMLTextAreaElement)[];
  const values = inputs.map(node => node.value);
  document.getElementById('result')!.textContent = 'Requester draft: ' + JSON.stringify(values[0]) + '\nOther draft: ' + JSON.stringify(values[1]) + '\nRESULT ' +
    (values.length === 2 && values[0] === '@charles ' && values[1] === '' ? 'PASS' : 'FAIL');
}, 1000);
