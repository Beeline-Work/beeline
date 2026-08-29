/**
 * Typed target-branch proposal controls.
 *
 * The agent NEVER authors the Room→repository binding — that event is
 * owner-authored and reader-verified (`packages/buzz-client/src/room-repository.ts`).
 * The daemon accepts only a typed permission-channel command (plus the
 * pi-acp text fallback) and publishes a small proposal the Room owner confirms; the app
 * then republishes the binding under the OWNER's own key
 * (`setRoomTargetBranch`). That split is the whole security property: an
 * agent-authored config event is refused by the reader's role re-check even if
 * it reaches the relay.
 */
import { matchSlashCommand, normalizeTargetBranchName } from '@beeline/buzz-client';
import type { AcpPermissionRequest } from './acp.js';
import { permissionRequestStrings } from './repository-target.js';

/** `#t` marker of the proposal card the agent publishes into the Room. */
export const TARGET_BRANCH_PROPOSAL_TAG = 'buzz-target-branch-proposal';

/**
 * The exact native command a Room agent attempts to ASK for the proposal card.
 *
 * It is never executed: the host recognizes it in the Room's ACP permission
 * callback, rejects the invocation itself, and publishes the proposal. Same
 * shape as `NAMED_REPOSITORY_PERMISSION_COMMAND`; unlike free-form prose it carries exactly one
 * typed argument this file validates.
 */
export const TARGET_BRANCH_PROPOSAL_COMMAND = '/change-target-branch';

/** Kept for physical Room sessions whose prompt predates the slash command. */
const LEGACY_TARGET_BRANCH_PROPOSAL_COMMAND = 'beeline-propose-target-branch';

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
 * `/change-target-branch --branch staging`. This is the agent's ONLY
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
  const markerCommands = [
    String.raw`\/change-target-branch`,
    LEGACY_TARGET_BRANCH_PROPOSAL_COMMAND,
  ].join('|');
  const marker = new RegExp(
    // The branch name ends the command: nothing may follow it but closing
    // quotes/parens from a harness's own wrapper. A chained shell payload
    // (`--branch staging && rm -rf /`) is therefore not this marker at all and
    // gets the ordinary read-only denial, exactly like any other command.
    String.raw`(?:^|\s)(?:${markerCommands})\s+--branch(?:=|\s+)(['"\x60]?)([A-Za-z0-9._\/-]+)\1['"\x60)\s]*$`,
  );
  for (const candidate of candidates) {
    const branch = normalizeTargetBranchName(candidate.match(marker)?.[2]);
    if (branch) return branch;
  }
  return undefined;
}

/**
 * Read the native slash invocation from a completed agent reply.
 *
 * Some harnesses expose an unknown slash command to the model as text instead
 * of sending `session/request_permission`. The slash parser remains the one
 * authority for deciding whether a line is a command; this layer only unwraps
 * the small Markdown shapes agents use when presenting that command and
 * validates its one typed argument.
 */
export function targetBranchProposalFromAgentText(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^(?:[-*+>][ \t]+)+/, '');
    const candidates = [trimmed, ...[...trimmed.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)];
    for (const candidate of candidates) {
      const slash = matchSlashCommand(candidate);
      if (slash?.command !== TARGET_BRANCH_PROPOSAL_COMMAND.slice(1)) continue;
      const argument = /^--branch(?:=|\s+)(['"\x60]?)([A-Za-z0-9._\/-]+)\1$/.exec(slash.args);
      const branch = normalizeTargetBranchName(argument?.[2]);
      if (branch) return branch;
    }
  }
  return undefined;
}
