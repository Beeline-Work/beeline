/**
 * Sign in to Claude from a Room, the way Claude Code's own `/login` works:
 * the agent's owner sends `@agent login`, a card at that call site carries
 * the claude.ai link the agent's machine built, and the owner pastes the
 * returned code into the card.
 *
 * The PKCE verifier never leaves the helper. The pasted code crosses the
 * server only as a relay (phone request -> PostgreSQL NOTIFY -> the helper's
 * live socket); the server stores and logs neither.
 */

/** How long a helper keeps one unfinished sign-in attempt. */
export const CLAUDE_SIGN_IN_ATTEMPT_TTL_MS = 10 * 60_000;
/** The longest pasted code the server relays. */
export const CLAUDE_SIGN_IN_CODE_MAX_LENGTH = 1_024;

/** Server -> helper live frame. `code` rides only on `step: 'code'`. */
export type ClaudeSignInFrame =
  | { readonly type: 'claude-sign-in'; readonly step: 'start'; readonly attemptId: string }
  | {
      readonly type: 'claude-sign-in';
      readonly step: 'code';
      readonly attemptId: string;
      readonly code: string;
    };

/** Helper -> server report for one attempt. Never carries a code or token. */
export type ReportClaudeSignInInput =
  | { readonly agentId: string; readonly attemptId: string; readonly authorizeUrl: string }
  | { readonly agentId: string; readonly attemptId: string; readonly outcome: 'signed-in' }
  | {
      readonly agentId: string;
      readonly attemptId: string;
      readonly outcome: 'failed';
      readonly error: string;
    };

/** The Room card `@agent login` writes. Holds the link, never a code or verifier. */
export type ClaudeSignInCardView = {
  readonly agentId: string;
  readonly ownerId: string;
  /** `starting` until the machine answers with a link; `failed` keeps the link for a retry. */
  readonly status: 'starting' | 'pending' | 'signing-in' | 'signed-in' | 'failed';
  readonly authorizeUrl?: string;
  readonly errorMessage?: string;
};

/** The owner pastes Claude's code into the sign-in card `messageId`. */
export type CompleteClaudeSignInInput = {
  readonly roomId: string;
  readonly messageId: string;
  readonly code: string;
};
export type CompleteClaudeSignInResult = { readonly signedIn: true };
