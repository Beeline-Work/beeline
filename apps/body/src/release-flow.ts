/**
 * Cutting a release, as a conversation the Room agent can actually have.
 *
 * This is deliberately prompt-level. Beeline knows nothing about any
 * repository's release process and must not learn: version schemes, changelog
 * formats, and publish steps live in the repository, and a daemon that encoded
 * them would be wrong for every repository that does it differently. What the
 * daemon contributes is exactly three things a prompt cannot get for itself:
 *
 *   1. Ground truth — what is actually unreleased right now, read from git
 *      rather than recalled by a model (`summarizeUnreleasedWork`).
 *   2. A held proposal — so a person's plain "yes" a minute later still means
 *      "cut it" (`isReleaseConfirmation`, held per Room by the caller).
 *   3. One affordance at the far end: the land push carries the corner's
 *      annotated tag (`--follow-tags` in `Body.landOnDirectRemote`), which is
 *      why the corner brief below insists on an ANNOTATED tag — a lightweight
 *      one is not carried by `--follow-tags` and would land a release commit
 *      with no tag on the remote.
 *
 * Everything else — bumping the version, writing the changelog, choosing the
 * number — is the repository's own process, run by the corner agent, and it
 * ends in the ordinary merge-ready review every other corner ends in.
 */
import { git } from '@beeline/gate';

/** What a Room message is asking for, when it is asking about releases at all. */
export type ReleaseRoomIntent =
  /** "what's unreleased?" — a question, answered with a summary plus an offer. */
  | { kind: 'unreleased' }
  /** "cut a release" / "release v1.2" — an ask, answered with a proposal. */
  | { kind: 'release'; version?: string };

function normalize(content: string): string {
  return content
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:@[\p{L}\p{N}_-]+\s*[,:;]?\s+)+/u, '');
}

const VERSION_TOKEN = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/;

/**
 * Recognize the two release asks, and nothing else.
 *
 * Kept narrow on purpose: this diverts a turn away from the ordinary
 * read-only/permission paths, so a false positive costs a person a confusing
 * answer. Every pattern here requires the release word itself — "what changed
 * lately" is not a release question and stays an ordinary Room turn.
 */
export function releaseRoomIntent(content: string): ReleaseRoomIntent | undefined {
  const text = normalize(content);
  if (!text) return undefined;

  const unreleased =
    /\b(?:un-?released|not (?:yet )?released|unshipped|not (?:yet )?shipped)\b/i.test(text) ||
    /\bwhat(?:'s|’s| is| has| have)?\b[^.?!]{0,60}\bsince\s+(?:the\s+|our\s+|my\s+)?last\s+(?:release|tag|version)\b/i.test(
      text,
    ) ||
    /\bready\s+to\s+(?:release|ship)\b/i.test(text);

  const asksToRelease =
    // Deliberately only the word "release" as the object of the verb. Allowing
    // "version" or "tag" there turns an ordinary edit request — "make the
    // version bump in package.json" — into a release proposal.
    /\b(?:cut|do|make|prepare|prep|tag|ship|publish|start|create)\s+(?:me\s+)?(?:a\s+|the\s+|another\s+|our\s+)?(?:new\s+|next\s+|patch\s+|minor\s+|major\s+)?release\b/i.test(
      text,
    ) ||
    /\btag\s+v?\d+\.\d/i.test(text) ||
    /\blet'?s\s+(?:cut\s+)?(?:a\s+)?release\b/i.test(text) ||
    /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+)?release\s+v?\d/i.test(text) ||
    /\bcut\s+v?\d+\.\d/i.test(text);

  // A question about what is unreleased is answered first — "what's left to
  // release?" reads as both, and the honest reply is the summary, which
  // carries the proposal with it anyway.
  if (unreleased) return { kind: 'unreleased' };
  if (!asksToRelease) return undefined;
  const version = VERSION_TOKEN.exec(text)?.[1];
  return version ? { kind: 'release', version } : { kind: 'release' };
}

/**
 * Whether a message is nothing but agreement.
 *
 * Deliberately whole-message: a proposal is held for a while, and a person's
 * next message is far more often new work than a confirmation. Requiring the
 * entire message to be a confirmation is what stops "yes, but first fix the
 * README" from opening a release corner instead of doing what was asked.
 */
