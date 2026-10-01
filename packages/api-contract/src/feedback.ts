/**
 * The Beeline feedback loop's shared vocabulary: what an agent may report and
 * the limits every writer enforces. The server (`apps/server/src/feedback.ts`)
 * is the only store; the agent tool (`report_feedback`) and the phone's report
 * action are its two intake paths, and `notify_feedback_fixed` is the one
 * write that closes it.
 */

/** The five agent categories, one per question an agent asks of its own turn. */
export const FEEDBACK_AGENT_CATEGORIES = [
  'simpler_path',
  'contradiction',
  'tooling_gap',
  'context_gap',
  'bug',
] as const;

export const FEEDBACK_SUMMARY_MAX_BYTES = 500;
export const FEEDBACK_DETAIL_MAX_BYTES = 4_000;
export const FEEDBACK_ERROR_EXCERPT_MAX_BYTES = 1_000;
export const FEEDBACK_TOOL_NAME_MAX_LENGTH = 120;
export const FEEDBACK_PROMPT_SECTION_IDS_MAX = 64;
/** Agent items per agent per UTC day. Human items are not capped this way. */
export const FEEDBACK_AGENT_DAILY_CAP = 10;
/** The trigger plus this many preceding message ids ride a human report. */
export const FEEDBACK_PRECEDING_MESSAGES = 20;
/** One Fixed DM title: a single line this long at most. */
export const FEEDBACK_FIXED_TITLE_MAX_LENGTH = 120;
/** Items one `notify_feedback_fixed` call may resolve. */
export const FEEDBACK_FIXED_ITEMS_MAX = 50;
/** Where fix pull requests land; a Fixed DM links only to a pull request here. */
export const FEEDBACK_DEFAULT_REPOSITORY = 'Beeline-Work/beeline';

export type ReportFeedbackInput = {
  readonly roomId: string;
  readonly category: string;
  readonly summary: string;
  readonly detail?: string;
  readonly toolName?: string;
  readonly errorExcerpt?: string;
  /** The turn's assembled prompt sections, attached by the Body, never the agent. */
  readonly promptSectionIds?: readonly string[];
};
export type ReportFeedbackResult = {
  readonly itemId: string;
  /** True when an equivalent report from this agent already existed. */
  readonly duplicate: boolean;
};

/** A merged pull request fixed these items (`notify_feedback_fixed`). */
export type NotifyFeedbackFixedInput = {
  readonly roomId: string;
  readonly itemIds: readonly string[];
  readonly title: string;
  readonly prUrl: string;
};
export type NotifyFeedbackFixedResult = {
  /** Items this call moved to resolved; already-resolved items count zero. */
  readonly resolved: number;
  /** People System DMed by this call. */
  readonly notified: number;
};
