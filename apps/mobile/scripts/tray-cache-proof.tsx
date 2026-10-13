import React, { useState } from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import TrayScreen from '../sources/app/(app)/beeline/tray';
import { RoomListToolbar } from '../sources/components/buzz/RoomListToolbar';
import { useNeedsYouCount } from '../sources/buzz/needs-you-store';

const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
let open = () => undefined as void;
function App() {
  const [tray, setTray] = useState(false);
  open = () => setTray(true);
  const count = useNeedsYouCount('workspace-1', 'surface-1');
  return <>
    <RoomListToolbar desktop filter="all" onFilter={() => undefined} query="" onQuery={() => undefined}
      needsYouCount={count} onTray={open} />
    {tray ? <TrayScreen /> : null}
  </>;
}
async function run() {
  createRoot(document.getElementById('root')!).render(<App />);
  await pause();
  const badge = () => Number(document.querySelector('[data-testid="tray-needs-you-count"]')?.textContent ?? 0);
  const before = badge();
  open();
  await pause();
  const rows = document.querySelectorAll('[data-testid^="needs-you-item-"]').length;
  const after = badge();
  const saved = document.querySelector('[data-testid="tray-section-saved"]')?.textContent ?? '';
  document.getElementById('result')!.textContent =
    `${before === 5 && rows === 5 && after === 5 && saved.includes('6') ? 'PASS' : 'FAIL'} Reproduction TRAY-CACHED-EMPTY-1: badge before ${before}; open cached empty Tray with six Saved; visible Needs you ${rows}, badge ${after}, ${saved}`;
}
run().catch((error) => { document.getElementById('result')!.textContent = `FAIL ${String(error)}`; });
