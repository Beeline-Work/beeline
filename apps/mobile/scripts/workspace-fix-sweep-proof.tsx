import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import WorkspaceSettings from '../sources/components/buzz/WorkspaceSettingsPanel';
const pause = () => new Promise((resolve) => setTimeout(resolve, 350));
const target = () => document.querySelector<HTMLElement>('[data-testid="workspace-fix-sweep-toggle"]');
const control = () => target()?.querySelector<HTMLInputElement>('input') ?? target() as HTMLInputElement | null;
const checked = () => control()?.checked === true;
async function run() {
  createRoot(document.getElementById('root')!).render(<WorkspaceSettings workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
  await pause(); await pause();
  const ids = ['workspace-visibility-row','workspace-fix-sweep','open-members'];
  const order = [...document.querySelectorAll<HTMLElement>('[data-testid]')].map((node) => node.dataset.testid).filter((id) => ids.includes(id!));
  const before = checked();
  control()?.click(); await pause(); await pause();
  const off = checked();
  control()?.click(); await pause(); await pause();
  const on = checked();
  const operations = (globalThis as typeof globalThis & {__inputs?: unknown[]}).__inputs;
  document.getElementById('result')!.textContent = JSON.stringify({ order, before, off, on, operations });
}
run().catch((error) => { document.getElementById('result')!.textContent = `FAIL ${String(error)}`; });
