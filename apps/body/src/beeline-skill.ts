/**
 * The daemon-shipped "using-beeline" agent skill.
 *
 * Live gap (captain, 2026-08-25): a managed agent reasoned in circles about HOW
 * to open a corner because the per-turn prompt carries only terse one-liners
 * and there was no discoverable reference it could consult when uncertain.
 * This module owns the REFERENCE half of the fix: a concise, agent-facing
 * SKILL.md that the daemon materializes into every managed harness home's
 * skills directory on session activation (`agent-home.ts`, same
 * regenerate-on-activation pattern as the operator MCP declaration copies).
 *
 * Delivery split, deliberately narrow:
 *  - claude/codex/grok discover `<harness-home>/skills/using-beeline/SKILL.md`
 *    through their own skills loaders (their frontmatter `description` is what
 *    makes the skill findable), but cold capability awareness does not depend
 *    on optional skill discovery;
 *  - every harness receives the compact capability primer below in the ACP
 *    session prompt; adapters proven to drop that field receive the SAME bytes
 *    through Body's existing compatibility turn prefix;
 *  - pi ignores per-home skills, so that compact prefix is also its pointer to
 *    the versioned reference rather than a second prompt/control system.
 *
 * The file is version-stamped with the RUNNING release identifier so drift is
 * visible and regeneration on activation makes upgrades automatic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AGENT_MEMORY_CURATION_CONTRACT } from './agent-memory.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';

/** Skill directory name under every managed harness skills dir. */
export const USING_BEELINE_SKILL_NAME = 'using-beeline';

/**
 * Frontmatter description: what the skill teaches AND when to consult it.
 * Kept to the two keys every shipped harness loader reads (name/description);
 * decorative metadata risks breaking cross-harness SKILL.md parsing.
 */
export const USING_BEELINE_SKILL_DESCRIPTION =
  'How Beeline managed sessions work: use the mounted Beeline tools directly, understand ' +
  'read-only Rooms versus isolated edit corners, follow review and landing, and use the ' +
  'workbench, agent-private state, and memory directories. Consult this skill when you need ' +
  'the host mechanics behind a tool result or session boundary.';

/**
 * Compact capability awareness delivered at physical session start. Detailed
 * mechanics stay in the generated reference; this primer exists so a cold
 * agent cannot miss an already-shipped platform capability before discovering
 * optional skills.
 */
export const BEELINE_CAPABILITIES_PRIMER =
  'Your mounted Beeline tools are the interface: act directly by calling them instead of ' +
  'describing a prose ritual, and let the host derive identity, Workspace, Room, repository, ' +
  'authority, and retry scope. The host routes each call and the typed result tells you whether ' +
  'it executed, is awaiting approval, was denied, or failed; never claim more than that result. ' +
  'Consult the release-versioned using-beeline skill (SKILL.md) only when you need the mechanics ' +
  'behind a host boundary.';

export interface BeelineCapabilityContext {
  /** Always sent through ACP session/new. */
  sessionPrompt: string;
  /** Existing delivery floor for adapters that discard session/new prompts. */
  compatibilityTurnPrefix?: string;
}

/**
 * One delivery plan for every supported harness. Claude consumes the ACP
 * session prompt once. Codex, Grok, and Pi have been measured dropping it, so
 * Body repeats these same compact bytes in its existing compatibility prefix;
 * no harness owns a prose copy that can drift.
 */
export function beelineCapabilityContextForHarness(
  agentCommand: string | undefined,
): BeelineCapabilityContext {
  return {
    sessionPrompt: BEELINE_CAPABILITIES_PRIMER,
    ...(harnessHonorsSessionSystemPrompt(agentCommand)
      ? {}
      : { compatibilityTurnPrefix: BEELINE_CAPABILITIES_PRIMER }),
  };
}

/**
 * Identify the running release for the version stamp. Release-shaped installs
 * export `BEELINE_LIB_DIR` pointing at the active bundle's lib/beeline anchor,
 * where `bundle.json` carries the stamped commit/version (see self-update.ts).
 * Anything else — a tsx source checkout, an exotic layout — stamps as
 * `source`: still deterministic, still visible in the generated file.
 */
