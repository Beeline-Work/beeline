import { describe, expect, it } from 'vitest';
import {
  CONTROL_KINDS,
  eventKindCatalogLines,
  formatSystemLine,
  isAgentKind,
  isControlKind,
  isPerItemEventKind,
  isResumeKind,
  isServerEventKind,
  isSubscribableEventKind,
  isSystemEvent,
  isSystemEventKind,
  joinSystemNames,
  MAX_EVENT_DEPTH,
  MAX_MENTIONS_PER_EVENT,
  MAX_TURNS_PER_ROOT,
  perItemSubscriptionRefusal,
  PER_ITEM_EVENT_KINDS,
  RESUME_KINDS,
  SERVER_EVENT_KIND_DETAIL,
  SERVER_EVENT_KINDS,
  SUBSCRIBABLE_EVENT_KINDS,
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
    expect(
      isSystemEvent({ subject: { kind: 'agent', name: 'Bee' }, verb: 'could not answer' }),
    ).toBe(true);
    expect(isSystemEvent({ subject: { kind: 'robot', name: 'Bee' }, verb: 'x' })).toBe(false);
    expect(isSystemEvent({ subject: { kind: 'agent', name: 'Bee' }, verb: 'x', object: 'y' })).toBe(
      false,
    );
    expect(isSystemEvent(null)).toBe(false);
    const check = {
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'started a check',
      object: { text: 'Mobile', headSha: 'a'.repeat(40) },
    };
    expect(isSystemEvent(check)).toBe(true);
    expect(
      isSystemEvent({ ...check, object: { ...check.object, headSha: 'not-a-commit' } }),
    ).toBe(false);
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
      'squire-approval-decided',
      'connector-offer-decided',
      'turn-cancelled',
      'choice-answered',
      'choice-skipped',
      'poll-closed',
      'workflow-handoff',
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

  it('keeps grant, Squire approval, and connector-offer decisions on the resume path, never on the trigger path', () => {
    expect([...RESUME_KINDS]).toEqual([
      'grant-decided',
      'squire-approval-decided',
      'connector-offer-decided',
    ]);
    expect(isResumeKind('grant-decided')).toBe(true);
    expect(isResumeKind('squire-approval-decided')).toBe(true);
    expect(isResumeKind('connector-offer-decided')).toBe(true);
    expect(isResumeKind('joined')).toBe(false);
    expect(isResumeKind('choice-answered')).toBe(false);
    expect(isResumeKind('poll-closed')).toBe(false);
  });

  it('gives every kind one detail line, so a model-facing catalog can never drift from the kinds the server fires', () => {
    for (const kind of SERVER_EVENT_KINDS) {
      expect(SERVER_EVENT_KIND_DETAIL[kind]).toBeTruthy();
    }
    // The default catalog is what `subscribe_events` advertises: Room-level
    // kinds only. A per-item kind still gets a detail line (it is still a
    // real, documented kind an agent reads about elsewhere), but it is never
    // in the list a subscriber is offered.
    const lines = eventKindCatalogLines();
    expect(lines).toHaveLength(SUBSCRIBABLE_EVENT_KINDS.length);
    for (const kind of SUBSCRIBABLE_EVENT_KINDS) {
      expect(lines.some((line) => line.startsWith(`${kind} `))).toBe(true);
    }
    for (const kind of PER_ITEM_EVENT_KINDS) {
      expect(lines.some((line) => line.startsWith(`${kind} `))).toBe(false);
    }
    expect(eventKindCatalogLines(['joined'])).toEqual([
      `joined ${SERVER_EVENT_KIND_DETAIL.joined}`,
    ]);
    expect(eventKindCatalogLines(['grant-decided'])).toEqual([
      `grant-decided ${SERVER_EVENT_KIND_DETAIL['grant-decided']}`,
    ]);
  });

  it('keeps per-item kinds off the subscribable list, since their owner is already woken directly', () => {
    expect([...PER_ITEM_EVENT_KINDS]).toEqual([
      'grant-decided',
      'squire-approval-decided',
      'connector-offer-decided',
      'turn-cancelled',
      'choice-answered',
      'choice-skipped',
      'poll-closed',
    ]);
    for (const kind of PER_ITEM_EVENT_KINDS) {
      expect(isPerItemEventKind(kind)).toBe(true);
      expect(isSubscribableEventKind(kind)).toBe(false);
    }
    expect([...SUBSCRIBABLE_EVENT_KINDS]).toEqual([
      'joined',
      'schedule-ran',
      'corner-opened',
      'check-passed',
      'check-failed',
      'merged',
      'workflow-handoff',
    ]);
    for (const kind of SUBSCRIBABLE_EVENT_KINDS) {
      expect(isPerItemEventKind(kind)).toBe(false);
      expect(isSubscribableEventKind(kind)).toBe(true);
    }
    // Every server kind lands in exactly one of the two buckets.
    expect(SUBSCRIBABLE_EVENT_KINDS.length + PER_ITEM_EVENT_KINDS.length).toBe(
      SERVER_EVENT_KINDS.length,
    );
    expect(isPerItemEventKind('nonsense')).toBe(false);
    expect(isSubscribableEventKind('nonsense')).toBe(false);
    expect(perItemSubscriptionRefusal('grant-decided')).toContain(
      "grant-decided wakes its own item's owner automatically",
    );
  });

  it('keeps a stop on the control path, so it can never start the turn it ends', () => {
    expect([...CONTROL_KINDS]).toEqual(['turn-cancelled']);
    expect(isControlKind('turn-cancelled')).toBe(true);
    expect(isControlKind('grant-decided')).toBe(false);
    expect(isControlKind('joined')).toBe(false);
    // It is still a SERVER kind: the server authored it, so a helper acts on
    // it without re-checking whose name is on the row.
    expect(isServerEventKind('turn-cancelled')).toBe(true);
    // The two paths are disjoint. A kind on both would be read twice.
    expect(RESUME_KINDS.some((kind) => CONTROL_KINDS.includes(kind))).toBe(false);
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
