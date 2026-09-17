import { describe, expect, it } from 'vitest';
import type { TurnActivityAction } from './activity-timeline';
import {
  formatToolCallDuration,
  middleTruncate,
  toolCallLabel,
  toolCallOutput,
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

describe('toolCallLabel', () => {
  it('a shell call is the command itself — the glyph carries the family', () => {
    expect(toolCallLabel(step({ id: 'a', toolKind: 'execute', command: 'npm test', title: 'Bash' }))).toBe(
      'npm test',
    );
  });

  it('keeps only the subcommand for git', () => {
    expect(
      toolCallLabel(step({ id: 'g', toolKind: 'execute', command: 'git status --short', title: 'Bash' })),
    ).toBe('status --short');
  });

  it('prefers the command over the harness title, which describes another call', () => {
    expect(
      toolCallLabel(
        step({ id: 'l', toolKind: 'execute', command: 'ls -la sources', title: 'Reviewed the current changes' }),
      ),
    ).toBe('ls -la sources');
  });

  it('names a read by its basename', () => {
    expect(
      toolCallLabel(step({ id: 'r', toolKind: 'read', title: 'Read', files: [{ path: 'apps/mobile/Ledger.tsx' }] })),
    ).toBe('Ledger.tsx');
  });

  it('names a write by its basename', () => {
    expect(
      toolCallLabel(
        step({ id: 'w', toolKind: 'edit', title: 'Edit files', files: [{ path: 'sources/buzz/tool-call-row.ts' }] }),
      ),
    ).toBe('tool-call-row.ts');
  });

  it('carries the search pattern and the tool’s own hit count', () => {
    expect(
      toolCallLabel(
        step({
          id: 's',
          toolKind: 'search',
          title: 'Grep',
          input: '{"pattern":"toolCallRow","path":"sources"}',
          output: '12 matches across 3 files',
        }),
      ),
    ).toBe('toolCallRow · 12 hits');
  });

  it('leads an MCP call with the tool’s own short name — a verb that IS information stays', () => {
    expect(toolCallLabel(step({ id: 'm', toolKind: 'other', title: 'mcp__squire__list_credentials' }))).toBe(
      'list_credentials squire',
    );
  });

  it('reads an older transcript’s folded rollup row as the calls it counts', () => {
    expect(toolCallLabel(step({ id: 'sum', toolKind: 'read', title: 'reading 8' }))).toBe('8 calls');
  });

  it('truncates in the middle at the label cap — the tail flags carry the meaning', () => {
    const label = toolCallLabel(
      step({
        id: 't',
        toolKind: 'execute',
        command: 'npm run test --workspace apps/mobile -- --coverage --reporter=json',
        title: 'Bash',
      }),
    );
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toContain('…');
    expect(label).toContain('--reporter=json');
  });
});