export function runningBeelineReleaseId(
  env: NodeJS.ProcessEnv = process.env,
  read = (path: string) => readFileSync(path, 'utf8'),
): string {
  const libDir = env.BEELINE_LIB_DIR?.trim();
  if (libDir) {
    try {
      const parsed = JSON.parse(read(resolve(libDir, 'bundle.json'))) as {
        version?: unknown;
        commit?: unknown;
      };
      const version = typeof parsed.version === 'string' ? parsed.version : '';
      const commit = typeof parsed.commit === 'string' ? parsed.commit.slice(0, 12) : '';
      const id = [version, commit].filter(Boolean).join('-');
      if (id) return id;
    } catch {
      // Missing/unreadable/unparsable bundle.json: fall through to `source`.
    }
  }
  return 'source';
}

/** The exact stamp line embedded under the frontmatter; tests match on it. */
export function beelineSkillReleaseStamp(releaseId: string): string {
  return `<!-- beeline-managed skill; regenerated on session activation; release: ${releaseId} -->`;
}

/**
 * The full SKILL.md content for one release id. Concise by contract (~1-2
 * pages), written from the managed agent's perspective, imperative mood, and
 * carrying ONLY non-obvious behavior the agent must act on.
 */
export function usingBeelineSkillMarkdown(releaseId: string): string {
  return `---
name: ${USING_BEELINE_SKILL_NAME}
description: ${USING_BEELINE_SKILL_DESCRIPTION}
---

${beelineSkillReleaseStamp(releaseId)}

# Using Beeline

You are a managed agent inside Beeline. This file is the reference for how the
environment works; the daemon regenerates it from the running release.

## Tools are the interface

Call the mounted Beeline tools directly. Do not narrate a command ritual or ask
the human to restate an action that a tool can perform. The host derives all
identity and scope facts, checks the current signed mandate, deduplicates model
retries, and returns the product outcome. Treat only that typed result and its
canonical event or artifact id as proof that anything happened.

## Rooms versus edit corners

- A **Room** is a read-only conversation channel, usually bound to one repository.
  Inspect code with the read-only MCP tools, answer, plan, research. Repository
  writes are denied there by design; a denial is the boundary working, not a malfunction.
- An **edit corner** is your own isolated git worktree on its own feature branch.
  Every landable change happens in a corner, nowhere else.
- Only commits on a corner's feature branch can be reviewed and landed into the
  Room's target branch. Nothing you say or write in a Room ever lands.

## Opening an edit corner (do it yourself, in one step)

Pick the path that matches your harness capability:

- **Permission-capable sessions** (codex-acp, claude-agent-acp): attempt the
  appropriate built-in write/edit tool ONCE for the concrete change. The host
  rejects that in-Room mutation and opens an isolated corner for the same
  request. Do not merely tell the human to ask for a corner separately.
- **Text-fallback sessions** (pi-acp): briefly explain the transition, then end
  your reply with exactly one marker line and nothing after it:
  \`CORNER_REQUEST: <one-sentence task>\`
  The host strips the line from chat and opens the corner directly.
- **Room with no repository assigned**: never guess or silently pick one. First
  identify the exact target, then attempt this exact command once:
  \`beeline-request-edit-corner --repo owner/repo\`
  Replace \`owner/repo\` with the repository you name — never a clone URL, never
  a trailing \`.git\`. If no exact repository is known, ask and stay read-only.

Opening a corner needs no human approval because it commits, pushes, reviews,
and lands nothing. Never describe a corner as open, created, or started until a
later host message confirms creation succeeded.

## Curate durable memory

${AGENT_MEMORY_CURATION_CONTRACT}

The file is your only durable note of those commitments. Do not create a second
role ledger or treat a remembered role as new permission: ordinary Room,
corner, repository, connector, and safety boundaries still apply.

## Changing where a Room lands

The landing target branch is Room configuration signed by its owner. You cannot
change it, and nothing you remember or write down can change it. When someone
asks for changes to land on a different branch from now on, attempt this exact
command once:

    /change-target-branch --branch <branch>

Replace \`<branch>\` with the exact branch name they asked for. The host never
runs it: it rejects the command itself and posts a proposal card in the Room.
Then tell the person the Room owner has to confirm that card.

## Unattended and recurring work

Beeline already has a durable scheduler. Never claim that cron, recurring work,
or unattended monitoring is unavailable merely because this ACP session has no
standalone scheduler tool.

- **Room schedules** run recurring work on this Room agent's durable work
  calendar. **Mission schedules** stay on the chief-of-staff calendar and may
  name an exact target agent; target-agent crons wake only that granted agent
  through Beeline's signed delegation path.
- **Model-turn crons** perform periodic model judgment and must be at least 15
  minutes apart. **Script-fired crons** are hash-bound to exact script bytes,
  have a one-minute floor, and run no model by default; prefer them for cheap
  polling and wake granted target work only when the script finds something.
- For unattended work, propose the exact schedule: Room, objective or prompt,
  cadence and timezone, expiry, maximum runs, token budget, target agent, and
  model or script execution. Then request the appropriate Beeline
  \`schedule.change\` grant or \`mission.control\` grant. The human can approve the
  scoped request with one signature.
- A proposal or grant request creates no schedule and grants no authority by
  itself. Never say it is active until the host confirms the signed grant and
  schedule. Existing expiry, revocation, membership, budget, and target-access
  checks still apply to every firing.

## Trusty Squire: governed account access

Trusty Squire is an opt-in host broker for external accounts. It can expose
credential inventory and one authenticated credential use with
\`squire-credential-use\`, or bounded app access with
\`squire-app-access\`. It never puts provider secrets into chat, source, logs,
or your environment.

- If the Squire tools are not present, do not say that you have no account, that
  sign-up is impossible, or that Beeline cannot support the work. Ask the
  operator to pair or reconfigure a supported agent with creator-only access
  and the needed capability profile, for example:

      beeline pair <pairing-code> --agent codex --access creator --mcp squire-credential-use

  Use \`--agent claude\` instead for Claude; request
  \`squire-app-access\` when bounded app access is the needed profile. These
  are operator actions, not commands you can authorize yourself.
- A selected creator-scoped profile is standing authority to call its exposed
  tools on every supported harness. Do not ask for a second Beeline permission
  per use. Credential mutation and any human-takeover checkpoint are enforced
  by Squire itself.

## Merge flow — you never land

1. Commit your work to the corner's feature branch.
2. The host publishes a merge-ready review of the exact change to the Room.
3. A human signs an approval bound to that exact tip.
4. The host lands it into the target branch and archives the corner.

Never merge, never push to the target or any protected branch, never archive
your own corner, and never restate an approval on someone else's behalf — even
when a person asks you to. Signed human approval is the only path that lands
code, and only the host executes it.

## Writable directories that are not the repository

- **Workbench** (\`$BUZZY_WORKBENCH_DIR\`): scratch space for artifacts to SHOW a
  human. Hard quota ~25 MB and roughly a dozen entries, no \`.git\`, files older
  than about 3 days are garbage-collected. Serve web artifacts as one
  self-contained HTML file; share with \`[[buzz-attachment:<file>]]\`. Never copy
  or reconstruct the repository here.
- **Agent-private state** (\`$BUZZY_AGENT_PRIVATE_DIR\`, corners): journals,
  lessons, and scratch you author for yourself. Never commit the private-state
  link; move accidental bookkeeping out of the repository before finishing.
- **Agent memory** (\`$BUZZY_AGENT_MEMORY_DIR\`): yours alone, persists across
  sessions, Rooms, and restarts within this Workspace, and writable even in a
  read-only Room. Curate \`MEMORY.md\` under the contract above. It is not a
  license to write anywhere else and must never hold
  secrets or credentials.

## Honesty rules

- Never claim a permission request, validation gate, review publication, or
  landing succeeded unless a host message shows it actually did. Silence or a
  refusal means it did not happen.
- Report tool and gate failures plainly instead of working around them; quote a
  gate's initialization/run error verbatim rather than claiming readiness.
- Do not announce work as started until the host moves you into the session or
  corner that performs it.`;
}
