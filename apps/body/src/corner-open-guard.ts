/**
 * Refuse a second corner for work a live corner is already doing.
 *
 * Observed live: the captain sent "@Beebee Open corner - feel free to open all
 * three at once", the daemon opened a corner for it, and fifty seconds later a
 * bare "@beebee open corner" opened a SECOND corner against the same Room. The
 * daemon did exactly what each message said, so nothing looked wrong from the
 * inside — but the second corner carried no task at all (its kind:9007 create
 * event has no `task` tag, because `taskDescriptionFromCornerRequest` correctly
 * distils nothing from a bare imperative), re-derived its objective from the
 * Room preamble, and re-did the first corner's work on a second branch.
 *
 * Two shapes are duplicates, and they need different tests:
 *
 *  - The same task said twice. Compared on the *distilled* task, not the raw
 *    message, so "open a corner and fix the offline banner" and "@beebee please
 *    open a corner to fix the offline banner" are one ask.
 *  - A bare "open a corner" arriving while one is still live. There is no task
 *    to compare, and that is exactly the problem: the corner it would open has
 *    no objective of its own, so the only work it can do is guess at the work
 *    already running next to it.
 *
 * A bare open-a-corner long after the last one is a legitimate fresh start, and
 * genuinely different tasks are legitimately concurrent — the captain asked for
 * three at once and got them. So neither test is a cap on corners per Room;
 * both are bounded by a window and by what is still live.
 */

/** How long a live corner makes a bare "open a corner" read as a repeat. */
export const CORNER_OPEN_DUPLICATE_WINDOW_MS = 15 * 60_000;

export interface OpenCornerCandidate {
  subchannelId: string;
  /** Display name of the corner, for the refusal to name something findable. */
  name: string;
  /** The distilled objective this corner was opened with; '' when it had none. */
  taskDescription: string;
  /** When the corner was opened, in ms. */
  openedAt: number;
}

/** Compare on meaning, not punctuation or case. */
function normalizeTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

/**
 * The live corner a new open-a-corner request would duplicate, if any.
 *
 * `corners` must already be filtered to corners of this Room that are still
 * open — an archived corner is not something a new request can be folded into.
 */
export function duplicateCornerOpen(input: {
  taskDescription: string;
  now: number;
  corners: readonly OpenCornerCandidate[];
  windowMs?: number;
}): OpenCornerCandidate | undefined {
  const windowMs = input.windowMs ?? CORNER_OPEN_DUPLICATE_WINDOW_MS;
  const task = normalizeTask(input.taskDescription);
  if (task) {
    // An identical objective is a duplicate however long ago it was said: the
    // corner doing that exact work is still open.
    return input.corners.find((corner) => normalizeTask(corner.taskDescription) === task);
  }
  // No objective of its own: only a corner opened recently enough that the
  // person is plausibly still talking about it makes this a repeat.
  return input.corners.find((corner) => input.now - corner.openedAt <= windowMs);
}

/**
 * What the Room is told instead of getting a second corner. Names the corner
 * that already exists and says exactly how to get a genuinely new one, so the
 * refusal is a next step rather than a wall.
 */
export function duplicateCornerOpenRefusal(existing: OpenCornerCandidate): string {
  const objective = existing.taskDescription.trim();
  return (
    `I already have a corner open for this — **${existing.name}**` +
    (objective ? `, working on: ${objective}` : '') +
    '. Rather than open a second one alongside it and split the work, say what you want done ' +
    'and I will take it there. If you do want a separate corner, name the different task ' +
    '("open a corner to …") and I will open one for that.'
  );
}
