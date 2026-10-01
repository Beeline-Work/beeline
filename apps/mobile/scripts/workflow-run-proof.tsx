import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import WorkflowRun from '../sources/app/(app)/beeline/workflow-run';

/**
 * Paints the real workflow run page over the run the shimmed
 * `readWorkflowRun` returns, then reports the words it shows in order, the
 * header's type, the gutter's circles and brass lines, and where the current
 * step's Open → went.
 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function run() {
  createRoot(document.getElementById('root')!).render(<WorkflowRun />);
  for (let i = 0; i < 6; i += 1) await pause();
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('#root *')).filter(
    (node) => node.childElementCount === 0 && node.textContent?.trim(),
  );
  const find = (text: string) => nodes.find((node) => node.textContent === text);
  const font = (node: HTMLElement | undefined) =>
    node ? `${getComputedStyle(node).fontSize} ${getComputedStyle(node).fontFamily}` : null;
  const gutter = document.querySelector('[data-testid="workflow-run-graph-gutter"]');
  const circles = Array.from(gutter?.querySelectorAll('circle') ?? []);
  const paths = Array.from(gutter?.querySelectorAll('path') ?? []);
  const brass = (element: Element) =>
    /#b08a4a|rgb\(176, ?138, ?74\)/i.test(element.getAttribute('fill') ?? '') ||
    /#b08a4a|rgb\(176, ?138, ?74\)/i.test(element.getAttribute('stroke') ?? '');
  document
    .querySelector<HTMLElement>('[data-testid$="-open"][data-testid^="workflow-run-graph-row-"]')
    ?.click();
  await pause();
  report(
    JSON.stringify({
      text: nodes.map((node) => node.textContent),
      eyebrowFont: font(find(new URLSearchParams(location.search).get('eyebrow') ?? '')),
      titleFont: font(find(new URLSearchParams(location.search).get('title') ?? '')),
      circles: circles.length,
      brassCircles: circles.filter(brass).length,
      brassPaths: paths.filter(brass).length,
      halo: document.querySelector('[data-testid="workflow-run-graph-current-halo"]') != null,
      pushed: (globalThis as { __pushed?: unknown[] }).__pushed ?? [],
    }),
  );
}

run().catch((error) => report(`FAIL ${String(error)}`));
