import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const STARTED = 1_790_000_000;
const candy = { id: 'b'.repeat(64), name: 'Candy', kind: 'agent' };
const owner = { id: 'a'.repeat(64), name: 'Owner', kind: 'human' };
const GATE_OPTIONS = [
  { letter: 'A', label: 'dispatch', consequence: 'go to dispatch' },
  { letter: 'B', label: 'skip', consequence: 'go to done' },
];

function contractOf(repo: string) {
  return JSON.parse(readFileSync(path.join(repo, 'docs/workflows/feedback-triage.json'), 'utf8'));
}

/** A feedback-triage run as `readWorkflowRun` returns it, in the given state with the given cards. */
function feedbackTriageDetail(
  repo: string,
  run: { state: string; status: string; viewerHolds: boolean; updatedAt: number },
  history: unknown[],
) {
  const contract = contractOf(repo);
  return {
    run: {
      runId: 'run-1',
      workflowSlug: 'feedback-triage',
      description: contract.description,
      roomId: 'corner-2',
      roomName: 'Issues triage',
      parentRoomId: 'room-1',
      holder: candy,
      startedAt: STARTED,
      earlierRunCount: 13,
      ...run,
    },
    contract,
    history,
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

type Proof = {
  text: string[];
  eyebrowFont: string | null;
  titleFont: string | null;
  circles: Record<string, string>;
  lines: string[];
  labels: string[];
  halo: number;
  gate: { text: string[]; controls: number } | null;
  expanded: string[] | null;
  pushedBefore: unknown[];
  pushed: unknown[];
};

async function proof(detail: unknown, query: string): Promise<Proof> {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/workflow-run-proof.tsx'),
    mobile,
    shims: workflowRunShims(mobile, detail),
    width: 390,
    query,
  });
  expect(status, stderr).toBe(0);
  if (process.env.PRINT_PROOF) console.log(result);
  expect(result.startsWith('{'), result).toBe(true);
  return JSON.parse(result) as Proof;
}

const repo = () => path.resolve(process.cwd(), '../..');

