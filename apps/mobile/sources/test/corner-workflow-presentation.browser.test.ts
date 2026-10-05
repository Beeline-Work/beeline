import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('Reproduction C1: a plain corner has no workflow glyph or link; a saved workflow still opens its run', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/workflow-presentation-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
      import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
      import { workflowRunHref } from '@/buzz/workflow-run-copy';
      function Corner({ roomId }) {
        const { workflow, error, retry } = useRoomWorkflowRun(roomId);
        return <CornerObjectiveLine objective="Build the agreed change" workflow={workflow}
          workflowError={error} onRetryWorkflow={retry} testID={roomId}
          onOpenWorkflow={() => { window.opened = workflowRunHref(workflow); }} />;
      }
      createRoot(document.getElementById('root')).render(<><Corner roomId="plain"/><Corner roomId="saved"/></>);
      setTimeout(() => {
        const plain = document.querySelector('[data-testid="plain"]');
        const saved = document.querySelector('[data-testid="saved-workflow"]');
        saved?.click();
        document.getElementById('result').textContent = JSON.stringify({
          objective: plain?.textContent, plainGlyphs: plain?.querySelectorAll('svg').length,
          plainLinks: plain?.querySelectorAll('[role="link"]').length,
          savedLabel: saved?.getAttribute('aria-label'), opened: window.opened,
        });
      }, 1500);`);
    for (const width of [390, 1180]) {
      for (const theme of ['obsidian', 'bone']) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
        const proof = await runBrowserProof({ entry, mobile, width, shims: {
          ...shims,
          'expo-router': `import React from 'react'; export const useFocusEffect = fn => React.useEffect(fn, [fn]);`,
          '@/buzz/workbench-source': 'export const getWorkbenchSource = () => undefined;',
          '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => undefined });',
          '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async (_, { roomId }) => ({ workflows: roomId === 'plain' ? [] : [{
            runId: 'saved-run', roomId, workflowSlug: 'corner', state: 'approve', status: 'live',
            roomName: 'Saved workflow', startedAt: 1, updatedAt: 1, viewerHolds: true,
          }] });`,
        } });
        expect(proof.status, proof.stderr).toBe(0);
        expect(JSON.parse(proof.result)).toEqual({
          objective: 'Build the agreed change', plainGlyphs: 0, plainLinks: 0,
          savedLabel: 'Open workflow, Corner · Approve',
          opened: { pathname: '/beeline/workflow-run', params: { roomId: 'saved', runId: 'saved-run' } },
        });
        console.log(`Reproduction C1 Demonstrated ${theme} ${width}px: plain corner objective has no workflow glyph/link; saved workflow opens its run`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('Reproduction CWM1: +N running lists the other live workflows and opens the selected run', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/workflow-picker-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
      import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
      import { workflowRunHref } from '@/buzz/workflow-run-copy';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      const fontStyle = document.createElement('style');
      fontStyle.textContent = '@font-face{font-family:SpaceGrotesk-Regular;src:url(' + regularFont + ')}';
      document.head.appendChild(fontStyle);
      function Corner() {
        const { workflow, otherLiveRuns } = useRoomWorkflowRun('mm-corner');
        return <CornerObjectiveLine workflow={workflow} otherLiveRuns={otherLiveRuns}
          onOpenBrief={() => { window.briefOpened = true; }}
          onOpenWorkflow={run => { window.opened = workflowRunHref(run); }} />;
      }
      createRoot(document.getElementById('root')).render(<Corner/>);
      setTimeout(() => {
        const more = document.querySelector('[data-testid="corner-objective-line-workflow-more"]');
        const primary = document.querySelector('[data-testid="corner-objective-line-workflow-copy"]');
        window.before = { primary: primary?.textContent, count: more?.textContent,
          role: more?.getAttribute('role'), label: more?.getAttribute('aria-label'),
          height: more?.getBoundingClientRect().height,
          sameLine: more?.getBoundingClientRect().top === document.querySelector('[data-testid="corner-objective-line-brief"]')?.getBoundingClientRect().top,
          overflow: document.documentElement.scrollWidth > innerWidth };
        more?.click();
      }, 1000);
      setTimeout(() => {
        const rows = [...document.querySelectorAll('[data-testid^="corner-objective-line-workflow-other-"]')];
        window.labels = rows.map(row => row.textContent);
        rows.find(row => row.textContent.includes('Macro paper desk'))?.click();
      }, 1400);
      setTimeout(() => {
        // Chrome's virtual clock may retain the fading Modal until animationend.
        // A dismissed Modal disables pointer events immediately while it fades.
        const sheet = document.querySelector('[data-testid="corner-objective-line-workflow-list"]');
        let closed = !sheet;
        for (let node = sheet; node; node = node.parentElement) {
          if (getComputedStyle(node).pointerEvents === 'none') closed = true;
        }
        document.getElementById('result').textContent = JSON.stringify({ ...window.before,
          rows: window.labels, opened: window.opened ?? null,
          closed,
          briefOpened: Boolean(window.briefOpened) });
      }, 1800);`);
    for (const width of [320, 1180]) {
      for (const theme of ['obsidian', 'bone']) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
        const proof = await runBrowserProof({ entry, mobile, width, shims: {
          ...shims,
          'expo-router': `import React from 'react'; export const useFocusEffect = fn => React.useEffect(fn, [fn]);`,
          '@/buzz/workbench-source': 'export const getWorkbenchSource = () => undefined;',
          '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => undefined });',
          '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => ({ workflows: [
            { runId: 'macro-run', workflowSlug: 'macro-paper-desk', state: 'draft', updatedAt: 10 },
            { runId: 'ended-run', workflowSlug: 'ended', state: 'done', status: 'done', updatedAt: 100 },
            { runId: '6afa8c98', workflowSlug: 'mm-desk-steer', state: 'stuck', updatedAt: 30 },
            { runId: 'elsewhere', roomId: 'other-corner', workflowSlug: 'elsewhere', state: 'scout', updatedAt: 90 },
            { runId: 'feedback-run', workflowSlug: 'feedback-triage', state: 'approve', updatedAt: 20 },
          ].map(run => ({ roomId: 'mm-corner', status: 'live', roomName: 'MM desk', startedAt: 1,
            viewerHolds: false, ...run })) });`,
        } });
        expect(proof.status, proof.stderr).toBe(0);
        const result = JSON.parse(proof.result);
        console.log(`Reproduction CWM1 ${theme} ${width}px: ${JSON.stringify(result)}`);
        expect(result).toMatchObject({
          primary: 'Mm desk steer · Stuck', count: '+2 running', role: 'button',
          label: 'Show 2 other running workflows', overflow: false, sameLine: true,
          rows: ['Feedback triage · Approve', 'Macro paper desk · Draft'],
          opened: { pathname: '/beeline/workflow-run', params: { roomId: 'mm-corner', runId: 'macro-run' } },
          closed: true, briefOpened: false,
        });
        expect(result.height).toBeGreaterThanOrEqual(44);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
