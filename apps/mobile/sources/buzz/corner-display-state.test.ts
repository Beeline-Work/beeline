import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  CornerLifecycleView,
  CornerState,
  CornerStateReason,
} from '@beeline/api-contract/phone';
import {
  cornerDisplayState,
  cornerHeaderStateLabel,
  cornerDisplayItems,
} from './corner-display-state';

const lifecycle = (overrides: Partial<CornerLifecycleView> = {}): CornerLifecycleView => ({
  lifecycle: 'unknown',
  checks: 'unknown',
  ...overrides,
});

function item(state: CornerState, reason?: CornerStateReason) {
  return { state, ...(reason ? { reason } : {}), lifecycle: lifecycle() };
}

describe('server-owned corner display state', () => {
  it.each([
    ['working', 'quiet', '◌'],
    ['waiting', 'brass', '○'],
    ['review', 'quiet', '●'],
    ['archived', 'ghost', '○'],
  ] as const)('renders %s without deriving a replacement state', (state, tone, glyph) => {
    expect(cornerDisplayState(item(state))).toMatchObject({
      status: state,
      word: state,
      tone,
      glyph,
      terminal: state === 'archived',
    });
  });

  it('keeps the two failure explanations in the header only', () => {
    expect(cornerHeaderStateLabel(cornerDisplayState(item('waiting', 'failed')))).toBe(
      'waiting · failed',
    );
    expect(cornerHeaderStateLabel(cornerDisplayState(item('review', 'checks-failed')))).toBe(
      'review · checks failed',
    );
    expect(cornerDisplayState(item('waiting', 'question')).word).toBe('waiting');
  });

  it('uses lifecycle only for PR/check narration', () => {
    const display = cornerDisplayState({
      state: 'waiting',
      lifecycle: lifecycle({
        lifecycle: 'in-review',
        checks: 'failing',
        pr: {
          number: 1169,
          url: 'https://github.com/Beeline-Work/beeline/pull/1169',
          title: 'One state',
          targetBranch: 'main',
          headSha: 'abc',
        },
      }),
    });
    expect(display.status).toBe('waiting');
    expect(display.detail).toContain('PR #1169');
  });

  it('keeps all four server-owned states available to Room rows', () => {
    expect(
      cornerDisplayItems([item('working'), item('waiting'), item('review'), item('archived')]).map(
        (entry) => entry.display.status,
      ),
    ).toEqual(['working', 'waiting', 'review', 'archived']);
  });

  it('contains no client-side daemon-state resolver', () => {
    const source = readFileSync(new URL('./corner-display-state.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/machineState|machineReason|currentCornerStatus|mergedAt|outcome/);
    expect(source).toContain('const { state } = item;');
  });
});
