/**
 * Code anchors: a generated procedure is advice about code, and code that moved
 * on makes it wrong however recently it was served.
 *
 * The digest is the git blob id of the anchored file at the recorded commit, and
 * the server reads it from GitHub itself. A model-asserted digest would be
 * unusable — an assistant claiming "I changed this file, hash abc" is exactly
 * the kind of uncorroborated provenance that cannot safely stale a valid
 * procedure — so an anchor nobody can read is UNVERIFIABLE, never verified.
 *
 * Comparison asks the one question the objective needs: does the same path on
 * the repository's current default branch still hold the same blob? A different
 * blob, or a path that is gone, is a contradiction. The procedure keeps its
 * text, its sources and its immutable version history and stops being served;
 * nothing is deleted, so a later fix can restore it.
 *
 * Every failure mode is fail-open. A dead token, a rate limit, an unreachable
 * API, a repository this installation can no longer read, or a corner whose
 * feature branch was reaped must never turn a live procedure stale — so only a
 * definitive answer from GitHub changes state.
 */
import type { SqlDatabase } from './database.js';

export const INSTITUTIONAL_SKILL_ANCHOR_SCAN_MAX = 20;
/**
 * A branch moves far faster than a weekly curator cycle, but each check costs
 * two GitHub reads per anchored procedure, so a day is the shortest interval
 * that keeps a large catalogs' checks inside budget.
 */
export const INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS = 24 * 60 * 60_000;
export const INSTITUTIONAL_SKILL_ANCHOR_REASON_MAX = 300;

export interface InstitutionalSkillAnchorSource {
  /** Installation token + default branch for the repository a Room belongs to. */
  resolveRoomRepository(roomId: string): Promise<{
    token: string;
    repository: string;
    defaultBranch: string;
  }>;
  /** The git blob id of one path at one ref, undefined when that ref has no such file. */
  fileBlobSha(input: {
    token: string;
    repository: string;
    path: string;
    ref: string;
  }): Promise<string | undefined>;
}

export interface InstitutionalSkillAnchorResult {
  /** Active procedures whose anchor was asked about this pass. */
  readonly checked: number;
  /** Anchors that gained the baseline digest they did not have yet. */
  readonly baselined: number;
  /** Procedures staled because their anchored code no longer matches. */
  readonly staled: number;
  /** Anchors GitHub answered about but could not corroborate. */
  readonly unverifiable: number;
  /** Anchors left exactly as they were because the read itself failed. */
  readonly failed: number;
}

interface AnchorRow {
  id: string;
  slug: string;
  source_room_id: string;
  repository: string;
  target_commit: string;
  path: string | null;
  code_content_hash: string | null;
}

function boundedReason(reason: string): string {
  return reason.length <= INSTITUTIONAL_SKILL_ANCHOR_REASON_MAX
    ? reason
    : `${reason.slice(0, INSTITUTIONAL_SKILL_ANCHOR_REASON_MAX - 1)}…`;
}

/**
 * Stamp the outcome of one check. `code_content_hash` is only ever filled, never
 * cleared: a later unreadable anchor must not erase the baseline that makes the
 * comparison possible again once GitHub answers.
 */
async function recordAnchorCheck(
  database: SqlDatabase,
  id: string,
  now: Date,
  input: {
    readonly baseline?: string;
    readonly staleReason?: string;
  },
): Promise<void> {
  await database.query(
    `UPDATE workspace_skills
     SET anchor_checked_at=$2,
         code_content_hash=COALESCE($3,code_content_hash),
         state=CASE WHEN $4::text IS NULL THEN state ELSE 'stale' END,
         anchor_stale_at=CASE WHEN $4::text IS NULL THEN anchor_stale_at ELSE $2 END,
         anchor_stale_reason=CASE WHEN $4::text IS NULL THEN anchor_stale_reason ELSE $4 END,
         updated_at=CASE WHEN $4::text IS NULL THEN updated_at ELSE $2 END
     WHERE id=$1`,
    [id, now, input.baseline ?? null, input.staleReason ? boundedReason(input.staleReason) : null],
  );
}