export function isReleaseConfirmation(content: string): boolean {
  const text = normalize(content)
    .toLowerCase()
    .replace(/[\s.!,]+$/g, '');
  if (!text) return false;
  return /^(?:(?:yes|yep|yeah|yup|ok|okay|sure|confirmed?|approved?|agreed|proceed|go|go ahead|go for it|do it|ship it|cut it|sounds good|looks good|please do|let'?s do it|lgtm)[\s,]*)+$/i.test(
    text,
  );
}

export interface UnreleasedWork {
  /** Branch the release would be cut from, without `refs/heads/`. */
  branch: string;
  /** Newest tag reachable from that branch, if the repository has any. */
  lastTag?: string;
  /** Commits on the branch since that tag (or in the whole branch, untagged). */
  commitCount: number;
  /** Newest-first commit subjects, capped for a prompt. */
  commits: string[];
  /** True when `commits` is a prefix of a longer list. */
  truncated: boolean;
}

const MAX_SUMMARIZED_COMMITS = 30;

/**
 * What is actually unreleased on a branch, read out of git.
 *
 * Read-only and best-effort: an unreadable repository, a missing branch, or a
 * repository with no commits at all returns `undefined`, and the caller simply
 * runs an ordinary Room turn instead of a release one. The branch is resolved
 * locally first and then through the remote-tracking ref, because a Room's
 * canonical checkout is reset to `origin/<target>` and may not hold a local
 * branch of that name at all.
 */
export async function summarizeUnreleasedWork(
  repoPath: string,
  targetBranch: string,
  remoteName?: string,
): Promise<UnreleasedWork | undefined> {
  const branch = targetBranch.replace(/^refs\/heads\//, '');
  const candidates = [branch, ...(remoteName ? [`${remoteName}/${branch}`] : []), 'HEAD'];
  let ref: string | undefined;
  for (const candidate of candidates) {
    if ((await git(repoPath, ['rev-parse', '--verify', `${candidate}^{commit}`])).ok) {
      ref = candidate;
      break;
    }
  }
  if (!ref) return undefined;

  const described = await git(repoPath, ['describe', '--tags', '--abbrev=0', ref]);
  const lastTag = described.ok ? described.stdout.trim() : undefined;
  const range = lastTag ? `${lastTag}..${ref}` : ref;

  const counted = await git(repoPath, ['rev-list', '--count', '--no-merges', range]);
  if (!counted.ok) return undefined;
  const commitCount = Number(counted.stdout.trim());
  if (!Number.isFinite(commitCount)) return undefined;

  const logged = await git(repoPath, [
    'log',
    '--no-merges',
    `--max-count=${MAX_SUMMARIZED_COMMITS}`,
    '--format=%s',
    range,
  ]);
  const commits = logged.ok
    ? logged.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return {
    branch,
    ...(lastTag ? { lastTag } : {}),
    commitCount,
    commits,
    truncated: commitCount > commits.length,
  };
}

/** One human-readable line naming where the release would start from. */
export function unreleasedHeadline(work: UnreleasedWork): string {
  const plural = work.commitCount === 1 ? 'commit' : 'commits';
  return work.lastTag
    ? `${work.commitCount} ${plural} on ${work.branch} since ${work.lastTag}`
    : `${work.commitCount} ${plural} on ${work.branch}, which has never been tagged`;
}

/**
 * Host context prepended to the read-only Room turn that answers a release
 * question.
 *
 * The commit list is supplied as ground truth rather than left to the agent to
 * find, for the same reason the objective panel is never agent free-text: a
 * model summarizing what it believes is unreleased is a claim nobody can
 * check, while a summary of a list the host read out of git is verifiable.
 */
export function releaseBriefing(work: UnreleasedWork, intent: ReleaseRoomIntent): string {
  const nothing = work.commitCount === 0;
  return [
    'Host boundary: this turn is about cutting a release, and it is read-only.',
    'The unreleased work below was read from git by the host. Treat it as the only',
    'authoritative list — do not go looking for a different one, and do not claim any',
    'release step has happened.',
    '',
    `Release base: ${unreleasedHeadline(work)}.`,
    ...(intent.kind === 'release' && intent.version
      ? [`The person named a version: ${intent.version}.`]
      : []),
    ...(nothing
      ? ['There is nothing unreleased.']
      : [
          'Unreleased commits (newest first):',
          ...work.commits.map((subject) => `- ${subject}`),
          ...(work.truncated ? [`- …and ${work.commitCount - work.commits.length} more`] : []),
        ]),
    '',
    'Answer in this shape:',
    nothing
      ? `- Say plainly that nothing is unreleased on ${work.branch}${work.lastTag ? ` since ${work.lastTag}` : ''}, and stop. Do not offer a corner.`
      : [
          '- Summarize what is unreleased in a few plain lines, grouped by theme, not one line per commit.',
          '- Say what kind of release it looks like (patch / minor / major) and why, in one line.',
          '- Then offer, in one sentence, to open a corner that runs this repository’s own release process',
          '  (version bump, changelog, annotated tag) and comes back for the normal review before anything lands.',
          '- End by asking them to confirm. Say that a plain "yes" is enough.',
        ].join('\n'),
    '- Do not attempt the release yourself in this Room, and do not request editing.',
  ].join('\n');
}

export interface ReleaseCornerBrief {
  work: UnreleasedWork;
  version?: string;
}

/** The corner's display prompt: what the Room sees the agent working on. */
export function releaseCornerPrompt(brief: ReleaseCornerBrief): string {
  return brief.version
    ? `cut release ${brief.version} from ${brief.work.branch}`
    : `cut a release from ${brief.work.branch}`;
}

/**
 * The corner-naming intent. `taskDescriptionFromCornerRequest` peels
 * scaffolding off this, so it is written as the task itself rather than as a
 * corner-open imperative — the corner is named `release-v1-2-0`, not
 * `open-a-corner-and-cut-a-release`.
 */
export function releaseCornerIntent(brief: ReleaseCornerBrief): string {
  return brief.version ? `release ${brief.version}` : `release from ${brief.work.branch}`;
}

/**
 * The corner's brief.
 *
 * It names no version scheme, no changelog format, and no release command,
 * because this daemon has no business knowing any of them — it points the
 * agent at the repository's own process and tells it to stop and say so if
 * there is not one. The two host-owned facts it does state are load-bearing:
 * the tag must be ANNOTATED (only annotated tags ride `--follow-tags` on the
 * land push), and nothing may be pushed or merged from inside the corner (the
 * human-approved land is the only thing that moves the target ref).
 */
export function releaseCornerTaskPrompt(brief: ReleaseCornerBrief): string {
  const { work, version } = brief;
  return [
    `Run this repository's own release process for ${work.branch}.`,
    '',
    'Host-provided release base, read from git (this is the authoritative list):',
    `- ${unreleasedHeadline(work)}`,
    ...work.commits.map((subject) => `- ${subject}`),
    ...(work.truncated ? [`- …and ${work.commitCount - work.commits.length} more`] : []),
    '',
    'Steps:',
    '1. Find how this repository already does releases — a release script, RELEASING/CONTRIBUTING docs, a CHANGELOG, the version field its tooling reads. Follow that process; do not invent one.',
    version
      ? `2. Use the version the person asked for: ${version}.`
      : '2. Choose the next version from the change above and this repository’s own versioning convention, and say in one line why that level (patch / minor / major).',
    '3. Apply the version bump and the changelog entry the repository’s process calls for, and commit them on this corner’s branch.',
    '4. Tag that commit with an ANNOTATED tag (git tag -a <version> -m "<version>"). An annotated tag is required: the host pushes the tag with the change when a human approves the land, and a lightweight tag would not be carried.',
    '',
    'Boundaries:',
    '- Do NOT push anything, do not merge, and do not touch the target branch. A human approves the land, and the host pushes the commit and its tag then.',
    '- Do NOT publish to any registry, and do not run anything that would announce the release outside this repository.',
    '- If this repository has no discernible release process, do not improvise one: say exactly what you looked for and what you found, make no commit, and stop.',
    '',
    'Finish by summarizing what you bumped, what the changelog entry says, and the exact tag name you created.',
  ].join('\n');
}
