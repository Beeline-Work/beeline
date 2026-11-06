import { createHash, randomUUID } from 'node:crypto';
import type { WorkflowContract } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

const accountRules = "Spend $0; no cards/deposits or purchased credits. No ElevenLabs or Cloudflare accounts/keys. Use only the current person's connected accounts. Use Squire for signups and approval cards; verify the selected account belongs to that person. If Squire is unavailable, advance blocked with the concrete missing capability so the next agent can try. Stay inside the free-agent allowance.";
const reelFormat = "Target 6-9 seconds; hard maximum 15 seconds. Encode portrait 9:16 (720x1280 or 1080x1920).";

const contract: WorkflowContract = {
  version: 1,
  name: 'welcome-video',
  description: 'Make and approve your free vertical welcome video',
  summary: 'Beebee makes your free 6-9 second welcome Short, Luna checks it, and you choose Post or Cancel.',
  roles: ['writer', 'maker', 'checker', 'owner'],
  start: 'gather',
  deadlineSeconds: 100800,
  handoffs: {
    gather: {
      does: 'Choose one public fact for a short welcome reel, from GitHub or the person’s own chat messages.',
      role: 'writer',
      hint: `First use connect for YouTube if it is not connected; wait for its card before making the reel. Call connect(mode:status). If GitHub is connected, use its tools and cite the public fact's URL. Public data only. Without GitHub, quote the person's own chat message. Choose one simple visual idea about that fact. ${reelFormat} ${accountRules}`,
      requires: ['fact', 'evidence_urls', 'idea'],
      on: { ready: 'signup_video', timeout: 'nudge' },
      loop: { onEdge: 'timeout', cap: 2, onExceeded: 'stuck' },
      timeoutSeconds: 600,
    },
    signup_video: {
      does: 'Sign up through Squire for a video model’s free tier and verify that it can generate and download a clip for $0.',
      role: 'maker',
      hint: `Use Squire to sign up yourself, by email, for a free video-model service. Verify the current free allowance and usable video generation/download before proceeding; do not assume an API is free because its web app is. A free web route is valid. Vault any API key through Squire; report vault_reference as not_required with evidence for a web-only route, never a fake secret. Record the service, signup and free-tier evidence. If payment, a card or deposit is required, try another free video model or report the concrete block. ${accountRules}`,
      requires: ['service', 'vault_reference', 'free_tier_evidence'],
      on: { saved: 'make_reel', timeout: 'nudge' },
      loop: { onEdge: 'timeout', cap: 2, onExceeded: 'stuck' },
      timeoutSeconds: 1200,
    },
    make_reel: {
      does: 'Generate a short video-model clip and prepare the vertical welcome reel: target 6-9 seconds, never over 15.',
      role: 'maker',
      hint: `Use actual video-model output from the free account you signed up for through Squire in signup_video. Verify the account and free allowance before generation. ${reelFormat} One simple clip is enough; trim a longer model output to fit. Keep any text within the safe frame and grounded in gather's fact. Only add audio or captions if useful; no narration is required. Preserve required provider attribution or watermarks; put other credits in the YouTube description. Post the MP4 and a preview frame. Include the original model output object ID, model/service and signup reference, generation evidence and $0 cost evidence. ${accountRules}`,
      requires: ['video_object_id', 'frame_object_id', 'seconds', 'model_output_object_id', 'generation_evidence'],
      on: { made: 'check_reel', timeout: 'nudge' },
      loop: { onEdge: 'timeout', cap: 2, onExceeded: 'stuck' },
      timeoutSeconds: 1500,
    },
    check_reel: {
      does: 'Play the reel and verify duration, vertical format, factual accuracy and free video-model provenance.',
      role: 'checker',
      hint: `You must not be its maker. Independently play the final MP4 and use ffprobe to measure duration and prove width*16 === height*9. ${reelFormat} Reject any clip over 15 seconds. Compare the reel with the original video-model output and verify the service/signup/generation evidence shows a free account created through Squire and $0 spend. A still-image slideshow does not satisfy video-model output. Check the public fact, readable captions if present, required attribution and usable playback. Report measured seconds, dimensions and provenance findings; send failures back to make_reel. ${accountRules}`,
      requires: ['verdict', 'measured_seconds', 'dimensions', 'provenance_findings'],
      on: { ok: 'show_preview', redo: 'make_reel', timeout: 'stuck' },
      loop: { onEdge: 'redo', cap: 2, onExceeded: 'stuck' },
      timeoutSeconds: 900,
    },
    show_preview: {
      does: 'Show the checked reel with Post and Cancel; only Post authorizes a later YouTube Shorts upload.',
      role: 'maker',
      hint: `Create preview card via onboarding video_preview; do not upload or auto-answer. Advance shown after posting the preview. This completes reel creation only. Its Post tap wakes you for the existing guarded upload to the person's connected YouTube as a Short; a finished workflow is never upload approval. Cancel means no upload. ${accountRules}`,
      requires: ['preview_message_id'],
      on: { shown: 'done', timeout: 'nudge' },
      loop: { onEdge: 'timeout', cap: 2, onExceeded: 'stuck' },
      timeoutSeconds: 900,
    },
    nudge: {
      does: 'The supervisor checks why a step stopped, tests any claimed block, and sends it back with the exact next tool call.',
      role: 'checker',
      hint: `Read the run history. A missing attempt is not a block: send it back. Test a claimed block yourself; only money, phone or an unsolvable captcha is real. Real block: give_up. ${accountRules}`,
      requires: ['finding', 'next_tool_call'],
      on: {
        gather: 'gather', signup_video: 'signup_video', make_reel: 'make_reel',
        preview: 'show_preview', give_up: 'stuck', timeout: 'stuck',
      },
      timeoutSeconds: 600,
    },
    stuck: {
      does: 'Every agent on a step stopped; a person chooses to retry or end.',
      kind: 'gate',
      role: 'owner',
      hint: accountRules,
      requires: ['decision'],
      on: { retry: 'nudge', abandon: 'failed' },
      timeoutSeconds: 86400,
      default: 'abandon',
    },
    done: {
      does: 'Your checked welcome reel is ready for you to choose Post or Cancel.',
      kind: 'terminal',
      status: 'done',
    },
    failed: {
      does: 'The welcome reel was not finished.',
      kind: 'terminal',
      status: 'failed',
    },
  },
};

