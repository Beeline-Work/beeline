import { describe, expect, it } from 'vitest';
import {
  formatSystemLine,
  isAgentKind,
  isResumeKind,
  isServerEventKind,
  isSystemEvent,
  isSystemEventKind,
  joinSystemNames,
  MAX_EVENT_DEPTH,
  MAX_MENTIONS_PER_EVENT,
  MAX_TURNS_PER_ROOT,
  RESUME_KINDS,
  SERVER_EVENT_KINDS,
} from './system-events.js';

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

describe('the event kinds beside the prose', () => {
  it('names the server kinds a subscriber may ask for', () => {
    expect([...SERVER_EVENT_KINDS]).toEqual([
      'joined',
      'schedule-ran',
      'corner-opened',
      'check-passed',
      'check-failed',
      'merged',
      'grant-decided',
    ]);
    expect(isServerEventKind('joined')).toBe(true);
    expect(isServerEventKind('agent:handoff')).toBe(false);
    expect(isServerEventKind('nonsense')).toBe(false);
  });

  it('admits an agent kind only as a bounded lowercase slug', () => {
    expect(isAgentKind('agent:handoff')).toBe(true);
    expect(isAgentKind('agent:build-done')).toBe(true);
    expect(isAgentKind('agent:')).toBe(false);
    expect(isAgentKind('agent:Handoff')).toBe(false);
    expect(isAgentKind('agent:has space')).toBe(false);
    expect(isAgentKind('agent:has_underscore')).toBe(false);
    expect(isAgentKind(`agent:${'x'.repeat(41)}`)).toBe(false);
    expect(isAgentKind(`agent:${'x'.repeat(40)}`)).toBe(true);
    expect(isAgentKind('handoff')).toBe(false);
    expect(isAgentKind(undefined)).toBe(false);
    expect(isSystemEventKind('agent:handoff')).toBe(true);
    expect(isSystemEventKind('joined')).toBe(true);
    expect(isSystemEventKind('agent:BAD')).toBe(false);
  });

  it('keeps grant decisions on the resume path, never on the trigger path', () => {
    expect([...RESUME_KINDS]).toEqual(['grant-decided']);
    expect(isResumeKind('grant-decided')).toBe(true);
    expect(isResumeKind('joined')).toBe(false);
  });

  it('owns the cascade bounds both the server and the helper read', () => {
    expect(MAX_EVENT_DEPTH).toBe(4);
    expect(MAX_TURNS_PER_ROOT).toBe(12);
    expect(MAX_MENTIONS_PER_EVENT).toBe(3);
  });

  it('carries the kind on the wire and rejects one that is not a kind', () => {
    const event = { subject: { kind: 'person', name: 'Ada' }, verb: 'joined', kind: 'joined' };
    expect(isSystemEvent(event)).toBe(true);
    expect(isSystemEvent({ ...event, kind: 'not-a-kind' })).toBe(false);
    // The kind is machine-only: it never reaches the sentence a person reads.
    expect(formatSystemLine(event)).toBe('Ada joined');
  });
});
