import React from 'react';
// @ts-expect-error Standalone browser proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { HullActionSheetModal, HullActionSheetRow } from '@/components/buzz/HullActionSheet';

function Surface() {
  const [visible, setVisible] = React.useState(true);
  return <View><HullActionSheetModal visible={visible} onClose={() => setVisible(false)} title="Members" testID="width-sheet">
    {Array.from({ length: 40 }, (_, index) => <HullActionSheetRow key={index} label={`Member ${index + 1}`} onPress={() => undefined} />)}
  </HullActionSheetModal><Text testID="closed">{visible ? 'open' : 'closed'}</Text></View>;
}
createRoot(document.getElementById('root')!).render(<Surface />);
setTimeout(() => {
  const sheet = document.querySelector<HTMLElement>('[data-testid="width-sheet"]')!;
  const body = document.querySelector<HTMLElement>('[data-testid="width-sheet-body"]');
  const rect = sheet.getBoundingClientRect();
  const result = {
    viewport: window.innerWidth,
    windowHeight: window.innerHeight,
    width: rect.width,
    height: rect.height,
    centred: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) < 1,
    bodyScrolls: !!body && body.scrollHeight > body.clientHeight,
    bodyInside: !!body && body.getBoundingClientRect().bottom <= window.innerHeight,
  };
  document.getElementById('result')!.textContent = JSON.stringify(result);
}, 700);