/** Keep the slug stable for starter runs and the guarded preview/upload flow. */
export const WELCOME_VIDEO_SLUG = 'welcome-video';

/** Caller owns the transaction. Append revisions so running workflows keep their pinned contract. */
export async function seedWelcomeVideoWorkflow(db: SqlDatabase, workspaceId: string, roomId: string): Promise<void> {
  const markdown = JSON.stringify(contract);
  const contentHash = createHash('sha256').update(markdown).digest('hex');
  // Retain the old seed lock during rolling upgrades, and share the ordinary save/archive lock.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`welcome-video:${workspaceId}`]);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workspace-skill:${workspaceId}:${WELCOME_VIDEO_SLUG}`]);
  const versionRow = async (skillId: string, version: number) => db.query(`INSERT INTO workspace_skill_versions
    (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,target_commit,path,extractor_version,model)
    VALUES($1,$2,$3,$4,NULL,$5,'','',NULL,'welcome-video-v2','n/a')`,
  [skillId, version, markdown, contentHash, ['system:welcome-video-seed']]);
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO workspace_skills
      (id,workspace_id,slug,description,state,current_version,revision,source_room_id,repository,target_commit,path,kind)
     SELECT $1,$2,$3,$4,'active',1,1,$5,'','',NULL,'workflow'
     WHERE NOT EXISTS (SELECT 1 FROM workspace_skills WHERE workspace_id=$2 AND slug=$3) RETURNING id`,
    [randomUUID(), workspaceId, WELCOME_VIDEO_SLUG, contract.description, roomId]);
  if (inserted.rows[0]) {
    await versionRow(inserted.rows[0].id, 1);
    return;
  }
  // Refresh only the server's seed; preserve team-authored and archived workflows.
  const stale = (await db.query<{ id: string }>(
    `SELECT skill.id FROM workspace_skills skill
     JOIN workspace_skill_versions version ON version.skill_id=skill.id AND version.version=skill.current_version
     WHERE skill.workspace_id=$1 AND skill.slug=$2 AND skill.kind='workflow' AND skill.state='active'
       AND version.extractor_version IN ('welcome-video-v1','welcome-video-v2') AND version.content_hash<>$3
     FOR UPDATE OF skill`, [workspaceId, WELCOME_VIDEO_SLUG, contentHash])).rows[0];
  if (!stale) return;
  const next = (await db.query<{ version: number }>(
    `UPDATE workspace_skills SET current_version=current_version+1,revision=revision+1,
       description=$2,updated_at=now(),embedding=NULL,embedding_version=NULL
     WHERE id=$1 RETURNING current_version version`, [stale.id, contract.description])).rows[0]!.version;
  await versionRow(stale.id, next);
}

export async function backfillWelcomeVideoWorkflow(db: SqlDatabase): Promise<void> {
  // Include already-seeded workspaces even when their starter agents have left.
  const rows = (await db.query<{ workspace_id: string; room_id: string }>(
    `SELECT DISTINCT ON (workspace_id) workspace_id,room_id FROM (
       SELECT workspace_id,source_room_id room_id FROM workspace_skills WHERE slug=$1 AND kind='workflow'
       UNION ALL
       SELECT f.workspace_id,m.room_id FROM free_agents f
       JOIN memberships m ON m.identity_id=f.agent_id AND m.workspace_id=f.workspace_id
         AND m.room_id IS NOT NULL AND m.removed_at IS NULL
       WHERE f.removed_at IS NULL
     ) candidates ORDER BY workspace_id,room_id`, [WELCOME_VIDEO_SLUG])).rows;
  for (const row of rows) await db.transaction(tx => seedWelcomeVideoWorkflow(tx, row.workspace_id, row.room_id));
}
