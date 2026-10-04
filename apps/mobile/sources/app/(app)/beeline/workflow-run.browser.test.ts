import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
function workflowRunShims(
  mobile: string,
  detail: unknown,
  drafts: unknown[] = [],
  siblingRuns: unknown[] = [],
): Record<string, string> {
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
      replace: (href) => { (globalThis.__replaced ??= []).push(href); }, back: () => undefined };`,
    '@/sync/transport/monolith-operation': `export class MonolithPhoneOperationError extends Error {}
    export const monolithPhoneOperation = async (name) =>
      name === 'listRoomWorkflowRuns' ? { workflows: ${JSON.stringify(siblingRuns)} } : (${JSON.stringify(detail)});`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
  };
}

type Proof = {
  text: string[];
  overview: boolean;
  earlier: boolean;
  summary: string | null;
  does: Record<string, string>;
  overflow: boolean;
  eyebrowFont: string | null;
  titleFont: string | null;
  fontOf: string | null;
  circles: Record<string, string>;
  lines: string[];
  labels: string[];
  halo: number;
  assignees: Record<
    string,
    { handle: string; viewer: boolean; mark: boolean; color: string; rightAligned: boolean }
  >;
  live: Record<string, string>;
  finals: Record<string, string>;
  durations: string[];
  gate: Record<string, string>;
  corners: string[];
  alsoRunning: string[];
  pushedBefore: unknown[];
  pushed: unknown[];
  replaced: unknown[];
};

async function proof(
  detail: unknown,
  query: string,
  width = 390,
  drafts: unknown[] = [],
  siblingRuns: unknown[] = [],
): Promise<Proof> {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/workflow-run-proof.tsx'),
    mobile,
    shims: workflowRunShims(mobile, detail, drafts, siblingRuns),
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
    const page = await proof(detail, '?eyebrow=Issues%20triage&title=Feedback%20triage');
    // The same title role as the corner, with no previous-run count.
    expect(page.text.slice(0, 2)).toEqual(['Issues triage', 'Feedback triage']);
    expect(page).toMatchObject({ overview: false, earlier: false, summary: null });
    expect(page.text).not.toContain('#14');
    expect(page).toMatchObject({
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
    });
    expect(page.text).toContain('Waiting on you');
    // Each step's holder sits at the row's right as a mark and handle; the gate
    // waiting on the viewer carries the viewer's own mark, in brass. The
    // predicted (unreached) dispatch step already shows its bound role holder.
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
    // Every step of the contract draws, in order: done, current, and the
    // predicted path onward (pending, dimmed) to its first guessed terminal.
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
    // The gate is a read-only record: whose move it is, never a control.
    expect(page.gate).toEqual({ approve: 'Waiting on you' });
    // No Open → to the run's own corner, and nothing navigates on its own.
    expect(page.text.join(' ')).not.toContain('Open →');
    expect(page.pushedBefore).toEqual([]);
  }, 120_000);

  it('shows only the steps the branch reached, with nothing left to predict once the run ends', async () => {
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
    expect(page.circles).toEqual({
      notify: 'done',
      pull: 'done',
      done: 'done',
    });
    expect(page.lines).toEqual(['notify-below-brass', 'pull-above-brass', 'pull-below-brass', 'done-above-brass']);
    expect(page.labels).toEqual(['Notify, done, Candy', 'Pull, done, Candy', 'Done, done, Ended by Pull']);
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
    // A finished step starts collapsed to its one-line description, so its
    // gate record and the corners it opened need their headers tapped open.
    const gate = await proof(detail, '?expandAll=1');
    // The viewer answered the gate, so the row carries their own mark and handle.
    expect(gate.assignees.approve).toMatchObject({
      handle: '@lunchboxfortwo',
      viewer: true,
      mark: true,
      rightAligned: true,
      color: BRASS,
    });
    expect(gate.labels).toContain('Approve, done, Owner');
    // The gate's record is read-only: the chosen answer and who chose it,
    // never the question, options, or a note.
    expect(gate.gate).toEqual({ approve: 'dispatch · Owner' });
    // The corner(s) the dispatch step opened are plain links, right under its row.
    expect(gate.text).toEqual(expect.arrayContaining(['Corner dropdown fix', 'Mock file type fix']));
    const dispatch = await proof(detail, '?corner=fix-2&expandAll=1');
    // The corner link goes to that corner, under the Room it was opened in.
    expect(dispatch.pushedBefore).toEqual([]);
    expect(dispatch.pushed).toEqual([
      {
        pathname: '/beeline/chat/[channelId]',
        params: { channelId: 'fix-2', parent: 'room-1', title: 'Mock file type fix' },
      },
    ]);
  }, 120_000);

  it('Reproduction wf-human-1: saved descriptions replace exits at phone and desktop widths', async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'research', description: 'Research and review',
        roomId: 'corner-2', roomName: 'Research', state: 'review', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 17 },
      contract: { version: 1, name: 'research', description: 'Research and review',
        summary: 'Collect evidence, then review the result.', roles: ['analyst'], start: 'collect',
        handoffs: {
          collect: { does: 'Collect the evidence.', role: 'analyst', requires: [], on: { collected: 'review' } },
          review: { does: 'Review the evidence.', role: 'analyst', requires: [], on: { approved: 'done', rejected: 'failed' } },
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
      const page = await proof(detail, '', width);
      expect(page).toMatchObject({ overview: false, earlier: false, overflow: false,
        summary: detail.contract.summary });
      // review is current, so the predicted path adds its first guessed terminal.
      expect(Object.keys(page.circles)).toEqual(['collect', 'review', 'done']);
      expect(page.circles.done).toBe('pending');
      expect(page.does).toEqual({ collect: 'Collect the evidence.', review: 'Review the evidence.' });
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
        { fromState: 'opened', outcome: 'code', toState: 'implement', actor: owner, at: STARTED + 10, outputTurns: [`${candy.id}:t1`] },
      ],
      roleHolders: { implementer: candy },
      viewer: owner,
    };
    // Use the real helper producer, with token-sized deltas and a slow wire.
    // Loading it at runtime keeps host-only types out of mobile typecheck.
    const { AgentTurnStream } = await vi.importActual<any>(path.join(repo(), 'apps/body/src/turn-stream.ts'));
    const drafts: Array<Record<string, unknown>> = [];
    const releases: Array<() => void> = [];
    const stream = new AgentTurnStream({ agentId: candy.id, roomId: 'corner-2', requestId: 't1', label: 'proof',
      api: { execute: (_name: string, input: Record<string, unknown>) => {
        drafts.push({ type: 'draft', ...input });
        return new Promise<void>(resolve => releases.push(resolve));
      } } });
    let currentRun = '';
    for (const delta of ['Read', 'ing', ' the', ' run', ' view', '.']) {
      currentRun += delta;
      stream.onChunk(delta, currentRun, currentRun);
    }
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    const prior = currentRun;
    currentRun = '';
    for (const delta of ['Add', 'ing', ' the', ' handle', ' to', ' each', ' row', '.']) {
      currentRun += delta;
      stream.onChunk(delta, `${prior}\n\n${currentRun}`, currentRun);
    }
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    releases.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    expect(drafts.map(draft => draft.latestChunk)).toEqual(['Read', 'Reading the run view.', 'Adding the handle to each row.']);
    const page = await proof(detail, '', 390, drafts);
    expect(page.live).toEqual({ implement: 'Adding the handle to each row.' });
    expect(Object.keys(page.assignees)).toEqual(['implement']);
    expect(page.assignees.implement).toMatchObject({ handle: '@candy', viewer: false, rightAligned: true });
    expect(page.labels).toEqual(expect.arrayContaining([
      'Opened, done, Automatic',
      'Implement, current step, Candy',
    ]));
    for (const role of ROLE_NAMES) expect(page.text.join(' ')).not.toContain(role);
    // A draft from another agent paints nothing on this step.
    const other = await proof(detail, '', 390, [{ ...drafts[0], agentId: 'd'.repeat(64) }]);
    expect(other.live).toEqual({});
    const unrelated = await proof(detail, '', 390, [{ ...drafts[0], turnId: 'other-run' }]);
    expect(unrelated.live).toEqual({});
  }, 120_000);

  it('Reproduction wf-human-1: a fresh render keeps each finished visit final and the current newest chunk', async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'research', description: 'Research and review',
        roomId: 'corner-2', roomName: 'Research', state: 'collect', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 20, earlierRunCount: 0 },
      contract: { version: 1, name: 'research', description: 'Research and review',
        summary: 'Collect evidence and review it.', roles: ['analyst'], start: 'collect', handoffs: {
          collect: { does: 'Collect the evidence.', role: 'analyst', requires: [], on: { collected: 'review' } },
          review: { does: 'Review the evidence.', role: 'analyst', requires: [], on: { retry: 'collect', approved: 'done' } },
          done: { does: 'The research is finished.', kind: 'terminal', status: 'done' },
          failed: { kind: 'terminal', status: 'failed' },
        } },
      history: [
        { visitId: 'first', toState: 'collect', at: STARTED, finalReply: { messageId: 'm1', text: 'First evidence result.' } },
        { visitId: 'second', fromState: 'collect', toState: 'review', outcome: 'collected', actor: candy,
          at: STARTED + 10, finalReply: { messageId: 'm2', text: 'Review requests another visit.' } },
        { visitId: 'third', fromState: 'review', toState: 'collect', outcome: 'retry', actor: candy,
          at: STARTED + 20, outputTurns: [`${candy.id}:current`], liveOutput: 'Latest saved chunk.' },
      ], roleHolders: { analyst: candy }, viewer: owner,
    };
    for (const width of [390, 1440]) {
      // Each finished visit starts collapsed to its one-line description;
      // tap every header open to read its final reply back.
      const page = await proof(detail, '?expandAll=1', width, [{ type: 'draft', roomId: 'corner-2', agentId: candy.id,
        turnId: 'old-turn', text: 'Unrelated draft', latestChunk: 'Unrelated draft' }]);
      expect(Object.keys(page.circles)).toEqual(['collect', 'review', 'collect-visit-2']);
      expect(page.finals).toEqual({ collect: 'First evidence result.', review: 'Review requests another visit.' });
      expect(page.live).toEqual({ 'collect-visit-2': 'Latest saved chunk.' });
      expect(page.durations.slice(0, 2)).toEqual(['10s', '10s']);
      expect(page.overflow).toBe(false);
    }
    const complete = { ...detail, run: { ...detail.run, state: 'done', status: 'done', updatedAt: STARTED + 30 },
      history: [...detail.history.slice(0, 2), { ...detail.history[2], finalReply: { messageId: 'm3', text: 'Second evidence result.' } },
        { visitId: 'last', fromState: 'collect', toState: 'done', outcome: 'approved', at: STARTED + 30 }] };
    const refreshed = await proof(complete, '?expandAll=1');
    expect(refreshed.finals['collect-visit-2']).toBe('Second evidence result.');
    expect(refreshed.live).toEqual({});
    // The terminal that ends the run reads by the clock it was reached, not a duration.
    expect(refreshed.durations.slice(0, 3)).toEqual(['10s', '10s', '10s']);
    expect(refreshed.durations[3]).toMatch(/\d\d?:\d\d/);
  }, 120_000);

  it('shows every other live run in the corner, any workflow, and replaces the page when switching', async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'mm-desk', description: 'MM desk', roomId: 'corner-2',
        roomName: 'MM desk', state: 'verify', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 0 },
      contract: { version: 1, name: 'mm-desk', description: 'MM desk', roles: ['scout', 'verify'],
        start: 'scout', handoffs: {
          scout: { does: 'Scans markets.', role: 'scout', requires: [], on: { done: 'verify' } },
          verify: { does: 'Verifies pairs.', role: 'verify', requires: [], on: { done: 'done' } },
          done: { kind: 'terminal', status: 'done' },
        } },
      history: [
        { toState: 'scout', actor: candy, at: STARTED },
        { fromState: 'scout', outcome: 'done', toState: 'verify', actor: candy, at: STARTED + 10 },
      ],
      roleHolders: { scout: candy, verify: candy },
    };
    const siblingRuns = [
      { runId: 'run-1', workflowSlug: 'mm-desk', description: 'MM desk', roomId: 'corner-2',
        roomName: 'MM desk', state: 'verify', status: 'live', viewerHolds: false, holder: candy,
        startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 0 },
      // A different workflow entirely, concurrently live in the same corner.
      { runId: 'run-2', workflowSlug: 'macro-paper-desk', description: 'Macro desk', roomId: 'corner-2',
        roomName: 'MM desk', state: 'draft', status: 'live', viewerHolds: false, holder: owner,
        startedAt: STARTED + 50, updatedAt: STARTED + 60, earlierRunCount: 0 },
    ];
    const page = await proof(detail, '', 390, [], siblingRuns);
    expect(page.text).toContain('Also running in this corner');
    // The section excludes this page's own run, listing only the other one.
    expect(page.alsoRunning).toEqual(['workflow-run-also-running-run-2']);
    expect(page.text).toEqual(expect.arrayContaining(['Macro paper desk · Draft', '@lunchboxfortwo']));
    const switched = await proof(detail, '?switchTo=run-2', 390, [], siblingRuns);
    // A tap REPLACES this page in the stack, not a push, so Back from the
    // next run always lands on the corner, never back on this one.
    expect(switched.pushed).toEqual([]);
    expect(switched.replaced).toEqual([
      { pathname: '/beeline/workflow-run', params: { roomId: 'corner-2', runId: 'run-2' } },
    ]);
  }, 120_000);

  it('starts a finished step collapsed to its one-line description, opening on a header tap, while the current step starts open', async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'mm-desk', description: 'MM desk', roomId: 'corner-2',
        roomName: 'MM desk', state: 'verify', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 0 },
      contract: { version: 1, name: 'mm-desk', description: 'MM desk', roles: ['scout', 'verify'],
        start: 'scout', handoffs: {
          scout: { does: 'Scans markets.', role: 'scout', requires: [], on: { done: 'verify' } },
          verify: { does: 'Verifies pairs.', role: 'verify', requires: [], on: { done: 'done' } },
          done: { kind: 'terminal', status: 'done' },
        } },
      history: [
        { toState: 'scout', actor: candy, at: STARTED,
          finalReply: { messageId: 'm1', text: 'Found three pairs worth checking.' } },
        { fromState: 'scout', outcome: 'done', toState: 'verify', actor: candy, at: STARTED + 10,
          outputTurns: [`${candy.id}:t1`] },
      ],
      roleHolders: { scout: candy, verify: candy },
    };
    const drafts = [{ type: 'draft', roomId: 'corner-2', agentId: candy.id, turnId: 't1',
      text: 'Checking spreads.', latestChunk: 'Checking spreads.' }];
    const collapsed = await proof(detail, '', 390, drafts);
    // The finished step's one-line description still shows; its final reply doesn't.
    expect(collapsed.does.scout).toBe('Scans markets.');
    expect(collapsed.finals).toEqual({});
    // The current step needs no tap: its live output is already on the page.
    expect(collapsed.live).toEqual({ verify: 'Checking spreads.' });
    const opened = await proof(detail, '?toggle=scout', 390, drafts);
    expect(opened.finals).toEqual({ scout: 'Found three pairs worth checking.' });
    // Tapping the open current step's own header hides its live output again.
    const closedCurrent = await proof(detail, '?toggle=verify', 390, drafts);
    expect(closedCurrent.live).toEqual({});
  }, 120_000);

  it("shows a done gate's own resolution only once, not again as the agent's final message", async () => {
    const detail = feedbackTriageDetail(
      repo(),
      { state: 'done', status: 'done', viewerHolds: false, updatedAt: STARTED + 210 },
      [
        { toState: 'pull', actor: candy, at: STARTED },
        {
          fromState: 'pull',
          outcome: 'ranked',
          toState: 'approve',
          actor: candy,
          at: STARTED + 100,
          // The agent's own message posting the gate's question.
          finalReply: { messageId: 'm1', text: 'Ready to dispatch the dropdown fix?' },
          gate: {
            question: 'feedback-triage: approve',
            options: GATE_OPTIONS,
            status: 'answered',
            answer: 'dispatch',
            answeredBy: owner,
            answeredAt: STARTED + 200,
          },
        },
        { fromState: 'approve', outcome: 'dispatch', toState: 'done', status: 'done', actor: candy, at: STARTED + 210 },
      ],
    );
    const page = await proof(detail, '?expandAll=1');
    // Only the gate's own resolution line shows; the question that posted it does not.
    expect(page.gate).toEqual({ approve: 'dispatch · Owner' });
    expect(page.finals).toEqual({});
    expect(page.text).not.toContain('Ready to dispatch the dropdown fix?');
  }, 120_000);

  it("sizes a step's live and final text to its one-line description, not the Room's larger message size", async () => {
    const detail = {
      run: { runId: 'run-1', workflowSlug: 'research', description: 'Research and review',
        roomId: 'corner-2', roomName: 'Research', state: 'review', status: 'live', viewerHolds: false,
        holder: candy, startedAt: STARTED, updatedAt: STARTED + 10, earlierRunCount: 0 },
      contract: { version: 1, name: 'research', description: 'Research and review',
        roles: ['analyst'], start: 'collect', handoffs: {
          collect: { does: 'Collect the evidence.', role: 'analyst', requires: [], on: { collected: 'review' } },
          review: { does: 'Review the evidence.', role: 'analyst', requires: [], on: { approved: 'done' } },
          done: { kind: 'terminal', status: 'done' },
        } },
      history: [
        { toState: 'collect', actor: candy, at: STARTED,
          finalReply: { messageId: 'm1', text: 'Collected the indicators.' } },
        { fromState: 'collect', outcome: 'collected', toState: 'review', actor: candy, at: STARTED + 10 },
      ],
      roleHolders: { analyst: candy },
    };
    const page = await proof(detail, '?toggle=collect&fontOf=Collect the evidence.');
    // `does` (the one-line description) sets the scale: 13px, the same role
    // as every other secondary line on the page.
    expect(page.fontOf).toBe('13px SpaceGrotesk-Regular');
    const finalPage = await proof(detail, '?toggle=collect&fontOf=Collected the indicators.');
    // The agent's final reply reads at that same size, not the Room's 16px prose.
    expect(finalPage.fontOf).toBe('13px SpaceGrotesk-Regular');
  }, 120_000);
});
