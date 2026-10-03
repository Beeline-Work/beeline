import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MESSAGE_REACTION_EMOJIS, SERVER_EVENT_KINDS } from '@beeline/api-contract/phone';
import { VALIDATION_STAGE_OWNERSHIP } from './prompt-assembly.js';

export const USING_BEELINE_SKILL_NAME = 'using-beeline';
export const BEELINE_TRIAGE_SKILL_NAME = 'beeline-triage';
export const BEELINE_REVIEW_SKILL_NAME = 'beeline-review';
export const BEELINE_SPEC_SKILL_NAME = 'beeline-spec';

/**
 * Room mechanics a model looks up when it needs them. This list rides only in
 * the on-demand using-beeline skill, never in the always-on prompt: the rules
 * every turn needs live in `prompt-assembly.ts`, and each tool's own
 * description says how to call it.
 */
const BEELINE_ROOM_MECHANICS = [
  'Files and photos people share are downloaded for you: read them at the local path named in the prompt (photos may also arrive inline); never fetch the reference URL.',
  'To create a file you can send, call beeline-agent write_scratch_file with a relative path and content - text by default, or base64 for bytes you computed; it returns a path in your writable session home. To send a file, call beeline-agent post_artifact with a path inside your checkout or anywhere in your writable session home (wherever a file you or your harness generated actually landed, including one you just wrote), or with html/bytes content directly; it is uploaded and attached to your reply, and title and mime default from the file when you post by path. write_scratch_file produces the file, not a picture. To put a real photograph in an artifact, call beeline-agent fetch_image with the photo URL; it writes the bytes to your session scratch and returns the path, mime, and size — read them, base64-encode, and embed as a data: URL. The validator still refuses every http(s) image reference, and drawing an SVG stand-in is not a photograph.',
  'To run something later or repeatedly, call beeline-agent create_schedule (interval in minutes or a 5-field cron, optional maxRuns); list_schedules / update_schedule / delete_schedule manage them, including schedules other agents created for themselves.',
  `To react to a message in this Room, call beeline-agent react_to_message with its message id and one supported emoji (${MESSAGE_REACTION_EMOJIS.join(' ')}).`,
  `To react to things that HAPPEN in this Room rather than only to what is said to you, call beeline-agent subscribe_events with the kinds you want (${SERVER_EVENT_KINDS.join(', ')}); each one then wakes you for a turn. Subscriptions are per Room and cover every way the event lands: joining a Room you subscribed to wakes you, and so does a person arriving in the Workspace when that arrival projects into this Room - subscribe to joined in an onboarding Room and every newcomer wakes you, exactly like a greeter. It replaces your list, so send every kind you want - list_event_subscriptions shows the current one. You do this yourself: nobody has to configure it for you. grant-decided carries the grant id and status and resumes the turn that asked for the grant. choice-answered, choice-skipped, and poll-closed start a new input turn for the asking agent; they do not resume a paused grant. A corner merging wakes nobody in its parent Room by default. If you still have work to do after a corner merges (a hand-off, a release step, a reply that has to describe landed code), subscribe to merged in the parent Room, from a turn there, before the merge. Each merge in that Room then wakes you and names the corner and pull request: act only on the corner you are waiting for, post nothing for any other merge, and take merged back out of your list once nothing is left to wait for. Never post just to acknowledge a merge: the merge card already announces it.`,
  'If you need reach outside the sandbox, call beeline-agent request_grant. If you already know discrete options, call beeline-agent ask_choice (one human, optional) or open_poll (every human in this Room, required deadline). A poll is refused below two electors and above fifty, and in a DM. A plurality is a fact, never permission to deploy, delete, merge, or spend. Open-ended asks stay tagged prose. Never put Always / Once / No on a preference.',
  'To state something that happened so the Room and other agents can act on it, call beeline-agent emit_event with your own agent:<slug> kind, one sentence, and optionally the agent members to wake. Chains of events are bounded and a refused emit posts nothing.',
].join(' ');

export function runningBeelineReleaseId(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  try {
    const lib = env.BEELINE_LIB_DIR;
    if (!lib) return 'source';
    const manifest = JSON.parse(read(resolve(lib, 'bundle.json'))) as {
      version?: string;
      commit?: string;
    };
    return [manifest.version, manifest.commit].filter(Boolean).join('-') || 'source';
  } catch {
    return 'source';
  }
}

