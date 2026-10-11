import { describe, expect, it } from 'vitest';
import { assembleTurnPrompt, type TurnPromptContext } from './prompt-assembly.js';
import { PromptSectionBaseline } from './prompt-section-baseline.js';

const turn = (memory: string): TurnPromptContext => ({
  surface: 'room',
  members: 'Members:\n- @bee — Bee (agent)',
  memory,
  task: { body: 'Same task' },
});
const report = (memory: string) => assembleTurnPrompt(turn(memory)).report;

describe('prompt section change on warm turns', () => {
  it('reports no-baseline on the first prompt a session sees', () => {
    const changes = new PromptSectionBaseline().observe('session-1', report('Memory: alpha'));
    expect(Object.values(changes).length).toBeGreaterThan(0);
    expect(new Set(Object.values(changes))).toEqual(new Set(['no-baseline']));
  });

  it('reports changed for equal-length different text, and unchanged for identical text', () => {
    const baseline = new PromptSectionBaseline();
    const first = report('Memory: alpha');
    const second = report('Memory: omega');
    expect(first.find((section) => section.id === 'turn.memory')!.bytes).toBe(
      second.find((section) => section.id === 'turn.memory')!.bytes,
    );
    baseline.observe('session-1', first);
    const changes = baseline.observe('session-1', second);
    expect(changes['turn.memory']).toBe('changed');
    expect(changes['turn.members']).toBe('unchanged');
    expect(changes['turn.task']).toBe('unchanged');
  });

  it('reports no-baseline after a cold activation even when the session id repeats', () => {
    const baseline = new PromptSectionBaseline();
    baseline.observe('session-1', report('Memory: alpha'));
    baseline.reset();
    expect(baseline.observe('session-1', report('Memory: alpha'))['turn.memory']).toBe('no-baseline');
  });

  it('reports no-baseline when the session is replaced', () => {
    const baseline = new PromptSectionBaseline();
    baseline.observe('session-1', report('Memory: alpha'));
    expect(baseline.observe('session-2', report('Memory: alpha'))['turn.memory']).toBe('no-baseline');
  });

  it('reports no-baseline for a section the previous prompt did not have', () => {
    const baseline = new PromptSectionBaseline();
    baseline.observe('session-1', assembleTurnPrompt({ surface: 'room', task: { body: 'Same task' } }).report);
    expect(baseline.observe('session-1', report('Memory: alpha'))['turn.memory']).toBe('no-baseline');
  });

  it('keeps Rooms and sessions apart: identical text in another Room or session has no baseline', () => {
    const roomA = new PromptSectionBaseline();
    const roomB = new PromptSectionBaseline();
    roomA.observe('session-1', report('Memory: alpha'));
    expect(roomB.observe('session-1', report('Memory: alpha'))['turn.memory']).toBe('no-baseline');
    expect(roomA.observe('session-2', report('Memory: alpha'))['turn.memory']).toBe('no-baseline');
  });

  it('holds hashes only, never the section text', () => {
    const baseline = new PromptSectionBaseline();
    baseline.observe('session-1', report('Memory: a secret-looking note'));
    expect(JSON.stringify([...(baseline as unknown as { hashes: Map<string, string> }).hashes])).not.toContain(
      'secret-looking',
    );
  });
});
