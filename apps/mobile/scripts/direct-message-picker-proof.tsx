import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { DirectMessagePickerSheet } from '../sources/components/buzz/DirectMessagePickerSheet';

const busy = new URLSearchParams(location.search).get('busy');
const member = (peerPubkey: string, peerName: string, peerKind: 'person' | 'agent') =>
  ({ peerPubkey, peerName, peerKind }) as React.ComponentProps<typeof DirectMessagePickerSheet>['members'][number];

createRoot(document.getElementById('root')!).render(
  <View style={{ width: 390 }}>
    <DirectMessagePickerSheet
      busyPubkey={busy}
      members={[
        member('pubkey-banana', 'bananaman614305', 'person'),
        member('pubkey-chloro', 'chloropine', 'person'),
        member('pubkey-baby', 'Baby', 'agent'),
      ]}
      onClose={() => {}}
      onMessage={() => {}}
      visible
    />
  </View>,
);

setTimeout(() => {
  const title = [...document.querySelectorAll('[role="heading"]')].find(node => node.textContent === 'Message')!;
  const search = document.querySelector('[data-testid="direct-message-picker-search"]')!;
  const buttons = [...document.querySelectorAll('[role="button"]')].filter(node =>
    node.textContent === 'Message' || node.textContent === 'Opening…');
  const sheet = document.querySelector('[data-testid="direct-message-picker"]')!.getBoundingClientRect();
  const titleText = document.createRange();
  titleText.selectNodeContents(title);
  document.getElementById('result')!.textContent = JSON.stringify({
    titleInset: titleText.getBoundingClientRect().left - sheet.left,
    searchLeftInset: search.getBoundingClientRect().left - sheet.left + parseFloat(getComputedStyle(search).paddingLeft),
    searchRightInset: sheet.right - search.getBoundingClientRect().right + parseFloat(getComputedStyle(search).paddingRight),
    messageButtonBorders: buttons.map(node => getComputedStyle(node).borderTopColor),
  });
}, 500);