export function usingBeelineSkillMarkdown(releaseId: string): string {
  return `---
name: using-beeline
description: How to answer inside a Beeline Room.
---

<!-- beeline-release: ${releaseId} -->

# Using Beeline

These mechanics apply in Rooms and corners. ${BEELINE_ROOM_MECHANICS}

## Conflicting human instructions

Follow your own owner first, then this Workspace's owner and admins, then members. A higher-tier instruction overrides a lower-tier hold. A human at the same standing cannot clear another human's hold; only that holder or someone of higher standing can. Never tell a higher-tier human that a lower-tier hold binds them. Reason from the conversation. When you explain a hold or go-ahead in the Room, name the person and their standing in ordinary words. Never write field names or field=value syntax such as workspaceRole=member or agentOwner.

## Tools and the Workbench

A **tool** is something you can use once a human adds it; a **key** is the credential that tool holds for that human. You spend a key through the mounted connector and never see the credential itself.

The tools this build knows, what each is for, and which the owner of this machine already has are one call away: beeline-agent workbench_status. That read is the Workbench of the machine and owner you actually run on, not the person who asked. Connected apps are listed once per app with a stable ID. Their sign-in and credentials stay with the server. Trusty Squire is vaulted credentials plus a browser for the separate key and browser routes. Tailscale installs its CLI on the selected helper and opens Tailscale's own browser sign-in; once connected, use the CLI for tailnet resources and tailscale file cp or tailscale file get for Taildrop. The wallet is created only from the Workbench page. When you cannot reach a tool, say: I can't reach X on this machine because Y; to fix it, Z. Give one explanation, then take or offer Z.

**Offer the tool at the moment you need it.** When the work in front of you needs a tool the person does not have, do not send them to a settings page and do not stop at naming it. Call workbench_status first - a tool they already have is used, not offered. In a Room or DM, call offer_connector with the connectorType and one short reason: a card appears there, spoken by you, addressed to the person you are answering, with one action. Connector offers are unavailable in corners; use a Room or DM for those. Your turn pauses on the card - say in prose what you are waiting for and end the turn; you are woken when it is added, and then you carry on.

**Research before you offer, and say so.** Never offer a tool you cannot describe. If someone asks you to install or add something you do not already know - by name, by purpose, or by what it will hold - say plainly that you are looking it up first, find out what it is and what it does with credentials, and state what you learned in your reply BEFORE the card appears. A person reading "Add X?" must already have read, in your own words, what X is. Refusing to act blind is part of being trusted with keys.

An offer is setup, never authority: it does not replace a grant, write permission, target-branch confirmation, or the merge gate, and it never needs a raw credential in chat. You never pair a tool yourself and never ask anyone for a key value; once a tool is added, provisioning happens inside it and receipts reach the person through the tool's own status message.

Keys belong to the human who provisioned them. Your owner's keys serve whoever asks; another person's keys need that person's private scoped approval before you use them for anyone else, and your owner cannot authorize them. Use the connector without exposing or sharing raw keys. The Workbench page remains the place a person manages tools and keys by hand (Settings → Workbench); you point there to MANAGE what exists, not to add what you need.

## Connect an app

When a request needs an app or service, call beeline-agent \`workbench_status\` first. For a connected app, use its ID with \`list_app_tools\`, then call \`execute_app_tool\` with the selected tool slug and arguments. The server executes against that person’s account and decides permission on every call. An empty tool list or \`needs_connection\` means the account must be reconnected; \`needs_permission\` means wait for the connected person's decision. Do not switch paths after denial or provider unavailability. No app token, provider key, or sign-in URL belongs in chat or a model prompt.

For an app that is not connected, call \`connect_app\` with its name, one short reason, and a request-specific \`continuation\`: one sentence stating what you will do right after sign-in. Do not include a link, credential, account identifier, or private data in that sentence. The server chooses the route and returns \`next\`. In a corner, call it from that corner so the sign-in card and connection wake return there. A managed OAuth app presents a sign-in card to its owner; end the turn and wait for the connection wake. If the provider reports managed OAuth unsupported, follow the server's Squire route and its instructions. A provider outage is unavailable, not permission to change routes. After the person connects, read Workbench again and use the app ID. Trusty Squire handles the separate API key and browser routes; never ask for a raw key in chat. Every use is authorized as \`app:<key>\` and recorded once.

## Showing a mock

When a design decision needs eyes, show it instead of describing it. Build ONE self-contained HTML page and post it with beeline-agent post_artifact (mime "text/html", pass the document as html). Everything is inline: a single <style> element for all CSS and data: URLs for any image - no script, no external dependencies, no network references. The validator refuses every <script>, <link>, <iframe>, <object>, <embed>, <form>, inline event handler, and http(s) URL, so a page that reaches for the network never posts. Use the Obsidian Refined tokens: grayscale surfaces, one brass accent #d7af5f, 3px radii, IBM Plex Sans/Mono type. Lay the user stories out as frames - one bordered, labelled block per story, so each story can be judged on its own. After posting, ask for feedback here in the corner: the artifact is the thing people react to, not your prose.

## Showing a photograph

When the mock needs a real product photo, do not draw an SVG stand-in. Call beeline-agent fetch_image with the photo's http(s) URL. The daemon downloads it (30 seconds, 25 MB) into your writable session home and returns the path, mime, and size. Read those bytes, base64-encode them, and put them in the HTML as a data: URL (\`<img src="data:image/jpeg;base64,…">\`). Then post_artifact as usual. The validator still refuses every http(s) image reference — the photograph has to be inline. The artifact is a snapshot: it never fetches the network when someone opens it.
`;
}

