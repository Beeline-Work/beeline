import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { TranscriptDividersProof } from './transcript-dividers-proof';
createRoot(document.getElementById('root')!).render(<TranscriptDividersProof />);
setTimeout(async () => {
  await document.fonts.ready;
  const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const row = get('notification-run-corner');
  if (parseFloat(getComputedStyle(row).borderTopWidth) > 0) throw Error('corner top rule returned');
  get('tool-run-group-read').click();
  document.getElementById('result')!.textContent = 'PASS DIVIDERS';
}, 300);
