import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';

function Proof() {
  const [value, setValue] = useState('');
  (window as any).__recorderText = value;
  return <ConversationComposer value={value} height={26} focused={false} disabled={false}
    speechHints={['Jellybean', 'Ruby']} onBlur={() => {}} onChangeText={text => {
      (window as any).__recorderText = text;
      setValue(text);
    }}
    onContentSizeChange={() => {}} onFocus={() => {}} onKeyPress={() => {}}
    onSend={() => { (window as any).__recorderSent = (window as any).__recorderText; }} />;
}
createRoot(document.getElementById('root')!).render(<Proof />);