describe.skipIf(!existsSync(CHROME))('Workflow run page in a browser', () => {
  it('draws one straight line with the gate recorded read-only and no way out to the corner', async () => {
    const detail = feedbackTriageDetail(
      repo(),
      { state: 'approve', status: 'live', viewerHolds: true, updatedAt: STARTED + 112 },
      [
        { toState: 'notify', actor: candy, at: STARTED },
        {
          fromState: 'notify',
          outcome: 'notified',
          toState: 'pull',
          actor: candy,
          at: STARTED + 12,
          contents: { fixedPullRequests: ['#1981 Corner dropdown regression'] },
        },
        {
          fromState: 'pull',
          outcome: 'ranked',
          toState: 'approve',
          actor: candy,
          at: STARTED + 112,
          contents: {
            problems: [
              { description: 'Corner dropdown vanishes from the mobile Room list', items: ['f1'] },
              { description: 'Shared mock opens as a binary file', items: ['f2'] },
            ],
          },
          gate: { question: 'feedback-triage: approve', options: GATE_OPTIONS, status: 'open' },
        },
      ],
    );
    const page = await proof(detail, '?eyebrow=Issues%20triage&title=Feedback%20triage&expand=pull');
    // The same title role as the corner, with the run number beside it.
    expect(page.text.slice(0, 3)).toEqual(['Issues triage', 'Feedback triage', '#14']);
    expect(page).toMatchObject({
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
    });
    expect(page.text).toContain('Waiting on you');
    // One row per state on the main path, in order, each with its own circle.
    expect(page.circles).toEqual({
      notify: 'done',
      pull: 'done',
      approve: 'current',
      dispatch: 'pending',
      done: 'pending',
    });
    expect(page.halo).toBe(1);
    expect(page.lines).toEqual([
      'notify-below-brass',
      'pull-above-brass',
      'pull-below-brass',
      'approve-above-brass',
      'approve-below-quiet',
      'dispatch-above-quiet',
      'dispatch-below-quiet',
      'done-above-quiet',
    ]);
    // The gate opens on its own as a record: the question, the options, whose move it is.
    expect(page.gate).toEqual({
      text: [
        '1',
        'role',
        'triager · Candy',
        '2',
        'entered',
        expect.stringMatching(/\d\d:\d\d:\d\d/),
        '3',
        'asked',
        'feedback-triage: approve',
        '4',
        'option A',
        'dispatch · go to dispatch',
        '5',
        'option B',
        'skip · go to done',
        '6',
        'answer',
        'waiting on you',
      ],
      controls: 0,
    });
    // Tapping a step opens its readout in place: role, times, outcome, what it delivered.
    expect(page.expanded).toEqual([
      '1',
      'role',
      'triager · Candy',
      '2',
      'entered',
      expect.stringMatching(/\d\d:\d\d:\d\d/),
      '3',
      'left',
      expect.stringMatching(/\d\d:\d\d:\d\d.* · ranked → Approve$/),
      '4',
      'delivered',
      'problems · 2',
      '1',
      'Corner dropdown vanishes from the mobile Room list',
      '2',
      'Shared mock opens as a binary file',
    ]);
    // No Open → to the run's own corner, and nothing navigates on its own.
    expect(page.text.join(' ')).not.toContain('Open →');
    expect(page.pushedBefore).toEqual([]);
  }, 120_000);

  it('ghosts the steps a fork went around and says why, in words', async () => {
    const detail = feedbackTriageDetail(
      repo(),
      { state: 'done', status: 'done', viewerHolds: false, updatedAt: STARTED + 58 },
      [
        { toState: 'notify', actor: candy, at: STARTED },
        { fromState: 'notify', outcome: 'notified', toState: 'pull', actor: candy, at: STARTED + 9 },
        {
          fromState: 'pull',
          outcome: 'nothing_new',
          toState: 'done',
          status: 'done',
          actor: candy,
          at: STARTED + 58,
          contents: { problems: [] },
        },
      ],
    );
    const page = await proof(detail, '');
    expect(page.text).toContain('Done · nothing new');
    expect(page.text).toContain('3 ran · 2 skipped');
    expect(page.circles).toEqual({
      notify: 'done',
      pull: 'done',
      approve: 'skipped',
      dispatch: 'skipped',
      done: 'done',
    });
    expect(page.lines).toEqual([
      'notify-below-brass',
      'pull-above-brass',
      'pull-below-dashed',
      'approve-above-dashed',
      'approve-below-dashed',
      'dispatch-above-dashed',
      'dispatch-below-dashed',
      'done-above-dashed',
    ]);
    expect(page.labels).toEqual([
      'Notify, done, Candy · notified',
      'Pull, done, Candy · nothing new',
      'Approve, skipped, Skipped · Pull: nothing new',
      'Dispatch, skipped, Skipped · Pull: nothing new',
      'Done, done, Ended by Pull',
    ]);
    expect(page.halo).toBe(0);
  }, 120_000);

  it("records who answered the gate and links each corner the dispatch opened", async () => {
    const detail = feedbackTriageDetail(
      repo(),
      { state: 'done', status: 'done', viewerHolds: false, updatedAt: STARTED + 400 },
      [
        { toState: 'pull', actor: candy, at: STARTED },
        {
          fromState: 'pull',
          outcome: 'ranked',
          toState: 'approve',
          actor: candy,
          at: STARTED + 100,
          gate: {
            question: 'feedback-triage: approve',
            options: GATE_OPTIONS,
            status: 'answered',
            answer: 'dispatch',
            answeredBy: owner,
            answeredAt: STARTED + 200,
          },
        },
        {
          fromState: 'approve',
          outcome: 'dispatch',
          toState: 'dispatch',
          actor: candy,
          at: STARTED + 210,
          openedCorners: [
            { id: 'fix-1', name: 'Corner dropdown fix', parentRoomId: 'room-1' },
            { id: 'fix-2', name: 'Mock file type fix', parentRoomId: 'room-1' },
          ],
        },
        {
          fromState: 'dispatch',
          outcome: 'dispatched',
          toState: 'done',
          status: 'done',
          actor: candy,
          at: STARTED + 400,
          contents: { corners: ['Corner dropdown fix', 'Mock file type fix'] },
        },
      ],
    );
    const gate = await proof(detail, '?expand=approve');
    expect(gate.expanded).toEqual([
      '1',
      'role',
      'triager · Candy',
      '2',
      'entered',
      expect.stringMatching(/\d\d:\d\d:\d\d/),
      '3',
      'left',
      expect.stringMatching(/ · dispatch → Dispatch$/),
      '4',
      'asked',
      'feedback-triage: approve',
      '5',
      'option A',
      'dispatch · go to dispatch',
      '6',
      'option B',
      'skip · go to done',
      '7',
      'answer',
      expect.stringMatching(/^dispatch · Owner · \d\d:\d\d:\d\d/),
    ]);
    // The record is all there is: no answer plates, no control of any kind.
    expect(gate.gate!.controls).toBe(0);
    const dispatch = await proof(detail, '?expand=dispatch&corner=fix-2');
    expect(dispatch.expanded).toEqual(
      expect.arrayContaining(['corners · 2', 'OPENED', 'Corner dropdown fix', 'Mock file type fix']),
    );
    // The corner link goes to that corner, under the Room it was opened in.
    expect(dispatch.pushedBefore).toEqual([]);
    expect(dispatch.pushed).toEqual([
      {
        pathname: '/beeline/chat/[channelId]',
        params: { channelId: 'fix-2', parent: 'room-1', title: 'Mock file type fix' },
      },
    ]);
  }, 120_000);
});
