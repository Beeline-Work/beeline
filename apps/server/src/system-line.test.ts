import { describe, expect, it } from 'vitest';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { composeSystemLine } from './system-line.js';

describe('composeSystemLine', () => {
  it('phrases subject verb object · consequence and returns the structured event', () => {
    expect(
      composeSystemLine({
        subject: { kind: 'person', id: 'owner', name: 'Owner' },
        verb: 'turned yolo on for',
        object: { text: 'Bee', id: 'bee' },
        consequence: 'grant requests are now approved automatically',
      }),
    ).toEqual({
      text: 'Owner turned yolo on for Bee · grant requests are now approved automatically',
      event: {
        subject: { kind: 'person', id: 'owner', name: 'Owner' },
        verb: 'turned yolo on for',
        object: { text: 'Bee', id: 'bee' },
        consequence: 'grant requests are now approved automatically',
      },
    });
  });

  it('keeps a URL out of the text and on the object', () => {
    const line = composeSystemLine({
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      object: { text: 'Beeline CI', url: 'https://github.com/acme/w/runs/1' },
    });
    expect(line.text).toBe('GitHub passed a check Beeline CI');
    expect(line.event.object).toEqual({ text: 'Beeline CI', url: 'https://github.com/acme/w/runs/1' });
  });

  it('collapses whitespace and drops an empty object or consequence', () => {
    expect(
      composeSystemLine({
        subject: { kind: 'agent', id: 'bee', name: ' Bee ' },
        verb: 'could not answer',
        object: '  ',
        consequence: 'provider  error\n429',
      }),
    ).toEqual({
      text: 'Bee could not answer · provider error 429',
      event: {
        subject: { kind: 'agent', id: 'bee', name: 'Bee' },
        verb: 'could not answer',
        consequence: 'provider error 429',
      },
    });
  });

  it('composes the grant decision the daemon parses structurally', () => {
    const line = composeSystemLine({
      subject: { kind: 'person', id: 'charles', name: 'Charles Bee' },
      verb: 'approved once',
      object: 'command fly deploy -a beeline-preview --with FLY_TOKEN',
    });
    expect(parseGrantDecisionLine(line.text)).toEqual({
      deciderName: 'Charles Bee',
      decision: 'once',
      kind: 'command',
      target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
    });
  });
});
