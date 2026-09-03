/**
 * One grammar for every system notification the server phrases.
 *
 * A system line is `<subject> <verb>[ <object>][ · <consequence>]`: the subject
 * is a name (a person, an agent, "GitHub", or the scheduler), the verb is past
 * tense and plain, the object is the thing, and the consequence is one short
 * clause. No colons, no em dashes, no trailing period, no URL in the text — a
 * URL rides on the object so the phone can link it. The server stores the text
 * beside this structured event (`messages.system_event`) so the phone can
 * render names as mentions and fold runs ("Candy, Terra and Codex joined").
 */
export type SystemSubjectKind = 'person' | 'agent' | 'github' | 'system';

export type SystemSubject = {
  readonly kind: SystemSubjectKind;
  /** The identity id when the subject is a Room identity; tappable on the phone. */
  readonly id?: string;
  readonly name: string;
};

export type SystemObject = {
  readonly text: string;
  /** An identity id when the object is a person or agent; tappable on the phone. */
  readonly id?: string;
  /** Where the object lives (a pull request, a check run); the phone links it. */
  readonly url?: string;
};

export type SystemEvent = {
  readonly subject: SystemSubject;
  readonly verb: string;
  readonly object?: SystemObject;
  readonly consequence?: string;
};

export const SYSTEM_LINE_SEPARATOR = ' · ';

/** "Candy" · "Candy and Terra" · "Candy, Terra and Codex". */
export function joinSystemNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The stored text for one event, or for a fold of several subjects sharing one verb. */
export function formatSystemLine(
  event: Omit<SystemEvent, 'subject'> & {
    readonly subject: SystemSubject | readonly SystemSubject[];
  },
): string {
  const subjects = Array.isArray(event.subject)
    ? (event.subject as readonly SystemSubject[])
    : [event.subject as SystemSubject];
  const head = [joinSystemNames(subjects.map((subject) => subject.name)), event.verb.trim()]
    .filter(Boolean)
    .join(' ');
  const line = event.object?.text ? `${head} ${event.object.text}` : head;
  return event.consequence ? `${line}${SYSTEM_LINE_SEPARATOR}${event.consequence}` : line;
}

export function isSystemEvent(value: unknown): value is SystemEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const subject = event.subject as Record<string, unknown> | undefined;
  const object = event.object as Record<string, unknown> | undefined;
  return Boolean(
    subject &&
      typeof subject === 'object' &&
      (subject.kind === 'person' ||
        subject.kind === 'agent' ||
        subject.kind === 'github' ||
        subject.kind === 'system') &&
      (subject.id === undefined || typeof subject.id === 'string') &&
      typeof subject.name === 'string' &&
      typeof event.verb === 'string' &&
      (object === undefined ||
        (object &&
          typeof object === 'object' &&
          typeof object.text === 'string' &&
          (object.id === undefined || typeof object.id === 'string') &&
          (object.url === undefined || typeof object.url === 'string'))) &&
      (event.consequence === undefined || typeof event.consequence === 'string'),
  );
}
