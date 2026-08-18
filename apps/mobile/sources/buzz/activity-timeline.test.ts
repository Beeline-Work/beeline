import { describe, expect, it } from 'vitest';
import { buildActivityTimeline, buildTurnActivity, latestCornerPlan } from './activity-timeline';

describe('buildActivityTimeline', () => {
  it('keeps a thinking firehose as one quiet progress item', () => {
    expect(
      buildActivityTimeline([
        { kind: 'thinking', title: 'Thinking', text: '**Planning platform detection**' },
        { kind: 'thinking', title: 'Thinking', text: 'Checking the runtime surface.' },
        { kind: 'thinking', title: 'Thinking', text: '**Implementing compact actions**' },
      ]),
    ).toEqual([
      {
        kind: 'reasoning',
        title: 'Implementing compact actions',
        detail:
          '**Planning platform detection**\nChecking the runtime surface.\n**Implementing compact actions**',
        count: 3,
      },
    ]);
  });

  it('turns tool plumbing into readable, collapsed actions', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'Tool', status: 'in_progress' },
        {
          kind: 'tool',
          title: 'grep "isChannelWorkIntent"',
          status: 'completed',
          text: '12 matches',
        },
        { kind: 'tool', title: 'Read /home/buzzy/apps/mobile/a.tsx', status: 'completed' },
        { kind: 'tool', title: 'Read /home/buzzy/apps/mobile/b.tsx', status: 'completed' },
        {
          kind: 'tool',
          title: 'bash: git status',
          status: 'completed',
          text: 'exited with code 0',
        },
      ]),
    ).toEqual([
      {
        kind: 'action',
        title: 'Searched the code for isChannelWorkIntent',
        count: 1,
      },
      {
        kind: 'action',
        title: 'Reviewed 2 files',
        count: 2,
      },
      {
        kind: 'action',
        title: 'Reviewed the current changes',
        count: 1,
      },
    ]);
  });

  it('turns failures into a human explanation and redacts full paths from details', () => {
    expect(
      buildActivityTimeline([
        {
          kind: 'tool',
          title: 'Code search',
          status: 'failed',
          text: 'Code search unavailable at /home/buzzy/.codegraph/index.db',
        },
      ]),
    ).toEqual([
      {
        kind: 'action',
        title: 'Code search unavailable',
        count: 1,
      },
    ]);
  });

  it('never surfaces a bare tool label or raw command output', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'Tool', status: 'completed', text: 'npm install --ignore-scripts' },
        { kind: 'tool', title: 'bash: pnpm lint', status: 'completed', text: 'All checks passed.' },
      ]),
    ).toEqual([
      { kind: 'action', title: 'Completed an action', count: 1 },
      { kind: 'action', title: 'Completed a project task', count: 1 },
    ]);
  });

  it('folds a repeated action into its first row even across other actions between them', () => {
    expect(
      buildActivityTimeline([
        { kind: 'tool', title: 'bash: git status', status: 'completed' },
        { kind: 'tool', title: 'grep "foo"', status: 'completed' },
        { kind: 'tool', title: 'bash: git status', status: 'completed' },
        { kind: 'tool', title: 'Read /a.tsx', status: 'completed' },
        { kind: 'tool', title: 'bash: git status', status: 'completed' },
      ]),
    ).toEqual([
      { kind: 'action', title: 'Reviewed the current changes', count: 3 },
      { kind: 'action', title: 'Searched the code for foo', count: 1 },
      { kind: 'action', title: 'Reviewed a.tsx', count: 1 },
    ]);
  });
});

