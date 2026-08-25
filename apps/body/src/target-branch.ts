/**
 * Chat-native target-branch changes: recognizing the ask, and the typed
 * proposal card the agent posts in answer to it.
 *
 * The agent NEVER authors the Room→repository binding — that event is
 * owner-authored and reader-verified (`packages/buzz-client/src/room-repository.ts`).
 * All the daemon does here is recognize "land to staging from now on" and
 * publish a small typed proposal the Room owner confirms in the app; the app
 * then republishes the binding under the OWNER's own key
 * (`setRoomTargetBranch`). That split is the whole security property: an
 * agent-authored config event is refused by the reader's role re-check even if
 * it reaches the relay.
 */
import { normalizeTargetBranchName } from '@beeline/buzz-client';
import type { AcpPermissionRequest } from './acp.js';
import { permissionRequestStrings } from './repository-target.js';

/** `#t` marker of the proposal card the agent publishes into the Room. */
export const TARGET_BRANCH_PROPOSAL_TAG = 'buzz-target-branch-proposal';

/**
 * The exact native command a Room agent attempts to ASK for the proposal card.
 *
 * It is never executed: the host recognizes it in the Room's ACP permission
 * callback, rejects the invocation itself, and publishes the proposal. Same
 * shape as `NAMED_REPOSITORY_PERMISSION_COMMAND` — a prompt-documented marker
 * is the only escape hatch a natural-language phrasing the recognizer below
 * misses can take, and unlike free-form agent text it carries exactly one
 * typed argument this file validates.
 */
export const TARGET_BRANCH_PROPOSAL_COMMAND = 'beeline-propose-target-branch';

/** A standing change ("from now on"), as opposed to one about this change. */
const STANDING_CHANGE =
  /\b(?:from\s+now\s+on|going\s+forward|from\s+here\s+on(?:\s+out)?|in\s+(?:the\s+)?future|by\s+default|from\s+then\s+on|always|permanently)\b/i;

/** The Room's configured landing target, however a person names it. */
const TARGET_BRANCH_PHRASE = /\b(?:target|protected|default|base|landing)\s+branch\b/i;

/** A bare branch token: no whitespace, and never a trailing sentence mark. */
const BRANCH_TOKEN = String.raw`[A-Za-z0-9._\/-]+`;

/**
 * The noun phrase people put between the preposition and the branch name:
 * "land to **a branch called** staging", "land to **the branch** staging".
 *
 * Without this the capture stops on the article and resolves to `a`, which
 * `BRANCH_STOP_WORDS` then correctly refuses — so the whole ask reads as
 * ordinary chat and the agent answers it conversationally. That is the exact
 * live gap this covers.
 */
const BRANCH_LEAD_IN = String.raw`(?:(?:a|an|the|our|its|my|this)\s+)?(?:new\s+)?(?:branch|ref)\s+(?:(?:called|named|titled|labelled|labeled)\s+)?`;

/**
 * Tokens that can sit where a branch name would but never name one — the
 * connectors and standing markers of the phrase itself ("land to from now on").
 */
const BRANCH_STOP_WORDS = new Set([
  'from',
  'now',
  'then',
  'here',
  'future',
  'default',
  'always',
  'going',
  'forward',
  'the',
  'a',
  'an',
  'it',
  'this',
  'that',
  'and',
  'or',
  'to',
  'on',
  'onto',
  'into',
  'off',
  'against',
  'branch',
  'permanently',
  'be',
]);

/** A question about the target branch is a read, never a change request. */
const QUESTION_LEAD =
  /^(?:what|which|where|why|how|who|is|are|was|were|does|do|did|can|could|should|will|would|am|has|have)\b/i;

