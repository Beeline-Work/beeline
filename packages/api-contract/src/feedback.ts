/**
 * The Beeline feedback loop's shared vocabulary: what an agent or a person
 * may report, the states an item moves through, and the limits every writer
 * and the triage sweep enforce. The server (`apps/server/src/feedback.ts`) is
 * the only store; the agent tool (`report_feedback`) and the phone's report
 * action are its two intake paths.
 */

/** The five agent categories, one per question an agent asks of its own turn. */
export const FEEDBACK_AGENT_CATEGORIES = [
  'simpler_path',
  'contradiction',
  'tooling_gap',
  'context_gap',
  'bug',
] as const;
export type FeedbackAgentCategory = (typeof FEEDBACK_AGENT_CATEGORIES)[number];
export type FeedbackCategory = FeedbackAgentCategory | 'human_report';
export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = [
  ...FEEDBACK_AGENT_CATEGORIES,
  'human_report',
];

export const FEEDBACK_STATUSES = [
  'new',
  'filed',
  'attached',
  'dismissed',
  'resolved',
  'closed',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_SUMMARY_MAX_BYTES = 500;
export const FEEDBACK_DETAIL_MAX_BYTES = 4_000;
export const FEEDBACK_ERROR_EXCERPT_MAX_BYTES = 1_000;
export const FEEDBACK_TOOL_NAME_MAX_LENGTH = 120;
export const FEEDBACK_PROMPT_SECTION_IDS_MAX = 64;
/** Agent items per agent per UTC day. Human items are not capped this way. */
export const FEEDBACK_AGENT_DAILY_CAP = 10;
/** The trigger plus this many preceding message ids ride a human report. */
export const FEEDBACK_PRECEDING_MESSAGES = 20;
export const FEEDBACK_TRIAGE_REASON_MAX_LENGTH = 500;

export const FEEDBACK_ISSUE_TITLE_MAX_LENGTH = 120;
export const FEEDBACK_ISSUE_BODY_MAX_LENGTH = 4_000;
/** A verbatim run of evidence text this long may never reach a GitHub write. */
export const FEEDBACK_EVIDENCE_RUN_LENGTH = 40;
export const FEEDBACK_ISSUE_LABEL = 'beeline-feedback';
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

export type FeedbackItemSummary = {
  readonly id: string;
  readonly sourceKind: 'agent' | 'human';
  readonly category: FeedbackCategory;
  readonly summary: string;
  readonly status: FeedbackStatus;
  readonly clusterSize: number;
  readonly createdAt: number;
  readonly toolName?: string;
  readonly issueNumber?: number;
};
export type FeedbackEvidenceMessage = {
  readonly id: string;
  readonly authorKind: 'agent' | 'human' | 'unknown';
  readonly text: string;
  readonly createdAt: number;
};
export type FeedbackItemDetail = FeedbackItemSummary & {
  readonly detail?: string;
  readonly errorExcerpt?: string;
  readonly promptSectionIds: readonly string[];
  readonly requestId?: string;
  readonly triggerMessageId?: string;
  readonly triageReason?: string;
  readonly evidence: readonly FeedbackEvidenceMessage[];
};
export type FeedbackIssueSummary = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
};
