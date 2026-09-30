import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import ConnectAppScreen from '../sources/app/(app)/beeline/settings/workbench/connect-app';
import { setWorkbenchSource } from '../sources/buzz/workbench-source';
import { MockWorkbenchSource } from '../sources/buzz/workbench-source.mock';

/**
 * Android draws the app edge to edge, so the system navigation bar sits over
 * the bottom `insets.bottom` pixels of the screen and takes every tap there.
 * This paints the real Connect an app screen at phone size with a 48px bottom
 * inset, lays an opaque 48px bar over the bottom of the page in its place,
 * scrolls to the end, and taps the last app's Connect button where a finger
 * would.
 */
const NAV_BAR = 48;

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function read() {
  const source = new MockWorkbenchSource();
  setWorkbenchSource(source);

  const root = document.getElementById('root')!;
  root.style.cssText = 'height:100vh;display:flex;flex-direction:column';
  createRoot(root).render(<ConnectAppScreen />);
  await pause();
  await pause();

  const bar = document.createElement('div');
  bar.id = 'system-nav-bar';
  bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${NAV_BAR}px;background:rgba(255,255,255,0.9);z-index:9999`;
  document.body.appendChild(bar);

  const scroll = document.querySelector<HTMLElement>('[data-testid="connect-app-scroll"]');
  if (!scroll) return report('FAIL the Connect an app scroll never painted');
  scroll.scrollTop = scroll.scrollHeight;
  await pause();

  const rows = Array.from(scroll.querySelectorAll<HTMLElement>('[data-testid^="connect-app-"]'));
  const last = rows.at(-1)!;
  const button = last.querySelector<HTMLElement>('[role="button"]')!;
  const barTop = window.innerHeight - NAV_BAR;
  const rect = button.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const tappable = hit != null && button.contains(hit);
  if (tappable) (hit as HTMLElement).click();
  await pause();

  const facts = [
    `viewport=${window.innerHeight}`,
    `navBarTop=${barTop}`,
    `lastRow=${last.dataset.testid}`,
    `connectButtonBottom=${Math.round(rect.bottom)}`,
    `fullyAboveNavBar=${rect.bottom <= barTop}`,
    `tapHits=${tappable ? 'connect-button' : (hit as HTMLElement | null)?.id || hit?.tagName}`,
    `connectRequests=${JSON.stringify(source.appRequests.map((request) => request.app))}`,
  ].join(' ');
  const pass = rect.bottom <= barTop && tappable && source.appRequests.length === 1;
  report(`${pass ? 'PASS' : 'FAIL'} ${facts}`);
}

read().catch((error) => report(`FAIL ${String(error)}`));
