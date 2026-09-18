import { describe, expect, it } from 'vitest';
import type { TurnActivityAction } from './activity-timeline';
import { groupToolLedgerRuns, toolGlyph, toolGroupSummary, toolLedgerLines } from './tool-ledger';

const step = (patch: Partial<TurnActivityAction> & { id: string }): TurnActivityAction => ({
  kind: 'tool',
  weight: 'command',
  title: 'Tool',
  label: 'tool',
  outcome: 'success',
  ...patch,
});

describe('toolGlyph', () => {
  it('gives shell work the two-character prompt glyph', () => {
    expect(toolGlyph({ kind: 'tool', toolKind: 'execute' })).toBe('>_');
  });

  it('gives the file family the one fold-line', () => {
    for (const verb of ['read', 'edit', 'write', 'patch', 'list', 'search', 'move', 'delete']) {
      expect(toolGlyph({ kind: 'tool', toolKind: verb })).toBe('≡');
    }
  });

  it('gives a thought the fold glyph, and everything else the quiet dot', () => {
    expect(toolGlyph({ kind: 'thought' })).toBe('⋯');
    expect(toolGlyph({ kind: 'tool', toolKind: 'fetch' })).toBe('·');
    expect(toolGlyph({ kind: 'tool', toolKind: 'mcp' })).toBe('·');
    expect(toolGlyph({ kind: 'tool' })).toBe('·');
  });
});

describe('toolLedgerLines', () => {
  it('labels a tool line with the call’s object, not the verb', () => {
    const [line] = toolLedgerLines([
      step({ id: 'a', toolKind: 'execute', command: 'npm test', title: 'Bash' }),
    ]);
    expect(line!.label).toBe('npm test');
    expect(line!.glyph).toBe('>_');
    expect(line!.outcome).toBe('success');
  });

  it('carries the distilled failure reason inline only on failures', () => {
    const [failed, passed] = toolLedgerLines([
      step({
        id: 'f',
        toolKind: 'execute',
        command: 'pnpm fast-gate',
        outcome: 'failure',
        weight: 'failure',
        reason: 'command not found: pnpm',
        output: '[{"type":"terminal","terminalId":"exec-1"}]',
        status: 'error',
      }),
      step({ id: 'p', toolKind: 'execute', command: 'pnpm fast-gate', reason: 'stale reason' }),
    ]);
    expect(failed!.reason).toBe('command not found: pnpm');
    expect(passed!.reason).toBeUndefined();
  });

  it('omits the duration gutter when no receipt carried one, and never fakes one', () => {
    const [noDuration, tooShort, shown] = toolLedgerLines([
      step({ id: 'n', toolKind: 'read', title: 'Read' }),
      step({ id: 's', toolKind: 'read', title: 'Read', durationMs: 900 }),
      step({ id: 'd', toolKind: 'read', title: 'Read', durationMs: 2100 }),
    ]);
    expect(noDuration!.durationMs).toBeUndefined();
    expect(tooShort!.durationMs).toBeUndefined();
    expect(shown!.durationMs).toBe(2100);
  });

  it('composes the sheet detail from reason, files, and the envelope-stripped output', () => {
    const [line] = toolLedgerLines([
      step({
        id: 'd',
        toolKind: 'read',
        title: 'Read',
        reason: 'permission denied',
        files: [{ path: 'sources/Ledger.tsx', status: 'M' }],
        output: '[{"type":"content","content":{"type":"text","text":"first\\nsecond"}}]',
      }),
    ]);
    expect(line!.detail).toBe(
      ['permission denied', 'M sources/Ledger.tsx', 'first', 'second'].join('\n'),
    );
  });

  it('a step with nothing behind it is not pressable — no detail at all', () => {
    const [line] = toolLedgerLines([
      step({
        id: 'q',
        toolKind: 'read',
        title: 'Read',
        output: '[{"type":"terminal","terminalId":"x"}]',
      }),
    ]);
    expect(line!.detail).toBeUndefined();
  });

  it('a thought carries its text as detail; a summary-only thought stays quiet', () => {
    const [texted, quiet] = toolLedgerLines([
      step({
        id: 't',
        kind: 'thought',
        label: 'thought',
        output: 'weighing the two layouts',
        durationMs: 51_000,
      }),
      step({ id: 's', kind: 'thought', label: 'thought', durationMs: 12_000 }),
    ]);
    expect(texted!.kind).toBe('thought');
    expect(texted!.detail).toBe('weighing the two layouts');
    expect(quiet!.detail).toBeUndefined();
  });

  it('carries the grant attribution into the sheet detail', () => {
    const [line] = toolLedgerLines([
      step({
        id: 'g',
        toolKind: 'execute',
        command: 'npm test',
        requestedBy: { pubkey: 'abc123', name: 'lunchbox' },
      }),
    ]);
    expect(line!.detail).toBe("at lunchbox's request");
  });

  it('the live turn’s last step reads as running; everything else settles', () => {
    const steps = [
      step({ id: 'a', toolKind: 'read', title: 'Read' }),
      step({ id: 'b', toolKind: 'execute', command: 'npm test', status: 'exit 0' }),
    ];
    const [first, last] = toolLedgerLines(steps, true);
    expect(first!.outcome).toBe('success');
    expect(last!.outcome).toBe('running');
    const [still, settled] = toolLedgerLines(steps, false);
    expect(still!.outcome).toBe('success');
    expect(settled!.outcome).toBe('success');
  });
});

