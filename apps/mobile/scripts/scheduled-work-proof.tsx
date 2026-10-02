import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';

/**
 * Paints the real Scheduled work page over the schedules the shimmed
 * `listRoomSchedules` returns, and reports every word it shows, in order,
 * plus the header's eyebrow and title type, where opening a schedule's corner
 * went, what STOP offers, and which phone operations the page called.
 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const leaves = () =>
  Array.from(document.querySelectorAll<HTMLElement>('#root *'))
    .filter((node) => node.childElementCount === 0 && node.textContent?.trim())
    .map((node) => node);

async function run() {
  createRoot(document.getElementById('root')!).render(<ScheduledWork />);
  for (let i = 0; i < 6; i += 1) await pause();
  const nodes = leaves();
  const text = nodes.map((node) => node.textContent);
  const find = (text: string) => nodes.find((node) => node.textContent === text);
  const font = (node: HTMLElement | undefined) =>
    node ? `${getComputedStyle(node).fontSize} ${getComputedStyle(node).fontFamily}` : null;
  document.querySelector<HTMLElement>('[data-testid="scheduled-work-hourly"]')?.click();
  document.querySelector<HTMLElement>('[data-testid="stop-scheduled-work-daily"]')?.click();
  await pause();
  const eyebrow = find('#beeline');
  const title = find('Scheduled Work');
  report(
    JSON.stringify({
      text,
      back: document.querySelector('[aria-label^="Back"]') != null,
      eyebrowFont: font(eyebrow),
      titleFont: font(title),
      eyebrowAboveTitle:
        eyebrow && title
          ? eyebrow.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1
          : null,
      pushed: (globalThis as { __pushed?: unknown[] }).__pushed ?? [],
      afterStop: leaves().map((node) => node.textContent),
      workflowSection: document.querySelector('[data-testid="scheduled-work-workflows"]') != null,
      operations: (globalThis as { __operations?: unknown[] }).__operations ?? [],
    }),
  );
}

run().catch((error) => report(`FAIL ${String(error)}`));
