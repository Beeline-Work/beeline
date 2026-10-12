/** Browser proof uses the production composer and real Space Grotesk face. */
import React, { useState } from 'react';
// @ts-expect-error Installed react-dom lacks declarations in the mobile workspace.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
const handles = new Set(['ruby']);
const proof = { set: (_: { value: string; viewer: boolean; scale: number; focused: boolean }) => {} };
function Proof() {
  const [state, setState] = useState({ value: '', viewer: false, scale: 1, focused: false });
  proof.set = setState;
  return <View style={{ width: 390, height: 300, paddingHorizontal: 16, justifyContent: 'center' }}>
    <style>{`[data-testid="chat-input"] { font-size: ${16*state.scale}px !important; }
      [data-testid="chat-tag-ruby"] { font-size: ${13*state.scale}px !important; }`}</style>
    <View style={state.viewer ? { borderWidth: 1, borderColor: '#8a6323' } : undefined}>
      <ConversationComposer value={state.value} height={26} focused={state.focused} disabled={false}
        viewerPill={state.viewer} tagHandles={handles} speechEnabled={false} onAttach={() => {}}
        onBlur={() => {}} onFocus={() => {}} onChangeText={value => setState(current => ({ ...current, value }))}
        onContentSizeChange={() => {}} onKeyPress={() => {}} onSend={() => {}} />
    </View>
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
(globalThis as { hintProof?: unknown }).hintProof = proof;
