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
  const sheet = document.querySelector('[data-testid="direct-message-picker"]')!.getBoundingClientRect();
  const rows = [...document.querySelectorAll('[data-testid^="message-workspace-member-"]')];
  const leftOfText = (node: Element) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().left - sheet.left;
  };
  const headers = [...document.querySelectorAll('*')].filter(node =>
    node.children.length === 0 && /^(people|agents)$/i.test(node.textContent ?? ''));
  const titleText = document.createRange();
  titleText.selectNodeContents(title);
  document.getElementById('result')!.textContent = JSON.stringify({
    titleInset: titleText.getBoundingClientRect().left - sheet.left,
    searchLeftInset: search.getBoundingClientRect().left - sheet.left + parseFloat(getComputedStyle(search).paddingLeft),
    searchRightInset: sheet.right - search.getBoundingClientRect().right + parseFloat(getComputedStyle(search).paddingRight),
    rowCount: rows.length,
    nestedButtons: rows.reduce((total, row) => total + row.querySelectorAll('[role="button"]').length, 0),
    rowLeadInsets: rows.map(row => row.firstElementChild!.getBoundingClientRect().left - sheet.left),
    headerInsets: headers.map(leftOfText),
    busyValues: rows.map(row => row.textContent?.includes('Opening…') ?? false),
  });
}, 500);