export function beelineReviewSkillMarkdown(releaseId: string): string {
  return `---
name: beeline-review
description: Review a corner pull request against the brief's spec, its checklist, the approval quote, and the Beeline merge gate.
---

<!-- beeline-release: ${releaseId} -->

# Beeline pull-request review

Follow these steps in order. Do not skip or reorder them.

## 1. Isolate the revision

- Run \`gh pr view N --json headRefOid,files\` and record \`headRefOid\`.
- Run \`gh pr diff N\`.
- Review the objective, files, and complete PR diff before making another working copy.
- Check out that exact head only when an empirical command must read or run the tree. Never use the author's worktree.
- When a checkout is needed, create a temporary detached worktree, install an EXIT trap that removes it with \`git worktree remove --force\` and deletes its temporary directory, and run every command there. Cleanup is mandatory on PASS, FAIL, and command error.
- For a deterministic one-shot bootstrap use \`npm run review:exact-head -- <sha> [--typecheck <pkg> …] [--] <pkg>:<glob> …\`: it checks that exact head out, runs \`npm ci\`, builds the workspace package exports, runs the given typechecks and targeted tests with non-interactive PASS/FAIL summaries, and removes the worktree itself (pass \`--keep\` to keep it and print the removal command).
- Review and test only the recorded revision. If the head moves, clean up the scratch worktree and start over.

## 2. P0 - SPEC AND CHECKLIST FULFILLED, DEMONSTRATED

Read the server-assigned brief and its current revision, including every required file. Quote the approval with its message ID and approver before considering the short objective. The spec's checklist is the scope, and the approval quote is the human's own words: it wins any conflict with the spec. The short objective is navigation-only text and the PR description cannot add, remove, or narrow scope. A revision with no recorded approval is reviewed against its spec alone. If a required file is unavailable, or the revision changes during review, refuse approval and describe what is missing. A requirement may become out of scope only through a new human-authorized brief revision; reviewer discretion, implementation difficulty, and silence never remove it. A passing narrow test does not prove a broader requirement. Review a deliberate human choice as written, even if it is unusual.

Before general correctness, produce a checklist ledger in spec order. List every checklist line exactly once as met, unmet, unverified, or out of scope, followed by concrete evidence. Any missing, unmet, or unverified line blocks PASS. Out of scope is valid only when the current revision itself records the human-authorized removal.

Before judging the implementation, independently repeat the two judgment legs from request triage:

- **Work warranted:** For a bug, reproduce the reported behavior on the target branch. For another request, establish the unmet user need from the request and current product. Search current code, history, issues, and open or recently merged pull requests for work that already resolves or supersedes it. Treat title similarity only as a candidate, not proof of duplication. FAIL confirmed duplicate or obsolete work.
- **Desirable:** Check repository-owned goals, invariants, architecture, and established product behavior. Require a concrete user benefit, the smallest coherent solution, and no unapproved scope. FAIL a confirmed conflict or an unsupported product judgment; put merely plausible concerns below as non-blocking findings.

- Quote the approval text, with its message ID, exactly as stored. Do not quote the short objective as product truth.
- Derive the end-user story from the spec and the approval quote in one sentence: \`a user who does X sees Y\`.
- Make Y happen against the built PR head: run the app or affected service and perform X.
- If no interactive surface is reachable, run the narrowest test or script that exercises the exact user path and prints the observable Y.
- Record the command and the observed Y.
- A unit test of an inner function, a log line, \`the code looks right\`, or any other proxy does not count.
- If the user-visible Y cannot be produced, FAIL now. Nothing below can rescue the review.
- For a bug, if a \`Reproduction <id>\` was recorded, quote it, re-run that exact user path on the PR head, and record that the wrong result is gone. FAIL if that proof does not name the identifier, even when other tests pass. If none was obtained, require the proof to say so plainly and show the regression instead; do not fail the review for a missing identifier.
- State whether the diff meets every checklist line and the approval quote without unapproved scope.

## 3. Empirical pass second

Build one visible validation record for the brief revision and code head. Assess intent, base synchronization, independent review, tests, documentation, lint and types, publication, CI, and final Beeline authorization. Each applicable stage is pending, running, passed, failed, skipped, or not applicable, with a reason for the last two. A required skipped, failed, or unverified stage blocks PASS. An empty CI rollup is not proof of passing checks. Reuse valid author evidence; run targeted independent checks where needed. A screenshot or rendered app is needed for visual claims, and server-boundary behavior for authorization claims.
Use record_validation_stage for each assessed stage, naming the current brief revision and exact PR head.
${VALIDATION_STAGE_OWNERSHIP}
The record informs the verdict but never replaces approve_merge or pr_checks_status.

- Run the repository typecheck and tests touched by the diff.
- If the spec or the approval quote names a user path, exercise that path.
- Record every command and exit code.
- A review with no executed command is invalid and must FAIL.

## 4. Adversarial pass

- For every changed function, name one concrete input or sequence that breaks it.
- If none is found, write \`none found\` for that function.

## 5. Verify before reporting

- Confirm every finding by reading the exact line or by running a command.
- Put unconfirmed concerns under plausible findings. They never block.

## 6. Bloat guard

- Compare net lines with the spec, its checklist and non-goals, and the approval quote.
- FAIL backwards-compatibility shims, dual paths, feature flags, or abstractions with one caller.
- FAIL machinery the spec and the approval quote did not ask for.

## 7. Security and data

- Check credentials, authorization boundaries, and destructive migrations.

## 8. Gate and verdict

- Review the exact green head named in your reviewer instruction. If the head moved, do not approve it.
- Re-read the assigned brief revision before the verdict. A repair changes the head and invalidates affected evidence; a requirement correction invalidates the relevant verdict even if code did not change. Keep product-completeness findings (a missing or contradicted checklist line or approval quote) separate from engineering findings (correctness, security, maintainability, tests). Give every confirmed finding a stable ID that survives rereview, the affected checklist line or \`engineering\`, location, severity, evidence, and repair disposition. Reuse the same ID until that finding is resolved. Mechanical repairs return to the author; ask a human only for a genuinely unresolved product choice. Do not run a nested validation pipeline or push the author's branch.
- Always use this exact verdict shape:

\`approval quoted with its message ID:\`
\`user story:\`
\`work warranted evidence:\`
\`desirability evidence:\`
\`reproduction id (or none obtained):\`
\`proof of that reproduction (or none obtained + regression):\`
\`how Y was demonstrated (or FAIL):\`
\`commands run + results:\`
\`brief revision:\`
\`checklist ledger (every checklist line + status + evidence):\`
\`validation stages and evidence:\`
\`product-completeness findings (block):\`
\`engineering findings (block):\`
\`plausible findings (do not block):\`
\`net lines:\`
\`decision: PASS|FAIL\`

Then take exactly one action:

- FAIL: call \`record_validation_stage\` with stage \`review\`, status \`failed\`, and the reviewed head SHA, then reply \`@author\` with the confirmed findings and that reviewed head SHA to fix. The recorded review stage is how an implementer who has already fixed the findings can tell whether the review is stale.
- PASS: call \`approve_merge\` with the reviewed head SHA and assigned briefRevision (omit the revision only for a legacy corner without a brief), then reply \`approved <reviewed sha>\` without tagging the author. Do not tell the author to merge.
- Approving is your last step as reviewer. The server squash-merges that exact head once checks are green, the worker's yolo is on, and no human hold stands. Neither you nor the author merges it.
`;
}

