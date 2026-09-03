import { describe, expect, it } from 'vitest';
import { formatSystemLine, isSystemEvent, joinSystemNames } from './system-events.js';

describe('the one system-line grammar', () => {
  it('reads subject verb object · consequence with nothing else', () => {
    expect(formatSystemLine({ subject: { kind: 'person', name: 'Candy' }, verb: 'joined' })).toBe(
      'Candy joined',
    );
    expect(
      formatSystemLine({
        subject: { kind: 'person', name: 'Owner' },
        verb: 'turned yolo on for',
        object: { text: 'Bee', id: 'agent-id' },
        consequence: 'grant requests are now approved automatically',
      }),
    ).toBe('Owner turned yolo on for Bee · grant requests are now approved automatically');
    expect(
      formatSystemLine({
        subject: { kind: 'github', name: 'GitHub' },
        verb: 'merged',
        object: { text: 'Ship the widget', url: 'https://github.com/acme/w/pull/7' },
      }),
    ).toBe('GitHub merged Ship the widget');
  });

  it('folds several subjects sharing one verb into one line', () => {
    expect(joinSystemNames(['Candy'])).toBe('Candy');
    expect(joinSystemNames(['Candy', 'Terra'])).toBe('Candy and Terra');
    expect(
      formatSystemLine({
        subject: [
          { kind: 'person', name: 'Candy' },
          { kind: 'agent', name: 'Terra' },
          { kind: 'agent', name: 'Codex' },
        ],
        verb: 'joined',
      }),
    ).toBe('Candy, Terra and Codex joined');
  });

  it('validates the wire shape', () => {
    expect(isSystemEvent({ subject: { kind: 'agent', name: 'Bee' }, verb: 'could not answer' })).toBe(
      true,
    );
    expect(isSystemEvent({ subject: { kind: 'robot', name: 'Bee' }, verb: 'x' })).toBe(false);
    expect(isSystemEvent({ subject: { kind: 'agent', name: 'Bee' }, verb: 'x', object: 'y' })).toBe(
      false,
    );
    expect(isSystemEvent(null)).toBe(false);
  });
});
