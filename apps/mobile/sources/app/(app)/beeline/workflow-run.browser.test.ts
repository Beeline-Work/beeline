import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const STARTED = 1_790_000_000;

/** A feedback-triage run waiting at its approve gate, as `readWorkflowRun` returns it. */
function feedbackTriageDetail(repo: string) {
  const contract = JSON.parse(
    readFileSync(path.join(repo, 'docs/workflows/feedback-triage.json'), 'utf8'),
  );
  const candy = { id: 'b'.repeat(64), name: 'Candy', kind: 'agent' };
  return {
    run: {
      runId: 'run-1',
      workflowSlug: 'feedback-triage',
      description: contract.description,
      roomId: 'corner-2',
      roomName: 'Issues triage',
      parentRoomId: 'room-1',
      state: 'approve',
      status: 'live',
      holder: candy,
      viewerHolds: true,
      startedAt: STARTED,
      updatedAt: STARTED + 120,
      earlierRunCount: 6,
    },
    contract,
    history: [
      { toState: 'notify', actor: candy, at: STARTED },
      { fromState: 'notify', outcome: 'notified', toState: 'pull', actor: candy, at: STARTED + 60 },
      { fromState: 'pull', outcome: 'ranked', toState: 'approve', actor: candy, at: STARTED + 120 },
    ],
    roleHolders: { triager: candy },
  };
}

function workflowRunShims(mobile: string, detail: unknown): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ roomId: 'corner-2', runId: 'run-1' });
    export const router = { push: (href) => { (globalThis.__pushed ??= []).push(href); },
      replace: () => undefined, back: () => undefined };`,
    '@/sync/transport/monolith-operation': `export class MonolithPhoneOperationError extends Error {}
    export const monolithPhoneOperation = async () => (${JSON.stringify(detail)});`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
  };
}

describe.skipIf(!existsSync(CHROME))('Workflow run page in a browser', () => {
  it('draws the whole state graph under the corner over the workflow name', async () => {
    const mobile = process.cwd();
    const detail = feedbackTriageDetail(path.resolve(mobile, '../..'));
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/workflow-run-proof.tsx'),
      mobile,
      shims: workflowRunShims(mobile, detail),
      width: 390,
      query: '?eyebrow=Issues%20triage&title=Feedback%20triage',
    });
    expect(status, stderr).toBe(0);
    if (process.env.PRINT_PROOF) console.log(result);
    expect(result.startsWith('{'), result).toBe(true);
    const page = JSON.parse(result) as Record<string, unknown> & { text: string[] };
    expect(page).toMatchObject({
      // The same title role as Scheduled Work and the corner.
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
      circles: 7,
      brassCircles: 3,
      brassPaths: 2,
      halo: true,
      pushed: [
        {
          pathname: '/beeline/chat/[channelId]',
          params: { channelId: 'corner-2', parent: 'room-1', title: 'Issues triage' },
        },
      ],
    });
    expect(page.text.slice(0, 2)).toEqual(['Issues triage', 'Feedback triage']);
    const time = expect.stringMatching(/\d:\d\d/);
    expect(page.text.slice(2)).toEqual([
      expect.stringMatching(/^(Today|Yesterday|[A-Z][a-z]{2} \d+)$/),
      time,
      'Notify',
      'Candy · notified',
      time,
      'Pull',
      'Candy · ranked',
      time,
      'Done',
      'Nothing new · Done',
      'Approve',
      'Waiting on you',
      'Open →',
      'Done',
      'Skip · Done',
      'Dispatch',
      'Candy',
      'Done',
      'Dispatched · Done',
      'Earlier runs',
      '6',
    ]);
  }, 120_000);
});