export function beelineSpecSkillMarkdown(releaseId: string): string {
  return `---
name: beeline-spec
description: Prepare or revise a durable corner assignment from Room decisions before repository work. Do not use for ordinary conversation or unrelated artifact delivery.
---

<!-- beeline-release: ${releaseId} -->

# Durable corner brief

Create an assignment a fresh session can execute without the parent transcript. A brief has three parts:

- \`spec\`: one Markdown doc you write, with these headings:
  - \`## Intent\`: the human's own words, quoted exactly, each with its Room message ID. Never substitute a summary.
  - \`## Checklist\`: observable done items, one per line. Keep unaffected lines as they are across revisions.
  - \`## Non-goals\`: explicit exclusions.
  - \`## References\`: each reference or mock with what it is and whose call it is. An optional or agent-generated mock is not styling authority unless a human made it so.
  Add implementation guidance under further headings when it helps.
- files (\`attachments\`): the Room files the worker needs, each with its purpose and whether it is required.
- \`approval\`: one human Room message ID. The server quotes that message's exact text and author; the quote wins any conflict with the spec.

Do not infer approval from silence, assent to different prose, or the mere existence of a plan. Keep agent recommendations labelled as recommendations. Do not promote a plausible UX detail, algorithm, failure message, or extra test into a checklist item merely because it sounds helpful.

## Compact path for a settled small fix

Use this when the requested behavior, touched surface, exclusions, and proof are already obvious. Inspect the narrow current behavior, write a short spec (quoted intent, observable checklist, non-goals, references), and use the initiating command as the approval. Dispatch without a proposal/go ceremony. “Change the message action label from Remove to Delete; leave confirmation and accessibility wording unchanged” needs the visible-label checklist line and both exclusions, not another confirmation question.

## Complex-work planning loop

Use this default-on loop when work crosses components, changes architecture or authorization, needs a visual choice, has multiple user stories, or still contains a material unknown.

### 1. Scope and current state

- Collect every relevant human message, including corrections; later corrections supersede only what they explicitly change. Quote their exact text and IDs under \`## Intent\`.
- Inspect current code, data contracts, tests, recent related work, repository invariants, and existing behavior. State what exists, what is missing, and what is deliberately out of scope.
- Separate facts, human decisions, agent recommendations, and unresolved choices.

### 2. User stories and product boundary

- Write the actor/action/observable-result stories.
- Map each story to one or more checklist lines and explicit non-goals.
- If one unresolved choice would materially change behavior, scope, irreversible effects, or the intended result, present only that choice or the affected brief slice to the human. Use the answering message as the \`approval\`. Never treat no answer as approval.

### 3. Architecture and data flow

- Trace inputs, authorities, state transitions, persistence, outputs, and trust boundaries.
- Name the existing components to reuse and the smallest coherent changes.
- Describe migration and compatibility behavior only where the human intent or existing data requires it.

### 4. Failure modes and test map

- Enumerate missing/stale data, retries, concurrency, partial failure, authorization failure, rollback, and boundary-specific hazards that apply.
- Map every checklist line to its proof boundary: unit, integration, device/browser, server authorization, migration, or live harness. No line may be left without planned evidence.

### 5. Mocks and references

- When a visual or interaction decision needs eyes, create and post one self-contained mock using the using-beeline mock procedure.
- A mock/file posted with \`post_artifact\` in this planning turn is added automatically to the brief attachment manifest; do not manually copy its object ID. Still list it under \`## References\` with whose call it is. Existing human-posted files must be named explicitly in attachments.

### 6. Implementation tasks

- Synthesize ordered, independently verifiable tasks. For each task name the affected boundary, checklist lines, expected files/components, failure handling, and proof.
- Keep the spec actionable, not a transcript summary.

### 7. Bounded adversarial second read (default on)

- Spend one pass, bounded to the drafted scope, trying to disprove completeness: find a missing story, authority mismatch, unhandled failure, checklist line without proof, mock ambiguity, accidental scope expansion, or task-order hazard.
- Return findings to the planning agent and repair the draft. Escalate only a genuinely material product choice to the human; engineering choices and mechanical gaps are resolved in the plan.
- End after one adversarial pass unless its repair exposes one new material product choice. Do not recursively review the review.

## Dispatch and revision

Existing authorization permits dispatch when the initiating command already settles the exact material scope; that command is the approval. Drafting a brief does not create approval. When the scope was not already explicit, post the spec and ask the corner's opener to approve it, then use their reply as the \`approval\`. Honor an explicit request to review first.

Pass the brief as \`open_corner.brief\`. Read the current revision before revising and use \`revise_corner_brief\` with the complete replacement spec, the approving message, and a concise change description. Preserve unaffected intent quotes, checklist lines, and references. The latest revision governs implementation and review; chat prose alone never changes scope.
`;
}

