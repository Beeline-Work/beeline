import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import WorkflowRun from '../sources/app/(app)/beeline/workflow-run';

/**
 * Paints the real workflow run page over the run the shimmed
 * `readWorkflowRun` returns, then reports the words it shows in order, the
 * header's type, each step's circle and the line beside it, what each step
 * says to a screen reader, each step's assignee (handle, whether it is the
 * viewer's own mark, and whether it sits at the row's right edge), any live
 * output or final reply, and any gate record. It then taps the corner named
 * by `?corner=` and reports where the page navigated.
 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const leaves = (root: Element | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>('*') ?? [])
    .filter((node) => node.childElementCount === 0 && node.textContent?.trim())
    .map((node) => node.textContent!);
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
  )
    // What a screen reader reads: nothing inside a subtree hidden from it.
    .filter((node) => !node.closest('[aria-hidden="true"]'))
    .map((node) => node.getAttribute('aria-label'));
  const assignees = Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"][data-testid*="-assignee"]`))
      .filter((node) => /-assignee(-viewer)?$/.test(node.dataset.testid!))
      .map((node) => {
        const id = node.dataset.testid!;
        const state = id.slice(prefix.length).replace(/-assignee(-viewer)?$/, '');
        const row = node.closest<HTMLElement>(`[data-testid="${prefix}${state}"]`)!;
        const handle = node.querySelector<HTMLElement>(`[data-testid="${prefix}${state}-assignee-handle"]`)!;
        const name = document.querySelector<HTMLElement>(`[data-testid="${prefix}${state}"]`)!
          .querySelector<HTMLElement>('[dir="auto"]')!;
        const mark = node.querySelector<HTMLElement>(`[data-testid="${prefix}${state}-assignee-mark"]`);
        const box = node.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return [state, {
          handle: handle.textContent,
          viewer: id.endsWith('-viewer'),
          mark: Boolean(mark),
          color: getComputedStyle(handle).color,
          rightAligned: box.left > rowBox.left + rowBox.width / 2 &&
            box.left > name.getBoundingClientRect().left,
        }];
      }),
  );
  const live = Object.fromEntries(
    ids(/-live$/).map((id) => [id.slice(prefix.length, -'-live'.length),
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.textContent]),
  );
  const pushedBefore = [...((globalThis as { __pushed?: unknown[] }).__pushed ?? [])];
  const gate = Object.fromEntries(
    ids(/-gate$/).map((id) => [id.slice(prefix.length, -'-gate'.length),
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.textContent]),
  );
  const corner = query.get('corner');
  if (corner) {
    document.querySelector<HTMLElement>(`[data-testid="workflow-run-corner-${corner}"]`)?.click();
    await pause();
  }
  const switchTo = query.get('switchTo');
  if (switchTo) {
    document.querySelector<HTMLElement>(`[data-testid="workflow-run-also-running-${switchTo}"]`)?.click();
    await pause();
  }
  report(
    JSON.stringify({
      text,
      overview: Boolean(document.querySelector('[data-testid="workflow-run-overview"]')),
      earlier: Boolean(document.querySelector('[data-testid="workflow-run-earlier"]')),
      summary: document.querySelector('[data-testid="workflow-run-description"]')?.textContent ?? null,
      does: Object.fromEntries(ids(/-description$/).filter((id) => id.startsWith(prefix)).map((id) => [id.slice(prefix.length, -'-description'.length),
        document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.textContent])),
      overflow: document.documentElement.scrollWidth > innerWidth,
      eyebrowFont: font(query.get('eyebrow')),
      titleFont: font(query.get('title')),
      circles,
      lines,
      labels,
      halo: ids(/-halo$/).length,
      assignees,
      live,
      finals: Object.fromEntries(ids(/-final$/).map((id) => [id.slice(prefix.length, -6),
        document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.textContent])),
      durations: Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"][data-testid$="-duration"]`)).map((node) => node.textContent),
      gate,
      alsoRunning: ids(/^workflow-run-also-running-/),
      pushedBefore,
      pushed: (globalThis as { __pushed?: unknown[] }).__pushed ?? [],
      replaced: (globalThis as { __replaced?: unknown[] }).__replaced ?? [],
    }),
  );
}

run().catch((error) => report(`FAIL ${String(error)}`));