/**
 * One Workspace's bounded anchor pass: fill missing baselines, compare the rest
 * against the repository's current code, and stale only what GitHub contradicts.
 *
 * Runs OUTSIDE the curator's transaction and lock — every step here is a network
 * read, and holding `institutional-memory:<workspace>` across one would put a
 * third-party API in the path of every agent turn settling in that Workspace.
 */
export async function refreshWorkspaceSkillAnchors(
  database: SqlDatabase,
  workspaceId: string,
  source: InstitutionalSkillAnchorSource | undefined,
  now = new Date(),
): Promise<InstitutionalSkillAnchorResult> {
  const result = {
    checked: 0,
    baselined: 0,
    staled: 0,
    unverifiable: 0,
    failed: 0,
  };
  if (!source) return result;
  const rows = (
    await database.query<AnchorRow>(
      `SELECT skill.id,skill.slug,skill.source_room_id,skill.repository,
              skill.target_commit,skill.path,skill.code_content_hash
       FROM workspace_skills skill
       JOIN workspace_skill_versions version
         ON version.skill_id=skill.id AND version.version=skill.current_version
       WHERE skill.workspace_id=$1 AND skill.state='active'
         AND version.source_deleted_at IS NULL
         AND (skill.anchor_checked_at IS NULL OR skill.anchor_checked_at<$2)
       ORDER BY skill.anchor_checked_at ASC NULLS FIRST,skill.id
       LIMIT $3`,
      [
        workspaceId,
        new Date(now.getTime() - INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS),
        INSTITUTIONAL_SKILL_ANCHOR_SCAN_MAX,
      ],
    )
  ).rows;
  for (const skill of rows) {
    result.checked += 1;
    if (!skill.path) {
      // A repository-level anchor names no file, so there is nothing to compare
      // and nothing to contradict. Say so by recording no baseline at all.
      result.unverifiable += 1;
      await database.query(`UPDATE workspace_skills SET anchor_checked_at=$2 WHERE id=$1`, [
        skill.id,
        now,
      ]);
      continue;
    }
    try {
      const target = await source.resolveRoomRepository(skill.source_room_id);
      if (!skill.code_content_hash) {
        const baseline = await source.fileBlobSha({
          token: target.token,
          repository: skill.repository,
          path: skill.path,
          ref: skill.target_commit,
        });
        if (!baseline) {
          // The anchored commit no longer carries this path. That is a fact
          // about the anchor, not a contradiction of the procedure.
          result.unverifiable += 1;
          await database.query(`UPDATE workspace_skills SET anchor_checked_at=$2 WHERE id=$1`, [
            skill.id,
            now,
          ]);
          continue;
        }
        result.baselined += 1;
        await recordAnchorCheck(database, skill.id, now, { baseline });
        continue;
      }
      const current = await source.fileBlobSha({
        token: target.token,
        repository: skill.repository,
        path: skill.path,
        ref: target.defaultBranch,
      });
      if (current === skill.code_content_hash) {
        await recordAnchorCheck(database, skill.id, now, {});
        continue;
      }
      if (current === undefined) {
        // A missing path on the current branch is only evidence if the anchor
        // itself is still readable: a repository this installation can no
        // longer see answers 404 for both, and that is a broken read, not
        // moved code.
        const anchorStillReadable = await source.fileBlobSha({
          token: target.token,
          repository: skill.repository,
          path: skill.path,
          ref: skill.target_commit,
        });
        if (anchorStillReadable !== skill.code_content_hash) {
          result.failed += 1;
          continue;
        }
        result.staled += 1;
        await recordAnchorCheck(database, skill.id, now, {
          staleReason: `the anchored file ${skill.path} no longer exists on ${target.defaultBranch}`,
        });
        continue;
      }
      result.staled += 1;
      await recordAnchorCheck(database, skill.id, now, {
        staleReason: `the anchored file ${skill.path} changed on ${target.defaultBranch}`,
      });
    } catch (error) {
      // A read that failed is not an answer. Leave the row exactly as it is so
      // the next pass asks again.
      result.failed += 1;
      console.error(
        `[server] institutional skill anchor check failed (${skill.slug}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}
