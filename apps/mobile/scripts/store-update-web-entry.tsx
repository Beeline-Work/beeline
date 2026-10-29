import React from 'react';
// @ts-expect-error react-dom has no declarations in this workspace.
import { createRoot } from 'react-dom/client';
import { StoreUpdateScreen } from '../sources/components/StoreUpdateGate';

const platform = new URLSearchParams(location.search).get('platform') === 'ios' ? 'ios' : 'android';
createRoot(document.getElementById('root')!).render(
  <StoreUpdateScreen platform={platform} installed="0.2.22"
    minimum={{ minVersion: '0.2.24', reason: 'This version can no longer sign in. The update takes about a minute.' }} />,
);
setTimeout(() => { document.getElementById('result')!.textContent = 'rendered'; }, 1000);
