import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const STARTED = 1_790_000_000;
const candy = { id: 'b'.repeat(64), name: 'Candy', kind: 'agent', handle: 'candy', face: 'fox' };
const owner = {
  id: 'a'.repeat(64),
  name: 'Owner',
  kind: 'human',
  handle: '@lunchboxfortwo@beeline.test',
  face: 'owl',
};
/** Role names the contracts below declare; none may reach the page. */
const ROLE_NAMES = ['triager', 'analyst', 'implementer', 'reviewer'];
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
    viewer: owner,
  };
}

/** `drafts` are live draft events the shared socket delivers to every registration. */
function workflowRunShims(mobile: string, detail: unknown, drafts: unknown[] = []): Record<string, string> {
  return {
    ...webProofShims(mobile),
    '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({
      register: async (_filters, listener) => {
        setTimeout(() => ${JSON.stringify(drafts)}.forEach((live) => listener({ monolithLive: live })), 0);
        return () => undefined;
      },
    });`,
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
  overview: boolean;
  earlier: boolean;
  summary: string | null;
  exits: Record<string, string>;
  receipts: string[];
  refs: string[];
  overflow: boolean;
  eyebrowFont: string | null;
  titleFont: string | null;
  circles: Record<string, string>;
  lines: string[];
  labels: string[];
  halo: number;
  assignees: Record<
    string,
    { handle: string; viewer: boolean; mark: boolean; color: string; rightAligned: boolean }
  >;
  live: Record<string, string>;
  gate: { text: string[]; controls: number } | null;
  expanded: string[] | null;
  pushedBefore: unknown[];
  pushed: unknown[];
};

async function proof(detail: unknown, query: string, width = 390, drafts: unknown[] = []): Promise<Proof> {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/workflow-run-proof.tsx'),
    mobile,
    shims: workflowRunShims(mobile, detail, drafts),
    width,
    query,
  });
  expect(status, stderr).toBe(0);
  if (process.env.PRINT_PROOF) console.log(result);
  expect(result.startsWith('{'), result).toBe(true);
  return JSON.parse(result) as Proof;
}

const repo = () => path.resolve(process.cwd(), '../..');
/** Obsidian brass (`accent`), the viewer's own name. */
const BRASS = 'rgb(176, 138, 74)';

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
    // The same title role as the corner, with no previous-run count.
    expect(page.text.slice(0, 2)).toEqual(['Issues triage', 'Feedback triage']);
    expect(page).toMatchObject({ overview: false, earlier: false, summary: null, receipts: [] });
    expect(page.text).not.toContain('#14');
    expect(page.exits['approve-exits']).toBe('Exits: dispatch → Dispatch · skip → Done');
    expect(page.exits['pull-exit']).toBe('→ Approve via ranked');
    expect(page).toMatchObject({
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
    });
    expect(page.text).toContain('Waiting on you');
    // Each step's holder sits at the row's right as a mark and handle; the gate
    // waiting on the viewer carries the viewer's own mark, in brass.
    expect(
      Object.fromEntries(
        Object.entries(page.assignees).map(([state, entry]) => [
          state,
          [entry.handle, entry.viewer, entry.mark, entry.rightAligned],
        ]),
      ),
    ).toEqual({
      notify: ['@candy', false, true, true],
      pull: ['@candy', false, true, true],
      approve: ['@lunchboxfortwo', true, true, true],
      dispatch: ['@candy', false, true, true],
    });
    expect(page.assignees.approve!.color).toBe(BRASS);
    expect(page.assignees.pull!.color).not.toBe(BRASS);
    expect(page.labels).toContain('Approve, current step, Owner, Your call · gate');
    for (const role of ROLE_NAMES) expect(page.text.join(' ')).not.toContain(role);
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
        'entered',
        expect.stringMatching(/\d\d:\d\d:\d\d/),
        '2',
        'asked',
        'feedback-triage: approve',
        '3',
        'option A',
        'dispatch · go to dispatch',
        '4',
        'option B',
        'skip · go to done',
        '5',
        'answer',
        'waiting on you',
      ],
      controls: 0,
    });
    // Tapping a step opens its readout in place: times, outcome, what it delivered.
    expect(page.expanded).toEqual([
      '1',
      'entered',
      expect.stringMatching(/\d\d:\d\d:\d\d/),
      '2',
      'left',
      expect.stringMatching(/\d\d:\d\d:\d\d.* · ranked → Approve$/),
      '3',
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
      'Notify, done, Candy',
      'Pull, done, Candy',
      'Approve, skipped, Skipped · Pull: nothing new',
      'Dispatch, skipped, Skipped · Pull: nothing new',
      'Done, done, Ended by Pull',
    ]);
    expect(page.halo).toBe(0);
  }, 120_000);

  it("records who answered the gate, their note, and links each corner the dispatch opened", async () => {
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
            note: 'only the dropdown one, skip the rest',
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
    // The viewer answered the gate, so the row carries their own mark and handle.
    expect(gate.assignees.approve).toMatchObject({
      handle: '@lunchboxfortwo',
      viewer: true,
      mark: true,
      rightAligned: true,
      color: BRASS,
    });
    expect(gate.labels).toContain('Approve, done, Owner');
    expect(gate.expanded).toEqual([
      '1',
      'entered',
      expect.stringMatching(/\d\d:\d\d:\d\d/),
      '2',
      'left',
      expect.stringMatching(/ · dispatch → Dispatch$/),
      '3',
      'asked',
      'feedback-triage: approve',
      '4',
      'answer',
      expect.stringMatching(/^dispatch · Owner · \d\d:\d\d:\d\d/),
      '5',
      'note',
      'only the dropdown one, skip the rest',
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

  it('Reproduction 517: one rail, optional summary and generic receipt chips at phone and desktop widths', async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'research', description: 'Research and review',
        roomId: 'corner-2', roomName: 'Research', state: 'review', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 17 },
      contract: { version: 1, name: 'research', description: 'Research and review',
        summary: 'Collect evidence, then review the result.', roles: ['analyst'], start: 'collect',
        handoffs: {
          collect: { role: 'analyst', requires: [], on: { collected: 'review' } },
          review: { role: 'analyst', requires: [], on: { approved: 'done', rejected: 'failed' } },
          done: { kind: 'terminal', status: 'done' }, failed: { kind: 'terminal', status: 'failed' },
        } },
      history: [
        { toState: 'collect', actor: candy, at: STARTED },
        { fromState: 'collect', outcome: 'collected', toState: 'review', actor: candy, at: STARTED + 10,
          receipt: { line: 'Collected the indicators.', refs: [
            { kind: 'brief', label: 'Research brief', url: 'https://beeline.test/brief' },
            { kind: 'file', label: 'Indicators', url: 'https://beeline.test/indicators' },
            { kind: 'memory', label: 'Prior study', url: 'https://beeline.test/memory' },
          ], exit: { gate: 'collected', actorId: candy.id } } },
      ], roleHolders: { analyst: candy },
    };
    for (const width of [390, 1440]) {
      const page = await proof(detail, '?expand=collect', width);
      expect(page).toMatchObject({ overview: false, earlier: false, overflow: false,
        summary: detail.contract.summary });
      expect(Object.keys(page.circles)).toEqual(['collect', 'review', 'done']);
      expect(page.exits).toEqual({ 'collect-exit': '→ Review via collected',
        'review-exits': 'Exits: approved → Done · rejected → Failed' });
      expect(page.text).toContain('Collected the indicators.');
      expect(page.refs).toHaveLength(3);
      expect(page.refs).toEqual(expect.arrayContaining([
        'workflow-run-line-step-collect-ref-brief-0',
        'workflow-run-line-step-collect-ref-file-1',
        'workflow-run-line-step-collect-ref-memory-2',
      ]));
      expect(page.expanded).toEqual(expect.arrayContaining(['entered', 'left']));
    }
  }, 120_000);

  it("shows the working agent's live output on its step, and no mark on a step the server runs", async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'ship', description: 'Implement and check',
        roomId: 'corner-2', roomName: 'Ship', state: 'implement', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 0 },
      contract: { version: 1, name: 'ship', description: 'Implement and check', roles: ['implementer'],
        start: 'opened',
        handoffs: {
          opened: { kind: 'server', requires: [], on: { code: 'implement' } },
          implement: { role: 'implementer', requires: [], on: { pushed: 'checks' } },
          checks: { kind: 'server', requires: [], on: { passing: 'done' } },
          done: { kind: 'terminal', status: 'done' },
        } },
      history: [
        { toState: 'opened', actor: owner, at: STARTED },
        { fromState: 'opened', outcome: 'code', toState: 'implement', actor: owner, at: STARTED + 10 },
      ],
      roleHolders: { implementer: candy },
      viewer: owner,
    };
    const drafts = [
      { type: 'draft', roomId: 'corner-2', agentId: candy.id, turnId: 't1', text: 'Reading the run view.' },
      { type: 'draft', roomId: 'corner-2', agentId: candy.id, turnId: 't1',
        text: 'Reading the run view.\n\nAdding the handle to each row.' },
    ];
    const page = await proof(detail, '', 390, drafts);
    expect(page.live).toEqual({ implement: 'Reading the run view. Adding the handle to each row.' });
    expect(Object.keys(page.assignees)).toEqual(['implement']);
    expect(page.assignees.implement).toMatchObject({ handle: '@candy', viewer: false, rightAligned: true });
    expect(page.labels).toEqual(expect.arrayContaining([
      'Opened, done, Automatic',
      'Implement, current step, Candy',
      'Checks, not yet reached, Automatic',
    ]));
    for (const role of ROLE_NAMES) expect(page.text.join(' ')).not.toContain(role);
    // A draft from another agent paints nothing on this step.
    const other = await proof(detail, '', 390, [{ ...drafts[0], agentId: 'd'.repeat(64) }]);
    expect(other.live).toEqual({});
  }, 120_000);

});
