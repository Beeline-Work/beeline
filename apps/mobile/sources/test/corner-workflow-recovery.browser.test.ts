import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('CR1: failed workflow fetch leaves a clean objective and recovers on an event', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/workflow-recovery-'));
  const evidence = process.env.CORNER_WORKFLOW_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const font = await readFile(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf'));
  const head = `<style>@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${font.toString('base64')})}#result{display:none}</style>`;
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
      import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
      import { useUnistyles } from 'react-native-unistyles';
      function Corner() {
        const run = useRoomWorkflowRun('corner');
        const { theme } = useUnistyles();
        document.body.style.background = theme.buzz.bgBase;
        return <CornerObjectiveLine objective="Keep workflow status quiet when the connection hiccups"
          workflow={run.workflow} onOpenBrief={() => { window.briefOpened = true; }} onOpenWorkflow={() => {}} />;
      }
      flushSync(() => createRoot(document.getElementById('root')).render(<Corner />));
      const panel = () => document.querySelector('[data-testid="corner-objective-line"]');
      setTimeout(() => {
        window.failed = { text: panel()?.textContent,
          retry: !!panel()?.querySelector('[role="button"]'), alert: !!panel()?.querySelector('[role="alert"]'), reads: window.reads };
        document.querySelector('[data-testid="corner-objective-line-brief"]')?.click();
      }, 400);
      setTimeout(() => { if (location.search) return; window.recover = true; window.listener({ monolithLive: { roomId: 'corner', type: 'invalidate' } }); }, 1200);
      setTimeout(() => {
        document.getElementById('result').textContent = JSON.stringify({ failed: window.failed,
          reads: window.reads, recovered: panel()?.textContent.includes('Review · Approve'), briefOpened: window.briefOpened });
      }, 1600);`);
    for (const theme of ['obsidian', 'bone']) {
      for (const width of [390, 1180]) {
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
        const options = { entry, mobile, width, head, budgetMs: 1900,
          
          shims: { ...shims,
            'expo-router': `import React from 'react'; export const useFocusEffect = effect => React.useEffect(effect, [effect]);`,
            '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async (_, listener) => { window.listener = listener; return () => {}; } });',
            '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => {
              window.reads = (window.reads ?? 0) + 1;
              if (!window.recover) throw new Error('forced workflow fetch failure');
              return { workflows: [{ roomId: 'corner', runId: 'run', status: 'live', workflowSlug: 'review', state: 'approve', updatedAt: 1 }] };
            };`,
          },
        };
        if (evidence) await runBrowserProof({ ...options, query: "?failure", screenshotPath: path.join(evidence, `web-${theme}-${width}.png`) });
        const result = await runBrowserProof(options);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.result)).toEqual({ failed: {
          text: 'Keep workflow status quiet when the connection hiccupsRead brief', retry: false, alert: false, reads: 1,
        }, reads: 2, recovered: true, briefOpened: true });
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