describe('groupToolLedgerRuns', () => {
  const run = (ids: string[]) =>
    toolLedgerLines(ids.map((id) => step({ id, toolKind: 'read', title: 'Read' })));

  it.each([1, 2, 3])('folds a %i-step machine run into one group', (count) => {
    const ids = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
    const [group, ...rest] = groupToolLedgerRuns(run(ids));
    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({ kind: 'group', id: 'a', count, failed: 0 });
    expect(group!.lines.map((line) => line.id)).toEqual(ids);
  });

  it('returns no disclosure for an empty machine run', () => {
    expect(groupToolLedgerRuns([])).toEqual([]);
  });

  it('counts failures and sums the durations the receipts carried', () => {
    const lines = toolLedgerLines([
      step({ id: 'a', toolKind: 'read', title: 'Read', durationMs: 1000 }),
      step({ id: 'b', toolKind: 'read', title: 'Read', durationMs: 2000 }),
      step({
        id: 'f',
        toolKind: 'execute',
        command: 'pnpm fast-gate',
        outcome: 'failure',
        weight: 'failure',
        reason: 'command not found: pnpm',
      }),
      step({ id: 'd', toolKind: 'read', title: 'Read', durationMs: 45_000 }),
    ]);
    const [group] = groupToolLedgerRuns(lines);
    expect(group).toMatchObject({ kind: 'group', count: 4, failed: 1, durationMs: 48_000 });
  });

  it('a group with no duration above the floor omits the gutter', () => {
    const lines = toolLedgerLines([
      step({ id: 'a', toolKind: 'read', title: 'Read', durationMs: 200 }),
      step({ id: 'b', toolKind: 'read', title: 'Read' }),
      step({ id: 'c', toolKind: 'read', title: 'Read' }),
      step({ id: 'd', toolKind: 'read', title: 'Read' }),
    ]);
    const [group] = groupToolLedgerRuns(lines);
    expect(group).toMatchObject({ kind: 'group', count: 4 });
    expect(group).not.toHaveProperty('durationMs');
  });
});

describe('toolGroupSummary', () => {
  it('reads `6 steps · 2 failed · 48s`', () => {
    expect(toolGroupSummary(6, 2, 48_000)).toBe('6 steps · 2 failed · 48.0s');
  });

  it('a clean run carries no failed segment', () => {
    expect(toolGroupSummary(6, 0, 48_000)).toBe('6 steps · 48.0s');
  });

  it('one step, and no duration below the floor', () => {
    expect(toolGroupSummary(1, 0, undefined)).toBe('1 step');
    expect(toolGroupSummary(4, 0, 500)).toBe('4 steps');
  });
});
