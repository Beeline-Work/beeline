import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import WorkbenchScreen from '../sources/app/(app)/beeline/settings/workbench';
import { setWorkbenchSource } from '../sources/buzz/workbench-source';
import { MockWorkbenchSource } from '../sources/buzz/workbench-source.mock';

/**
 * Android draws the app edge to edge, so the system navigation bar sits over
 * the bottom `insets.bottom` pixels of the screen and takes every tap there.
 * This paints the real Workbench at phone size with a 48px bottom inset, lays
 * an opaque 48px bar over the bottom of the page in its place, scrolls the
 * Workbench to the end, and taps the last app row where a finger would.
 */
const NAV_BAR = 48;
const pushes = ((window as unknown as { __pushes: unknown[] }).__pushes = []);

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function read() {
  const source = new MockWorkbenchSource();
  source.setApps(
    ['Slack', 'Linear', 'Notion', 'Figma', 'Stripe', 'Vercel', 'Sentry', 'Asana'].map((name) => ({
      id: `app-${name.toLowerCase()}`,
      key: name.toLowerCase(),
      name,
      transport: 'composio' as const,
      status: 'connected' as const,
      useCount: 0,
    })),
  );
  setWorkbenchSource(source);

  const root = document.getElementById('root')!;
  root.style.cssText = 'height:100vh;display:flex;flex-direction:column';
  createRoot(root).render(<WorkbenchScreen />);
  await pause();
  await pause();

  const bar = document.createElement('div');
  bar.id = 'system-nav-bar';
  bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${NAV_BAR}px;background:rgba(255,255,255,0.9);z-index:9999`;
  document.body.appendChild(bar);

  const scroll = document.querySelector<HTMLElement>('[data-testid="workbench-scroll"]');
  if (!scroll) return report('FAIL the Workbench scroll never painted');
  scroll.scrollTop = scroll.scrollHeight;
  await pause();

  const apps = Array.from(scroll.querySelectorAll<HTMLElement>('[data-testid^="workbench-app-"]'));
  const last = apps.at(-1);
  if (!last) return report('FAIL the Workbench painted no app rows');
  const rows = Array.from(
    scroll.querySelectorAll<HTMLElement>(
      '[data-testid^="workbench-app-"], [data-testid="workbench-connect-app"], [data-testid^="workbench-connection-"]:not([data-testid$="-mark"])',
    ),
  );
  const bottomMost = rows.reduce((a, b) =>
    b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a,
  );
  const bottomMostRect = bottomMost.getBoundingClientRect();
  const barTop = window.innerHeight - NAV_BAR;
  const rect = last.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const tappable = hit != null && last.contains(hit);
  if (tappable) (hit as HTMLElement).click();
  await pause();

  const facts = [
    `viewport=${window.innerHeight}`,
    `navBarTop=${barTop}`,
    `lastApp=${last.dataset.testid}`,
    `lastAppBottom=${Math.round(rect.bottom)}`,
    `fullyAboveNavBar=${rect.bottom <= barTop}`,
    `tapHits=${tappable ? 'row' : (hit as HTMLElement | null)?.id || hit?.tagName}`,
    `bottomMostRow=${bottomMost.dataset.testid}`,
    `bottomMostRowBottom=${Math.round(bottomMostRect.bottom)}`,
    `scrollEnd=${Math.round(scroll.getBoundingClientRect().bottom)}`,
    `opened=${JSON.stringify(pushes)}`,
  ].join(' ');
  const pass =
    rect.bottom <= barTop && bottomMostRect.bottom <= barTop && tappable && pushes.length === 1;
  report(`${pass ? 'PASS' : 'FAIL'} ${facts}`);
}

read().catch((error) => report(`FAIL ${String(error)}`));
