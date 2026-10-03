import React from 'react';
// @ts-expect-error Standalone browser proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import Workflow from '../sources/app/(app)/beeline/workflow';

async function main() {
  createRoot(document.getElementById('root')!).render(<Workflow />);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
  for (let i = 0; i < 12; i++) await pause();
  const initial = document.getElementById('root')!.innerText;
  const change = document.querySelector<HTMLElement>('[data-testid="workflow-change-owner"]');
  if (new URLSearchParams(location.search).has('transfer')) {
    change?.click();
    await pause();
    document.querySelector<HTMLElement>('[aria-label="Make Peer the workflow owner"]')?.click();
    for (let i = 0; i < 12; i++) await pause();
  }
  document.getElementById('result')!.textContent = JSON.stringify({
    initial,
    text: document.getElementById('root')!.innerText,
    changeOwner: Boolean(change),
    ownerAvatar: Boolean(document.querySelector('[data-testid="workflow-ownership"] svg')),
    overflow: document.documentElement.scrollWidth > innerWidth,
    calls: (globalThis as { __calls?: unknown[] }).__calls ?? [],
  });
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL ${String(error)}`;
});
