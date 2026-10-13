import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { HullActionSheet } from '../sources/components/buzz/HullActionSheet';
// @ts-expect-error Source-derived module supplied by the browser test.
import { DmSheetBody } from 'dm-sheet-body';

const query = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(
  <View style={{ width: 390 }}>
    <HullActionSheet title="System">
      <DmSheetBody muted={query.get('muted') === '1'} error={query.get('error')} />
    </HullActionSheet>
  </View>,
);

setTimeout(() => {
  const node = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  document.getElementById('result')!.textContent = JSON.stringify({
    muteHeight: node('dm-push-mute')?.getBoundingClientRect().height ?? 0,
    switchOn: (node('dm-push-mute')?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked ?? null,
    alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    cancel: node('dm-actions-close') !== null,
    text: document.body.innerText,
  });
}, 500);
