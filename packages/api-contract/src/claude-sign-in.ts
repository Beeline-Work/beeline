/**
 * Sign in to Claude from the app: the agent's owner starts Claude's OAuth
 * login on the agent's own machine and pastes the returned code back.
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

export type StartClaudeSignInInput = { readonly workspaceId: string; readonly agentId: string };
export type StartClaudeSignInResult = {
  readonly attemptId: string;
  readonly authorizeUrl: string;
};
export type CompleteClaudeSignInInput = StartClaudeSignInInput & {
  readonly attemptId: string;
  readonly code: string;
};
export type CompleteClaudeSignInResult = { readonly signedIn: true };
