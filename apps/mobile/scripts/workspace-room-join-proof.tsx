import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import WorkspaceSettings from '../sources/app/(app)/beeline/settings/workspace';

const FANTASTIK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const report = (text: string) => {
  const target = document.getElementById('result');
  if (target) target.textContent = text;
};
const press = (testID: string) => {
  const node = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (!node) throw new Error(`missing ${testID}`);
  node.click();
};
const textOf = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`)?.innerText.split('\n') ?? null;
const state = globalThis as typeof globalThis & {
  __inputs?: [string, unknown][];
  __pushed?: unknown[];
};

/**
 * Reproduction R1, on the painted Workspace settings page: an owner taps
 * "fantastik", an invite-only Room they have not joined.
 */
async function read() {
  createRoot(document.getElementById('root')!).render(<WorkspaceSettings />);
  await pause();
  await pause();
  const rows = { fantastik: textOf(`room-visibility-${FANTASTIK}`), general: textOf(`room-visibility-${GENERAL}`) };
  press(`room-visibility-${FANTASTIK}`);
  await pause();
  const afterRowTap = {
    operations: [...(state.__inputs ?? [])],
    sheet: textOf('room-sheet'),
  };
  let afterJoin = null;
  if (document.querySelector('[data-testid="room-sheet-join"]')) {
    press('room-sheet-join');
    await pause();
    await pause();
    afterJoin = { operations: [...(state.__inputs ?? [])], pushed: state.__pushed ?? [] };
  }
  report(JSON.stringify({ rows, afterRowTap, afterJoin }));
}

read().catch((error) => report(`FAIL ${String(error)}`));
