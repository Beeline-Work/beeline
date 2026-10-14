/**
 * `@agent /login`: an agent's harness login run from a Room, the way Claude
 * Code's own `/login` works. The owner sends `@agent /login`; a card at that
 * call site carries what the agent's machine produced for its harness (a
 * link, a device code, or a key field); the machine finishes the login and
 * writes it where the harness reads it.
 *
 * Every secret (PKCE verifier, device session, pasted code, API key) stays on
 * the machine. A pasted code or key crosses the server only as a relay
 * (phone request -> PostgreSQL NOTIFY -> the helper's live socket); the
 * server stores and logs neither.
 */

/** How long a helper keeps one unfinished sign-in attempt. */
export const AGENT_SIGN_IN_ATTEMPT_TTL_MS = 15 * 60_000;
/** The longest pasted code or key the server relays. */
export const AGENT_SIGN_IN_INPUT_MAX_LENGTH = 1_024;

/** Harnesses `@agent /login` signs in from a Room. */
export const AGENT_SIGN_IN_HARNESSES = [
  'claude',
  'codex',
  'grok',
  'cursor',
  'opencode',
  'pi',
  'goose',
] as const;
export type AgentSignInHarness = (typeof AGENT_SIGN_IN_HARNESSES)[number];

/** API-key providers an agent can be connected with (`beeline connect`). */
export const AGENT_SIGN_IN_KEY_PROVIDERS = [
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'xai',
] as const;
export type AgentSignInKeyProvider = (typeof AGENT_SIGN_IN_KEY_PROVIDERS)[number];

/**
 * The four ways a harness signs in:
 * - `paste-code`: open a link, paste the code it shows back (Claude Code);
 * - `device-code`: open a link, type the card's code there (Codex, Grok);
 * - `approve-wait`: open a link and approve; nothing comes back (Cursor);
 * - `api-key`: paste a provider key (Pi, Goose, OpenCode).
 */
export type AgentSignInKind = 'paste-code' | 'device-code' | 'approve-wait' | 'api-key';

export function isAgentSignInHarness(value: unknown): value is AgentSignInHarness {
  return (AGENT_SIGN_IN_HARNESSES as readonly unknown[]).includes(value);
}

export function isAgentSignInKeyProvider(value: unknown): value is AgentSignInKeyProvider {
  return (AGENT_SIGN_IN_KEY_PROVIDERS as readonly unknown[]).includes(value);
}

/** What the machine answers `start` with. A device code is not a secret. */
export type AgentSignInLink =
  | { readonly kind: 'paste-code'; readonly authorizeUrl: string }
  | {
      readonly kind: 'device-code';
      readonly authorizeUrl: string;
      readonly userCode: string;
      /** Milliseconds since the epoch. */
      readonly expiresAt: number;
    }
  | { readonly kind: 'approve-wait'; readonly authorizeUrl: string }
  | { readonly kind: 'api-key'; readonly provider: AgentSignInKeyProvider };

/** Server -> helper live frame. `code` (a pasted code or key) rides only on `step: 'code'`. */
export type AgentSignInFrame =
  | {
      readonly type: 'agent-sign-in';
      readonly step: 'start';
      readonly attemptId: string;
      /** The Room card this attempt settles; echoed on every report. */
      readonly cardId: string;
    }
  | {
      readonly type: 'agent-sign-in';
      readonly step: 'code';
      readonly attemptId: string;
      readonly code: string;
    };

/** Helper -> server report for one attempt. Never carries a code, key or token. */
export type ReportAgentSignInInput =
  | ({ readonly agentId: string; readonly attemptId: string } & AgentSignInLink)
  | {
      readonly agentId: string;
      readonly attemptId: string;
      readonly cardId?: string;
      readonly outcome: 'signed-in';
    }
  | {
      readonly agentId: string;
      readonly attemptId: string;
      readonly cardId?: string;
      readonly outcome: 'failed';
      readonly error: string;
    };

/**
 * The Room card `@agent /login` writes. The link and device code are shown to
 * the agent's owner only; other members see who it waits for.
 */
export type AgentSignInCardView = {
  readonly agentId: string;
  readonly ownerId: string;
  readonly harness: AgentSignInHarness;
  /** `starting` until the machine answers; `failed` keeps the link for a retry. */
  readonly status: 'starting' | 'pending' | 'signing-in' | 'signed-in' | 'failed';
  readonly kind?: AgentSignInKind;
  readonly authorizeUrl?: string;
  readonly userCode?: string;
  /** Milliseconds since the epoch, for a device code. */
  readonly expiresAt?: number;
  readonly provider?: AgentSignInKeyProvider;
  readonly errorMessage?: string;
};

/** The owner pastes a code or key into the sign-in card `messageId`. */
export type CompleteAgentSignInInput = {
  readonly roomId: string;
  readonly messageId: string;
  readonly code: string;
};
export type CompleteAgentSignInResult = { readonly signedIn: true };

/** What each harness signs in to, as a person reads it. Key harnesses name their provider. */
export const AGENT_SIGN_IN_SERVICE_LABELS: Record<AgentSignInHarness, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  grok: 'Grok',
  cursor: 'Cursor',
  opencode: 'its provider',
  pi: 'its provider',
  goose: 'its provider',
};

export const AGENT_SIGN_IN_PROVIDER_LABELS: Record<AgentSignInKeyProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
};

/** Harnesses that sign in with a provider API key rather than a login page. */
export function agentSignInUsesKey(harness: AgentSignInHarness): boolean {
  return harness === 'opencode' || harness === 'pi' || harness === 'goose';
}
