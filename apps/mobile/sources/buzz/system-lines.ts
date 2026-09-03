import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';

/**
 * System lines on the phone: one grammar, one renderer, folded runs.
 *
 * The server phrases every system notification (`apps/server/src/system-line.ts`)
 * as `<subject> <verb>[ <object>][ · <consequence>]` and stores the structured
 * event beside the text. The phone renders the event (names in brass, the
 * object linked by its URL) and folds consecutive lines that share a verb,
 * object and consequence into one: "Candy, Terra and Codex joined". A row from
 * before the grammar has no event and renders its text verbatim.
 */
export type SystemLineMessage = {
  id: string;
  text: string;
  timestamp: number;
  isSystemNotice?: boolean;
  systemEvent?: SystemEvent;
  /** Every subject of a folded run, oldest first; absent on a single line. */
  systemSubjects?: SystemSubject[];
  /** The ids of every row folded into this one, oldest first. */
  foldedIds?: string[];
};

/** "Candy" · "Candy and Terra" · "Candy, Terra and Codex". */
export function joinSystemNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function systemLineSubjects(message: {
  systemEvent?: SystemEvent;
  systemSubjects?: SystemSubject[];
}): SystemSubject[] {
  return message.systemSubjects ?? (message.systemEvent ? [message.systemEvent.subject] : []);
}

/** The plain text of an event for one or several subjects (previews, accessibility). */
export function systemLineText(event: SystemEvent, subjects?: readonly SystemSubject[]): string {
  const names = (subjects ?? [event.subject]).map((subject) => subject.name);
  const head = [joinSystemNames(names), event.verb].filter(Boolean).join(' ');
  const line = event.object?.text ? `${head} ${event.object.text}` : head;
  return event.consequence ? `${line} · ${event.consequence}` : line;
}

function foldKey(event: SystemEvent): string {
  return JSON.stringify([
    event.verb,
    event.object?.text ?? '',
    event.object?.id ?? '',
    event.object?.url ?? '',
    event.consequence ?? '',
  ]);
}

function subjectKey(subject: SystemSubject): string {
  return subject.id ?? `${subject.kind}:${subject.name}`;
}

/**
 * Fold adjacent system lines sharing one verb (and object and consequence)
 * into the first of the run. `messages` is in transcript order (oldest first);
 * the folded row keeps the first row's id (a stable key for the list and the
 * reveal ledger) and takes the newest row's stamp.
 */
export function foldSystemLines<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const folded: T[] = [];
  let run: { index: number; key: string; subjects: SystemSubject[]; ids: string[] } | null = null;
  for (const message of messages) {
    const event = message.isSystemNotice ? message.systemEvent : undefined;
    if (!event) {
      run = null;
      folded.push(message);
      continue;
    }
    const key = foldKey(event);
    if (run && run.key === key) {
      const seen = new Set(run.subjects.map(subjectKey));
      if (!seen.has(subjectKey(event.subject))) run.subjects.push(event.subject);
      run.ids.push(message.id);
      const anchor = folded[run.index]!;
      folded[run.index] = {
        ...anchor,
        timestamp: message.timestamp,
        text: systemLineText(event, run.subjects),
        systemSubjects: [...run.subjects],
        foldedIds: [...run.ids],
      };
      continue;
    }
    run = { index: folded.length, key, subjects: [event.subject], ids: [message.id] };
    folded.push(message);
  }
  return folded;
}