export function beelineTriageSkillMarkdown(releaseId: string): string {
  return `---
name: beeline-triage
description: Clarify and assess a user request before opening a Beeline corner, then bind a bugfix to its recorded reproduction. Use before open_corner and while implementing a bug in a corner.
---

<!-- beeline-release: ${releaseId} -->

# Beeline request triage

Run these checks before opening a corner.

## 1. Is it clear?

- Rewrite the request as a concrete outcome and a checklist of what done means.
- State material exclusions needed to prevent unrequested work.
- Keep the corner objective complete and within 24 words.
- If an ambiguity could materially change the outcome, ask one focused question before opening the corner.

## 2. Is work warranted?

- For a bug, try to reproduce the exact user-visible behavior and record the evidence.
- For another request, identify the unmet user need and the current behavior that does not meet it.
- Search current code, history, issues, and open or recently merged pull requests for released or unreleased work that resolves or supersedes the request.
- Treat similar titles as candidates. Confirm behavior and scope before calling work duplicate.
- If the need cannot be established, reproduction fails, or other work may obviate it, warn; do not block.

## 3. Is it desirable?

- Compare the request with repository-owned goals, invariants, architecture, and established product behavior.
- Look for concrete user benefit, the smallest coherent solution, and ongoing maintenance cost.
- Do not invent product strategy. If the evidence is absent or conflicting, warn; do not block.

## Output

When dispatching work, pass the complete brief to open_corner under existing authorization. Ask a focused question first only for a material unresolved choice. Add applicable warnings to the brief:

\`Triage warning — warranted: <evidence-backed reason>\`
\`Triage warning — desirable: <evidence-backed reason>\`

When a bug reproduction succeeds, also emit:

\`Reproduction <id>: <user path> → <observable wrong result>\`

Do not emit a warning merely because evidence is incomplete when the repository offers no practical way to obtain it. Never describe a warning as approval or rejection. Warnings inform the user and implementer; they do not block work.

## Bugfix execution

Once a corner is open for a reported bug, follow these steps in order. They are instruction, not a server gate. They do not condition the fix on reproduction. Warranted-work and desirability warnings still do not block.

### 1. Attempt to reproduce

- Attempt to reproduce the bug as triage isolated it, using every tool the host offers: emulator, Playwright, browser, test runner.
- Record what was tried and what was observed.
- If a reproduction is obtained, record the exact user path and the observable wrong result under \`Reproduction <id>\`. Reuse the identifier triage emitted when it recorded one.
- If reproduction fails, warn and continue exactly as triage already does. Never stop. Never condition the fix on reproduction.

### 2. Narrow fix

- Narrow the fix to the reported behavior.
- When a reproduction exists, change only what removes that recorded reproduction.
- Nearby improvements stay out of scope.

### 3. Proof matching triage

- When a reproduction exists, re-run it, cite the same identifier, and show it now passing, plus the regression that would fail if the bug returned.
- When none was obtained, state that plainly and show the regression instead.
- Name the identifier in the pull request when one exists so the reviewer can check that proof, not merely that some test exists.
`;
}
