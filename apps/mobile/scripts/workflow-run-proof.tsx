import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import WorkflowRun from '../sources/app/(app)/beeline/workflow-run';

/**
 * Paints the real workflow run page over the run the shimmed
 * `readWorkflowRun` returns, then reports the words it shows in order, the
 * header's type, each step's circle and the line beside it, what each step
 * says to a screen reader, and any control inside the gate's readout. It then
 * opens the step named by `?expand=`, reports its readout, taps the corner
 * named by `?corner=`, and reports where the page navigated.
 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const leaves = (root: Element | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>('*') ?? [])
    .filter((node) => node.childElementCount === 0 && node.textContent?.trim())
    .map((node) => node.textContent!);
/** A readout's lines as a reader sees them: index, key, then the whole value. */
const readout = (root: Element | null) =>
  ((root as HTMLElement | null)?.innerText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const ids = (pattern: RegExp) =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
    .map((node) => node.dataset.testid!)
    .filter((id) => pattern.test(id));

async function run() {
  const query = new URLSearchParams(location.search);
  createRoot(document.getElementById('root')!).render(<WorkflowRun />);
  for (let i = 0; i < 6; i += 1) await pause();
  const root = document.getElementById('root');
  const text = leaves(root);
  const nodes = Array.from(root?.querySelectorAll<HTMLElement>('*') ?? []);
  const font = (value: string | null) => {
    const node = nodes.find((entry) => entry.childElementCount === 0 && entry.textContent === value);
    return node ? `${getComputedStyle(node).fontSize} ${getComputedStyle(node).fontFamily}` : null;
  };
  const prefix = 'workflow-run-line-step-';
  const circles = Object.fromEntries(
    ids(/-circle-/).map((id) => {
      const [state, status] = id.slice(prefix.length).split('-circle-');
      return [state, status];
    }),
  );
  const lines = ids(/-(above|below)-(brass|quiet|dashed)$/).map((id) => id.slice(prefix.length));
  const labels = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"] [aria-label]`),
  ).map((node) => node.getAttribute('aria-label'));
  const pushedBefore = [...((globalThis as { __pushed?: unknown[] }).__pushed ?? [])];
  const expand = query.get('expand');
  let expanded: string[] | null = null;
  if (expand) {
    document.querySelector<HTMLElement>(`[data-testid="${prefix}${expand}-toggle"]`)?.click();
    await pause();
    expanded = readout(document.querySelector(`[data-testid="${prefix}${expand}-readout"]`));
  }
  const gateReadout = document.querySelector(`[data-testid="${prefix}approve-readout"]`);
  const gate = gateReadout
    ? {
        text: readout(gateReadout),
        controls: gateReadout.querySelectorAll('[role="button"],[role="link"],button,a').length,
      }
    : null;
  const corner = query.get('corner');
  if (corner) {
    document.querySelector<HTMLElement>(`[data-testid="workflow-run-corner-${corner}"]`)?.click();
    await pause();
  }
  report(
    JSON.stringify({
      text,
      eyebrowFont: font(query.get('eyebrow')),
      titleFont: font(query.get('title')),
      circles,
      lines,
      labels,
      halo: ids(/-halo$/).length,
      gate,
      expanded,
      pushedBefore,
      pushed: (globalThis as { __pushed?: unknown[] }).__pushed ?? [],
    }),
  );
}

run().catch((error) => report(`FAIL ${String(error)}`));
