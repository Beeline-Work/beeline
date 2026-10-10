import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';
import PromptSchedule from '../sources/app/(app)/beeline/settings/schedule';
import Webhook from '../sources/app/(app)/beeline/settings/webhook';
import Workflow from '../sources/app/(app)/beeline/workflow';

/**
 * Paints one real page over the schedules, webhooks and workflow the shims
 * return, chosen by `?page=`: the Schedules and Webhooks list, a prompt
 * schedule's page, a webhook's page, or the workflow page opened from a
 * schedule. Reports every word it shows, in order, plus the list header's
 * type, where tapping each row went, what Stop offers before and after its
 * confirm, and which phone operations ran.
 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const leaves = () =>
  Array.from(document.querySelectorAll<HTMLElement>('#root *'))
    .filter((node) => node.childElementCount === 0 && node.textContent?.trim())
    .map((node) => node);
const click = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`)?.click();
const ids = (pattern: RegExp) =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
    .map((node) => node.dataset.testid!)
    .filter((id) => pattern.test(id));

const PAGES = { list: ScheduledWork, schedule: PromptSchedule, webhook: Webhook, workflow: Workflow };

async function run() {
  const page = (new URLSearchParams(location.search).get('page') ?? 'list') as keyof typeof PAGES;
  const Page = PAGES[page];
  createRoot(document.getElementById('root')!).render(<Page />);
  for (let i = 0; i < 8; i += 1) await pause();
  // A failed schedule read shows its error; Retry reads it again.
  const beforeRetry = leaves().map((node) => node.textContent);
  if (document.querySelector('[data-testid="workflow-schedule-error"]')) {
    click('workflow-schedule-error');
    for (let i = 0; i < 4; i += 1) await pause();
  }
  const nodes = leaves();
  const text = nodes.map((node) => node.textContent);
  const find = (value: string) => nodes.find((node) => node.textContent === value);
  const font = (node: HTMLElement | undefined) =>
    node ? `${getComputedStyle(node).fontSize} ${getComputedStyle(node).fontFamily}` : null;
  const eyebrow = find('#beeline');
  const title = find('Schedules and Webhooks');
  const glyphs = ids(/^scheduled-work-glyph-/);
  const steps = ids(/^workflow-steps-step-[^-]+$/);
  const pendingCircles = ids(/^workflow-steps-step-.*-circle-pending$/).length;
  const allCircles = ids(/^workflow-steps-step-.*-circle-/).length;
  for (const id of ['scheduled-work-daily', 'scheduled-work-video', 'webhook-hook-1']) click(id);
  const stopId = page === 'webhook' ? 'stop-webhook' : page === 'workflow' ? 'stop-workflow-schedule' : 'stop-schedule';
  click(stopId);
  await pause();
  const afterStop = leaves().map((node) => node.textContent);
  const operationsBeforeConfirm = [...((globalThis as { __operations?: string[] }).__operations ?? [])];
  click(`${stopId}-confirm`);
  for (let i = 0; i < 3; i += 1) await pause();
  report(
    JSON.stringify({
      beforeRetry,
      text,
      eyebrowFont: font(eyebrow),
      titleFont: font(title),
      eyebrowAboveTitle:
        eyebrow && title
          ? eyebrow.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1
          : null,
      glyphs,
      steps,
      pendingCircles,
      allCircles,
      pushed: (globalThis as { __pushed?: unknown[] }).__pushed ?? [],
      afterStop,
      operationsBeforeConfirm,
      operations: (globalThis as { __operations?: unknown[] }).__operations ?? [],
      inputs: (globalThis as { __inputs?: unknown[] }).__inputs ?? [],
      back: (globalThis as { __back?: number }).__back ?? 0,
    }),
  );
}

run().catch((error) => report(`FAIL ${String(error)}`));
