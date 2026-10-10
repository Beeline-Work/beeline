import { surfaceCacheKey } from '@beeline/buzz-client';
import { mobileSurfaceCache, surfaceAddress } from '../sources/buzz/surface-storage';
import { storage } from '../sources/sync/storage';

/**
 * Two tabs of one origin. A same-origin frame plays the other tab: it writes
 * one stored Room-list response and the settings straight into localStorage,
 * so this page hears them only through the browser's `storage` events. The
 * page reads back its hot surfaces and its Zustand settings.
 */
const isCount = (value: unknown): value is { count: number } =>
  typeof value === 'object' && value !== null && typeof (value as { count?: unknown }).count === 'number';
const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function otherTab(script: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.srcdoc = `<script>${script}<\/script>`;
  document.body.append(frame);
  await pause();
}

async function run(): Promise<void> {
  const rooms = surfaceAddress('https://server.test', 'viewer', '/workspaces');
  const workspace = surfaceAddress('https://server.test', 'viewer', '/workspace/:id', { workspaceId: 'ws' });
  await mobileSurfaceCache.write(rooms, { count: 1 }, isCount);
  await mobileSurfaceCache.write(workspace, { count: 5 }, isCount);
  let notices = 0;
  mobileSurfaceCache.subscribe(rooms, () => { notices += 1; });
  const stored = `beeline.surface.surface.${encodeURIComponent(surfaceCacheKey(rooms))}`;

  await otherTab(`localStorage.setItem(${JSON.stringify(stored)}, JSON.stringify({ count: 2 }));
    localStorage.setItem('beeline.settings.settings',
      JSON.stringify({ settings: { userMessageBubbleColor: 'blue' }, version: 1 }));
    localStorage.setItem('beeline.settings.local-settings', JSON.stringify({ zenMode: true }));`);
  const afterWrite = {
    rooms: mobileSurfaceCache.peek(rooms, isCount)?.count ?? null,
    workspace: mobileSurfaceCache.peek(workspace, isCount)?.count ?? null,
    bubble: storage.getState().settings.userMessageBubbleColor,
    zen: storage.getState().localSettings.zenMode,
    notices,
  };
  await otherTab(`localStorage.removeItem(${JSON.stringify(stored)});`);
  const afterRemove = {
    rooms: mobileSurfaceCache.peek(rooms, isCount)?.count ?? null,
    workspace: mobileSurfaceCache.peek(workspace, isCount)?.count ?? null,
  };
  const pass = afterWrite.rooms === 2 && afterWrite.workspace === 5 && afterWrite.bubble === 'blue' &&
    afterWrite.zen === true && afterWrite.notices === 1 && afterRemove.rooms === null && afterRemove.workspace === 5;
  report(`${pass ? 'PASS' : 'FAIL'} other tab writes: rooms ${afterWrite.rooms} (was 1), workspace ${
    afterWrite.workspace}, bubble ${afterWrite.bubble}, zen ${afterWrite.zen}, notices ${afterWrite.notices} | ` +
    `other tab removes rooms: rooms ${afterRemove.rooms}, workspace ${afterRemove.workspace}`);
}

void run().catch((error) => report(`FAIL ${error instanceof Error ? error.stack : String(error)}`));
