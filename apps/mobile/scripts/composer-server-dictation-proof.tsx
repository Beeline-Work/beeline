import React, { useRef, useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';

function Proof() {
  const [value, setValue] = useState('');
  const draft = useRef('');
  return (
    <ConversationComposer
      value={value}
      height={26}
      focused={true}
      disabled={false}
      speechHints={['Beeline', 'Jellybean']}
      onBlur={() => {}}
      onChangeText={(text) => {
        draft.current = text;
        setValue(text);
      }}
      onContentSizeChange={() => {}}
      onFocus={() => {}}
      onKeyPress={() => {}}
      onSend={() => {
        document.getElementById('sent')!.textContent = draft.current;
        draft.current = '';
        setValue('');
      }}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