describe('buildTurnActivity', () => {
  it('itemizes what was done and folds what was only looked at', () => {
    const turn = buildTurnActivity([
      { kind: 'thinking', title: 'Thinking', text: 'Internal narration' },
      {
        kind: 'tool',
        id: 'edit-1',
        title: 'Edit files',
        toolKind: 'edit',
        status: 'in_progress',
        files: [{ path: 'apps/mobile/chat.tsx' }],
      },
      {
        kind: 'tool',
        id: 'edit-1',
        title: 'Edit files',
        toolKind: 'edit',
        status: 'completed',
        output: 'Applied patch',
        files: [{ path: 'apps/mobile/chat.tsx', diff: '+new line' }],
      },
      {
        kind: 'tool',
        id: 'test-1',
        title: 'Run tests',
        toolKind: 'execute',
        command: 'npm test',
        output: '12 passed',
      },
      { kind: 'tool', id: 'read-1', title: 'Read file', toolKind: 'read' },
      { kind: 'tool', id: 'read-2', title: 'Read file', toolKind: 'read' },
      { kind: 'tool', id: 'search-1', title: 'Search code', toolKind: 'search' },
    ]);

    // A mutation and a command each keep their own line, with their detail.
    expect(turn.actions).toMatchObject([
      { kind: 'file', weight: 'mutation', path: 'apps/mobile/chat.tsx', diff: '+new line' },
      { kind: 'tool', weight: 'command', id: 'test-1', command: 'npm test', output: '12 passed' },
    ]);
    // ...and a tool call that touched files is *only* its files: no duplicate
    // parent row printing the same edit a second time.
    expect(turn.actions.filter((action) => action.id === 'edit-1')).toHaveLength(0);
    expect(turn.actions[0]?.output).toBe('Applied patch');

    // Three read-only calls become one counted note, never three rows.
    expect(turn.observations).toHaveLength(3);
    expect(turn.noteCount).toBe(3);
    expect(turn.note).toBe('3 TOOL CALLS · read 2, searched 1');
    // Reasoning is not narration and stays out of the reading column.
    expect(turn.narration).toEqual([]);
  });

  it('counts the observational calls that only ever reach the wire as a tally', () => {
    // Body drops reads/searches to stay under relay quotas and publishes just
    // their counts on the summary event, so this is the *only* source for them.
    const turn = buildTurnActivity([
      { kind: 'summary', title: 'Summary', text: 'Edited stats.py', rollup: { read: 41, searched: 12 } },
      { kind: 'tool', id: 'read-1', title: 'Read file', toolKind: 'read' },
    ]);

    expect(turn.noteCount).toBe(54);
    expect(turn.note).toBe('54 TOOL CALLS · read 42, searched 12');
    // The summary's own text is mechanism, not the agent's voice.
    expect(turn.narration).toEqual([]);
  });

  it('writes the same note in the present tense while the work is still in flight', () => {
    // grok Build writes its rollup twice — `Reading 2 files, Searching 4
    // patterns` in flight, `Read 2 files, Searched 4 patterns` once the group
    // settles — and the tense is the whole state report. Same count, same
    // order, same row.
    const turn = buildTurnActivity([
      { kind: 'summary', title: 'Summary', text: '', rollup: { read: 8, searched: 3, listed: 1 } },
    ]);

    expect(turn.note).toBe('12 TOOL CALLS · read 8, searched 3, listed 1');
    expect(turn.liveNote).toBe('12 TOOL CALLS · reading 8, searching 3, listing 1');
  });

  it('leaves an unforeseen verb in the past tense rather than inventing a non-word', () => {
    const turn = buildTurnActivity([
      { kind: 'summary', title: 'Summary', text: '', rollup: { transmogrified: 2 } },
    ]);

    expect(turn.liveNote).toBe('2 TOOL CALLS · transmogrified 2');
  });

  it('carries the reasoning receipt without ever carrying the reasoning', () => {
    const turn = buildTurnActivity([
      { kind: 'summary', title: 'Summary', text: '', rollup: { read: 2 }, thoughtMs: 5_800 },
      { kind: 'summary', title: 'Summary', text: '', thoughtMs: 1_200 },
    ]);

    // Successive batches report disjoint spans, so they add up to the turn's.
    expect(turn.thoughtMs).toBe(7_000);
  });

  it('keeps the agent’s prose as narration, never folded into the note', () => {
    const turn = buildTurnActivity([
      { kind: 'output', title: 'Update', text: 'Found the projection boundary.' },
      {
        kind: 'tool',
        id: 'plan-1',
        title: 'Update plan',
        plan: {
          items: [
            { step: 'Trace projection', status: 'completed' },
            { step: 'Build drill-down', status: 'in_progress' },
          ],
        },
      },
    ]);

    expect(turn.narration).toEqual(['Found the projection boundary.']);
    expect(turn.plan).toMatchObject({
      items: [
        { step: 'Trace projection', status: 'completed' },
        { step: 'Build drill-down', status: 'in_progress' },
      ],
    });
  });

  it('pulls a failure out of the fold, even when it was only a read', () => {
    const turn = buildTurnActivity([
      { kind: 'tool', id: 'read-1', title: 'Read file', toolKind: 'read' },
      { kind: 'tool', id: 'read-2', title: 'Read file', toolKind: 'read', status: 'failed' },
    ]);

    expect(turn.actions).toHaveLength(1);
    expect(turn.actions[0]).toMatchObject({ weight: 'failure' });
    expect(turn.observations).toHaveLength(1);
    expect(turn.note).toBe('1 TOOL CALL · read 1');
  });

  it('says nothing at all when a turn only observed nothing', () => {
    const turn = buildTurnActivity([]);
    expect(turn.note).toBeUndefined();
    expect(turn.noteCount).toBe(0);
    expect(turn.narration).toEqual([]);
    expect(turn.actions).toEqual([]);
  });

  it('turns body’s per-call receipts into real observation rows, not just a tally', () => {
    // Before body shipped `observed` on the summary event, a folded batch had
    // no per-call detail at all — the review sheet had nothing to show beyond
    // the count. Each receipt becomes its own row here, carrying a readable
    // title (verb + target) and the short result as its output.
    const turn = buildTurnActivity([
      {
        kind: 'summary',
        title: 'Summary',
        text: '',
        rollup: { read: 1, ran: 1 },
        observed: [
          { verb: 'read', target: 'src/foo.ts', result: 'export function foo() {}' },
          { verb: 'ran', target: 'npm test -- --run' },
        ],
      },
    ]);

    expect(turn.observations).toHaveLength(2);
    expect(turn.observations).toMatchObject([
      { weight: 'observation', title: 'Read src/foo.ts', output: 'export function foo() {}' },
      { weight: 'observation', title: 'Ran npm test -- --run' },
    ]);
    // A call with no result carries no output field at all, not an empty one.
    expect(turn.observations[1]).not.toHaveProperty('output');
    // Every observation row needs a stable, unique id for React and for the
    // review sheet's own drill-down state.
    expect(new Set(turn.observations.map((action) => action.id)).size).toBe(2);
  });
});

describe('latestCornerPlan', () => {
  it('returns undefined when no message has published a plan (no empty pin)', () => {
    expect(latestCornerPlan([{ activity: [{ kind: 'output', title: 'Update', text: 'hi' }] }])).toBeUndefined();
    expect(latestCornerPlan([])).toBeUndefined();
  });

  it('returns the single published plan', () => {
    const plan = { items: [{ step: 'Trace projection', status: 'completed' as const }] };
    expect(latestCornerPlan([{ activity: [{ kind: 'tool', title: 'Plan', plan }] }])).toEqual(plan);
  });

  it('a later plan update replaces the whole checklist, in message order across the transcript', () => {
    const first = { items: [{ step: 'Trace projection', status: 'in_progress' as const }] };
    const second = {
      items: [
        { step: 'Trace projection', status: 'completed' as const },
        { step: 'Build drill-down', status: 'in_progress' as const },
      ],
    };

    expect(
      latestCornerPlan([
        { activity: [{ kind: 'tool', title: 'Plan', plan: first }] },
        { activity: [{ kind: 'output', title: 'Update', text: 'still working' }] },
        { activity: [{ kind: 'tool', title: 'Plan', plan: second }] },
      ]),
    ).toEqual(second);
  });
});