function normalizeRequest(content: string): string {
  return (
    content
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      // Addressing is authenticated by the signed `p` tag; the text is noise.
      .replace(/^(?:@[\p{L}\p{N}_-]+\s*[,:;]?\s+)+/u, '')
      .replace(
        /^(?:(?:hey|hi|hello|yo|ok|okay|alright|so|now)\b[,:;-]*\s+|(?:please|kindly|just)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|(?:let['’]?s|lets)\s+)+/iu,
        '',
      )
      .trim()
  );
}

function branchFrom(match: RegExpMatchArray | null, group = 1): string | null {
  if (!match) return null;
  const raw = (match[group] ?? '').replace(/^['"`]+|['"`]+$/g, '').replace(/[.,;:!?)\]]+$/g, '');
  return normalizeTargetBranchName(raw);
}

/**
 * The branch a Room message asks this Room to land to *from now on*, or null.
 *
 * Two shapes are recognized, and nothing looser: an explicit "target branch"
 * command ("set the target branch to staging"), or a landing verb carrying an
 * explicit standing-change marker ("land to staging from now on"). A bare
 * "land this to staging" is deliberately NOT a config change — it is about one
 * change — and a question ("what is the target branch?") never is.
 */
export function targetBranchChangeIntent(content: string): { branch: string } | null {
  const text = normalizeRequest(content);
  if (!text || QUESTION_LEAD.test(text)) return null;

  const explicit =
    branchFrom(
      text.match(
        new RegExp(
          String.raw`(?:change|set|switch|point|move|update|repoint|retarget)\s+(?:the\s+|this\s+|our\s+|its\s+)?(?:room(?:['’]s)?\s+)?(?:target|protected|default|base|landing)\s+branch\s+(?:to|at|onto)\s+(?:the\s+)?(?:${BRANCH_LEAD_IN})?(${BRANCH_TOKEN})`,
          'i',
        ),
      ),
    ) ??
    branchFrom(
      text.match(
        new RegExp(
          String.raw`(?:target|protected|default|base|landing)\s+branch\s+(?:should\s+(?:now\s+)?be|is\s+now|becomes|=)\s+(?:the\s+)?(?:${BRANCH_LEAD_IN})?(${BRANCH_TOKEN})`,
          'i',
        ),
      ),
    ) ??
    branchFrom(
      text.match(
        new RegExp(
          String.raw`make\s+(${BRANCH_TOKEN})\s+(?:the\s+|our\s+|this\s+room['’]?s?\s+)?(?:new\s+)?(?:target|protected|default|base|landing)\s+branch`,
          'i',
        ),
      ),
    );
  if (explicit) return { branch: explicit };

  if (!STANDING_CHANGE.test(text)) return null;
  const standing = branchFrom(
    text.match(
      new RegExp(
        String.raw`\b(?:land|landing|merge|merging|ship|shipping|target|targeting|base|basing|branch)\b[^.?!]{0,60}?\b(?:to|on|onto|into|off\s+of|off|against|from)\s+(?:the\s+)?(?:${BRANCH_LEAD_IN})?(${BRANCH_TOKEN})`,
        'i',
      ),
    ),
  );
  // Never let a connector or the standing marker itself be read as the branch
  // ("land to from now on" must not resolve to a branch called `from`).
  if (!standing || BRANCH_STOP_WORDS.has(standing.toLowerCase())) return null;
  return { branch: standing };
}

/** The proposal card's one-line human copy. Never free-form agent text. */
export function targetBranchProposalText(from: string, to: string): string {
  return `Change target branch: ${from} → ${to}`;
}

/** Short branch name for display/comparison, e.g. `refs/heads/main` → `main`. */
export function shortBranchName(ref: string | undefined): string {
  return (ref ?? 'main').replace(/^refs\/heads\//, '');
}

/**
 * The branch a Room agent's own native-command marker asks to repoint to.
 *
 * `beeline-propose-target-branch --branch staging`. This is the agent's ONLY
 * way to raise the proposal card, and it raises nothing else: the command is
 * never executed, the value is validated as a git branch name here, and the
 * card it produces still has to be confirmed by a Room admin whose own key
 * signs the binding. Anything unparseable returns undefined, so an
 * unrecognized invocation falls through to the ordinary read-only denial.
 */
export function targetBranchProposalFromPermission(
  permission: AcpPermissionRequest,
): string | undefined {
  const candidates = [
    permission.toolCall?.title,
    ...permissionRequestStrings(permission.toolCall?.rawInput),
  ].filter((value): value is string => typeof value === 'string');
  const marker = new RegExp(
    // The branch name ends the command: nothing may follow it but closing
    // quotes/parens from a harness's own wrapper. A chained shell payload
    // (`--branch staging && rm -rf /`) is therefore not this marker at all and
    // gets the ordinary read-only denial, exactly like any other command.
    String.raw`(?:^|\s)${TARGET_BRANCH_PROPOSAL_COMMAND}\s+--branch(?:=|\s+)(['"\x60]?)([A-Za-z0-9._\/-]+)\1['"\x60)\s]*$`,
  );
  for (const candidate of candidates) {
    const branch = normalizeTargetBranchName(candidate.match(marker)?.[2]);
    if (branch) return branch;
  }
  return undefined;
}
