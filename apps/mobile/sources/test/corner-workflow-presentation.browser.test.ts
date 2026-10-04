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
            roomName: 'Saved workflow', startedAt: 1, updatedAt: 1, viewerHolds: true, earlierRunCount: 0,
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
