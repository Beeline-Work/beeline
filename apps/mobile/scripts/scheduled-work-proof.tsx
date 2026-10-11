import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';
import PromptSchedule from '../sources/app/(app)/beeline/settings/schedule';
import Subscription from '../sources/app/(app)/beeline/settings/subscription';
import Workflow from '../sources/app/(app)/beeline/workflow';

/**
 * Paints one real page over the schedules, subscriptions and workflow the shims
 * return, chosen by `?page=`: the Schedules and subscriptions list, a prompt
 * schedule's page, a subscription's page, or the workflow page opened from a
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

const PAGES = { list: ScheduledWork, schedule: PromptSchedule, subscription: Subscription, workflow: Workflow };

async function run() {
  const page = (new URLSearchParams(location.search).get('page') ?? 'list') as keyof typeof PAGES;
  const Page = PAGES[page];
  createRoot(document.getElementById('root')!).render(<Page />);
  for (let i = 0; i < 8; i += 1) await pause();
  await document.fonts.ready;
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
  const title = find('Schedules and subscriptions');
  const glyphs = ids(/^(scheduled-work-glyph-|subscription-glyph-)/);
  const workflowFills = glyphs.map((id) =>
    document.querySelector(`[data-testid="${id}"] polygon`)?.getAttribute('fill'));
  const steps = ids(/^(workflow-steps|scheduled-work-steps)-step-[^-]+$/);
  const pendingCircles = ids(/^(workflow-steps|scheduled-work-steps)-step-.*-circle-pending$/).length;
  const allCircles = ids(/^(workflow-steps|scheduled-work-steps)-step-.*-circle-/).length;
  const listAxes = ['scheduled-work-daily', 'scheduled-work-video', 'subscription-sub-1', 'subscription-sub-2']
    .map((id) => document.querySelector(`[data-testid="${id}"]`))
    .filter((row): row is Element => Boolean(row))
    .map((row) => [...row.querySelectorAll('[dir=auto]')].slice(0, 2)
      .map((label) => label.getBoundingClientRect().x));
  const listPolygonCounts = ['scheduled-work-daily', 'scheduled-work-video', 'subscription-sub-1', 'subscription-sub-2']
    .map((id) => document.querySelector(`[data-testid="${id}"]`)?.querySelectorAll('polygon').length ?? 0);
  const listLines = ['scheduled-work-daily', 'scheduled-work-video', 'subscription-sub-1', 'subscription-sub-2']
    .map((id) => {
      const row = document.querySelector(`[data-testid="${id}"]`);
      const lead = document.querySelector(`[data-testid="${id}-description-lead"]`);
      const tail = lead?.nextElementSibling;
      return row && lead && tail ? {
        height: row.getBoundingClientRect().height,
        leadVisible: lead.scrollWidth <= lead.clientWidth + 1,
        sameLine: Math.abs(lead.getBoundingClientRect().y - tail.getBoundingClientRect().y) < 1,
        tailOneLine: tail.getBoundingClientRect().height <= lead.getBoundingClientRect().height + 1,
      } : null;
    });
  const detailAxis = [
    'scheduled-work-facts-when', 'scheduled-work-facts-agents', 'scheduled-work-facts-where',
    'scheduled-work-does-header', 'scheduled-work-prompt', 'scheduled-work-workflow',
    'scheduled-work-steps-step-notify-circle-pending',
    page === 'subscription' ? 'stop-subscription' : 'stop-schedule',
  ].map((id) => document.querySelector(`[data-testid="${id}"]`))
    .filter((node): node is Element => Boolean(node))
    .map((node) => (node.querySelector('[dir=auto]') ?? node).getBoundingClientRect().x);
  for (const id of ['scheduled-work-daily', 'scheduled-work-video', 'subscription-sub-1', 'subscription-sub-2']) click(id);
  if (page === 'subscription') click('scheduled-work-workflow');
  const stopId = page === 'subscription' ? 'stop-subscription'
    : page === 'workflow' ? new URLSearchParams(location.search).has('subscriptionId')
      ? 'stop-workflow-subscription' : 'stop-workflow-schedule'
      : 'stop-schedule';
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
      workflowFills,
      loadedFonts: [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
      listAxes,
      listPolygonCounts,
      listLines,
      detailAxis,
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
