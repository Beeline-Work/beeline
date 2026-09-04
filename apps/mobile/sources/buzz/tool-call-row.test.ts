import { describe, expect, it } from 'vitest';
import type { TurnActivityAction } from './activity-timeline';
import {
  formatToolCallDuration,
  middleTruncate,
  toolCallOutput,
  toolCallRow,
  TOOL_CALL_OBJECT_MAX,
} from './tool-call-row';

const step = (patch: Partial<TurnActivityAction> & { id: string }): TurnActivityAction => ({
  kind: 'tool',
  weight: 'command',
  title: 'Tool',
  label: 'tool',
  outcome: 'success',
  ...patch,
});

describe('middleTruncate', () => {
  it('keeps the head and the tail — the flags at the end carry the meaning', () => {
    const command = 'npm run test --workspace apps/mobile -- --coverage --reporter=json';
    const shown = middleTruncate(command);
    expect(shown.length).toBeLessThanOrEqual(TOOL_CALL_OBJECT_MAX);
    expect(shown).toContain('…');
    expect(command.startsWith(shown.split('…')[0]!)).toBe(true);
    expect(command.endsWith(shown.split('…')[1]!)).toBe(true);
    expect(shown).toContain('--reporter=json');
  });

  it('leaves a short command whole', () => {
    expect(middleTruncate('npm test')).toBe('npm test');
  });
});

describe('toolCallOutput', () => {
  it('renders nothing when all we were handed is a transport envelope', () => {
    expect(toolCallOutput('[{"type":"terminal","terminalId":"exec-994c47ee-1f2a"}]')).toEqual([]);
  });

  it('lifts the real text out of a content envelope', () => {
    expect(
      toolCallOutput('[{"type":"content","content":{"type":"text","text":"12 passed\\n1 skipped"}}]'),
    ).toEqual(['12 passed', '1 skipped']);
  });

  it('passes plain text through, dropping blank lines and ANSI', () => {
    expect(toolCallOutput('first line\n\n\u001b[31mred line\u001b[0m')).toEqual([
      'first line',
      'red line',
    ]);
  });
});

describe('formatToolCallDuration', () => {
  it('says nothing below a second', () => {
    expect(formatToolCallDuration(940)).toBeUndefined();
    expect(formatToolCallDuration(undefined)).toBeUndefined();
  });

  it('reads in seconds, then minutes', () => {
    expect(formatToolCallDuration(1400)).toBe('1.4s');
    expect(formatToolCallDuration(125_000)).toBe('2m 05s');
  });
});

describe('toolCallRow', () => {
  it('leads a shell call with `ran` and the command itself', () => {
    const row = toolCallRow(step({ id: 'a', toolKind: 'execute', command: 'npm test', title: 'Bash' }));
    expect([row.verb, row.object]).toEqual(['ran', 'npm test']);
  });

  it('gives git its own verb and keeps only the subcommand as the object', () => {
    const row = toolCallRow(
      step({ id: 'g', toolKind: 'execute', command: 'git status --short', title: 'Bash' }),
    );
    expect([row.verb, row.object]).toEqual(['git', 'status --short']);
  });

  it('prefers the command over the harness title, which describes another call', () => {
    const row = toolCallRow(
      step({ id: 'l', toolKind: 'execute', command: 'ls -la sources', title: 'Reviewed the current changes' }),
    );
    expect(row.object).toBe('ls -la sources');
  });

  it('names a read by its basename', () => {
    const row = toolCallRow(
      step({ id: 'r', toolKind: 'read', title: 'Read', files: [{ path: 'apps/mobile/Ledger.tsx' }] }),
    );
    expect([row.verb, row.object]).toEqual(['read', 'Ledger.tsx']);
  });

  it('names a write by its basename', () => {
    const row = toolCallRow(
      step({ id: 'w', toolKind: 'edit', title: 'Edit files', files: [{ path: 'sources/buzz/tool-call-row.ts' }] }),
    );
    expect([row.verb, row.object]).toEqual(['wrote', 'tool-call-row.ts']);
  });

  it('carries a search pattern and the tool’s own hit count', () => {
    const row = toolCallRow(
      step({
        id: 's',
        toolKind: 'search',
        title: 'Grep',
        input: '{"pattern":"toolCallRow","path":"sources"}',
        output: '12 matches across 3 files',
      }),
    );
    expect([row.verb, row.object]).toEqual(['found', 'toolCallRow · 12 hits']);
  });

  it('leads an MCP call with the tool’s own short name', () => {
    const row = toolCallRow(step({ id: 'm', toolKind: 'other', title: 'mcp__squire__list_credentials' }));
    expect([row.verb, row.object]).toEqual(['list_credentials', 'squire']);
  });

  it('keeps the failure reason and drops the transport envelope from the output', () => {
    const row = toolCallRow(
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
    );
    expect(row.outcome).toBe('failure');
    expect(row.reason).toBe('command not found: pnpm');
    expect(row.output).toEqual([]);
  });

  it('calls the last unsettled call of a running group in flight, and nothing else', () => {
    const pending = step({ id: 'p', toolKind: 'execute', command: 'npm run build' });
    expect(toolCallRow(pending, true).outcome).toBe('running');
    expect(toolCallRow(pending, false).outcome).toBe('success');
    expect(toolCallRow({ ...pending, status: 'exit 0' }, true).outcome).toBe('success');
  });

  it('reads an older transcript’s folded rollup row as the calls it counts', () => {
    const row = toolCallRow(step({ id: 'sum', toolKind: 'read', title: 'reading 8' }));
    expect([row.verb, row.object]).toEqual(['read', '8 calls']);
  });

  it('strips the verb the column already carries off a title-only call', () => {
    const row = toolCallRow(step({ id: 'o', toolKind: 'read', title: 'Read Ledger.tsx' }));
    expect([row.verb, row.object]).toEqual(['read', 'Ledger.tsx']);
  });
});
