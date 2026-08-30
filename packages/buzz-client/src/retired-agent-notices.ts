/**
 * These sentences were once published by the daemon as ordinary agent
 * messages. Nostr events cannot be unpublished, so the server projection and
 * mobile cache must both suppress an event only when its whole trimmed text is
 * one of these retired notices. Keep this as their shared authority: adding a
 * sentence on only one side of the wire would let it reappear after a cache
 * restore or a fresh server read.
 */
export const RETIRED_AGENT_NOTICES: readonly string[] = [
  'I lost my connection to the relay — reconnecting.',
  "I can't reach my model — my host's credentials need a refresh.",
  "My coding backend won't start — the host may need attention.",
  "I can't get to this room's repo — check the repo link or my access.",
  "I've hit a usage limit for now.",
  'Still working on this — my coding backend is taking longer than usual to respond.',
];

const RETIRED = new Set(RETIRED_AGENT_NOTICES);

/**
 * Two more retired shapes carry variable data (a path, a blocked model name)
 * so they cannot join the exact-set list above; each was a real published
 * wall from a bug that has since been fixed at the publish site, but the
 * events themselves cannot be unpublished — so each needs a STRUCTURAL
 * matcher bounded to the exact shape that bug produced, never a broad
 * heuristic that could catch a real answer that happens to mention a path or
 * a model.
 *
 * Attachment delivery failure (a workbench-eviction race, since fixed to
 * publish a safe deterministic copy instead of the raw error): the daemon
 * once published the raw Node fs error verbatim, e.g.
 *   "Attachment unavailable: ENOENT: no such file or directory, realpath
 *   '/proc/2952774/root/home/.../workbench/report.html'"
 * — operator-local process/host detail that must never reach a transcript.
 */
const ATTACHMENT_ENOENT_NOTICE = /^Attachment unavailable:[\s\S]*ENOENT[\s\S]*realpath '\/proc\//;

/**
 * The model-unavailable startup wall (formerly published by
 * `apps/body/src/model-availability.ts`): three lines — a fixed title, a
 * detail line naming the blocked selection, and one of exactly two fixed
 * recovery sentences. The title and detail vary with the blocked model or
 * effort, so the invariant recovery line is the structural anchor.
 */
const MODEL_UNAVAILABLE_TITLE = /^Model(?: validation)? unavailable · /;
const MODEL_UNAVAILABLE_RECOVERY: readonly string[] = [
  'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
  'Restore access to the selected harness and its live catalog, then restart the agent.',
];

function isRetiredStructuralNotice(trimmed: string): boolean {
  if (ATTACHMENT_ENOENT_NOTICE.test(trimmed)) return true;
  if (!MODEL_UNAVAILABLE_TITLE.test(trimmed)) return false;
  return MODEL_UNAVAILABLE_RECOVERY.some((line) => trimmed.endsWith(line));
}

/** Whole-message only: a real response may legitimately quote a notice. */
export function isRetiredAgentNotice(text: string): boolean {
  const trimmed = text.trim();
  return RETIRED.has(trimmed) || isRetiredStructuralNotice(trimmed);
}
