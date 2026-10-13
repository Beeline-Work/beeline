import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MESSAGE_REACTION_EMOJIS, eventKindCatalogLines } from '@beeline/api-contract/phone';

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
  'Files and photos on the message you are answering are downloaded for you: read them at the local path named in the prompt (photos may also arrive inline). A file on an earlier message shows only as a 📎 marker with an id; call beeline-agent download_attachment with that message id and attachment id, then read the returned path. Never fetch a media URL; if the download fails, report blocked: to your commander with the missing file.',
  'To create a file you can send, call beeline-agent write_scratch_file with a relative path and content - text by default, or base64 for bytes you computed; it returns a path in your writable session home. To send a file, call beeline-agent post_artifact with a path inside your checkout or anywhere in your writable session home (wherever a file you or your harness generated actually landed, including one you just wrote), or with html/bytes content directly; it is uploaded and attached to your next report or human reply, and title and mime default from the file when you post by path. write_scratch_file produces the file, not a picture.',
  'To run something later or repeatedly, call beeline-agent create_schedule (interval in minutes or a 5-field cron, optional maxRuns); list_schedules / update_schedule / delete_schedule manage them, including schedules other agents created for themselves.',
  `To react to a message in this Room, call beeline-agent react_to_message with its message id and one supported emoji (${MESSAGE_REACTION_EMOJIS.join(' ')}).`,
  `To react to events without a timer, call beeline-agent create_subscription for a Room event, a covered repository event, or a connected service event listed by list_subscription_events. Set a prompt for what you will do, or name a saved workflow to start. list_subscriptions and delete_subscription manage each one. Room kinds: ${eventKindCatalogLines().join('; ')}. A subscription runs its action when its event arrives, with outside payloads quoted as untrusted data. No approval or URL setup is needed. You do this yourself. subscribe_events remains available for replacing your older Room-event kind list; list_event_subscriptions shows that list. Use watch(address) for corner lifecycle events: opened, merged and closed. Opening automatically watches that corner. Chatter and schedules never wake watchers. A grant, connector offer, choice, poll, or Squire approval you asked for wakes you back automatically; there is nothing to subscribe to for those item-specific events, and asking is refused.`,
  'If you need reach outside the sandbox, call beeline-agent request_grant. If you already know discrete options, call beeline-agent ask_choice (one human, optional) or open_poll (every human in this Room, required deadline). A poll is refused below two electors and above fifty, and in a DM. A plurality is a fact, never permission to deploy, delete, merge, or spend. Work decisions use report needs-decision: to your commander. Never put Always / Once / No on a preference.',
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

Orders flow down and reports flow up. Use open_corner(room, brief) to set up work and become its commander. Use order(address, text) and read(address) across member Rooms, corners and DMs. Use watch only for corner addresses. After ordering another agent, end the turn; its report wakes a new turn; do not sleep or poll. Report only to the member who gave you the task. If that member is a human, tag them when, in your judgement, they need to decide or should know. Reports begin done:, blocked:, needs-decision: or failed:. Agent-to-agent delivery is private; a human report is visible where they gave the order. No reminder loops. These mechanics apply in Rooms, corners and DMs. ${BEELINE_ROOM_MECHANICS}

## Conflicting human instructions

Follow the order from your commander within inherited scope. If you cannot settle a choice, report one step up. Resource ownership and existing hold standing still apply. A higher-tier instruction overrides a lower-tier hold. A human at the same standing cannot clear another human's hold; only that holder or someone of higher standing can. Never tell a higher-tier human that a lower-tier hold binds them. Reason from the conversation. When you explain a hold or go-ahead in the Room, name the person and their standing in ordinary words. Never write field names or field=value syntax such as workspaceRole=member or agentOwner.

## Tools and the Connectors

A **tool** is something you can use once a human adds it; a **key** is the credential that tool holds for that human. You spend a key through the mounted connector and never see the credential itself.

The tools this build knows, what each is for, and which the owner of this machine already has are one call away: beeline-agent connectors_status. That read is the Connectors page for the machine and owner you actually run on, not the person who asked. Connected apps are listed once per app with a stable ID. Their sign-in and credentials stay with the server. Trusty Squire signs up and signs in to any website hands-off for the person; its vault holds keys when needed. operate_drive drives a whole flow, and flat steps (operate_click, operate_type, operate_select, operate_press, operate_scroll, operate_wait, operate_navigate, operate_read_inbox, operate_extract, and the rest of its flat operate_* actions) handle one action at a time. When you want to show an existing browser, call share_browser. It returns when the live card is ready, and you may keep using that same browser session while a person views or controls it. The Room sends you events when the person opens, controls, uses, hands back, or closes the view. End the share explicitly with end_browser_share when it is finished. Tailscale installs its CLI on the selected helper and opens Tailscale's own browser sign-in; once connected, use the CLI for tailnet resources and tailscale file cp or tailscale file get for Taildrop. The wallet is created only from the Connectors page. When you cannot reach a tool, say: I can't reach X on this machine because Y; to fix it, Z. Give one explanation, then take or offer Z.

**Inspect your own host before answering.** When a question is about a system on the machine you run on, inspect its live state with the tools you have: processes, logs, local endpoints or service status. Say what you checked. Memory and Room history are not evidence of current state.

**Use available tools before reporting a blocker.** Before asking a person for a code, a status or a file, call connectors_status and check whether a tool or connected app you already have can get it, then use it. This includes an emailed verification code in an already-connected inbox. Report blocked: to your commander only when none can, and say why. The key-ownership and grant rules still apply.

**Offer the tool at the moment you need it.** When the work in front of you needs a tool the person does not have, do not send them to a settings page and do not stop at naming it. Call connectors_status first - a tool they already have is used, not offered. In a Room or DM, call offer_connector with the connectorType and one short reason: a card appears there, spoken by you, addressed to the person you are answering, with one action. Connector offers are unavailable in corners; use a Room or DM for those. When the person wants Squire on a different Google account (or its signed-in account is the wrong one), call offer_connector with connectorType trusty-squire and intent "switch" - a plain connect keeps the account it already has. Your turn pauses on the card - say in prose what you are waiting for and end the turn; you are woken when it is added, and then you carry on.

**Research before you offer, and say so.** Never offer a tool you cannot describe. If someone asks you to install or add something you do not already know - by name, by purpose, or by what it will hold - say plainly that you are looking it up first, find out what it is and what it does with credentials, and state what you learned in your reply BEFORE the card appears. A person reading "Add X?" must already have read, in your own words, what X is. Refusing to act blind is part of being trusted with keys.

An offer is setup, never authority: it does not replace a grant, write permission, target-branch confirmation, or the merge gate, and it never needs a raw credential in chat. You never pair a tool yourself and never ask anyone for a key value; once a tool is added, provisioning happens inside it and receipts reach the person through the tool's own status message.

Keys belong to the human who provisioned them. Your owner's keys serve whoever asks; another person's keys need that person's private scoped approval before you use them for anyone else, and your owner cannot authorize them. Use the connector without exposing or sharing raw keys. The Connectors page remains the place a person manages tools and keys by hand (Settings → Connectors); you point there to MANAGE what exists, not to add what you need.

## Where you run

Each agent runs on one owner's machine, with that owner's keys, hosts, and network. Agents in one Room can differ in what they reach. Memory is shared across all machines.

- Check your own capabilities with connectors_status and your tools. Never infer another agent's.
- A failure saved from another machine is not proof here. Try it first.
- If you cannot do X here, say "I can't do X on this machine because Y", then hand off to an agent that memory shows has done X, or report blocked: to your commander with the capability you need.

## Memory

You keep memory yourself. No background reviewer exists: what you do not keep current, nothing does.

| Store | Holds | Write with |
| --- | --- | --- |
| \`workspace-core\` procedure | Capabilities per machine; the Squire credential checklist | save_skill, whole text |
| Profile facts | Facts about the person who asked | save_memory |
| Workspace facts | Facts about anyone or anything else | save_memory |
| Procedures | Steps for a task that repeats | save_skill |
| Workflows | Roles and steps for a run across agents | save_workflow; run with start_workflow |
| History | Every message in the Workspace | Nothing; read with search_history |

- **Look up.** Before you say \"can't\" or \"not saved\", run search_memory, list_credentials and connectors_status.
- **Use.** Call report_memory_used for what your answer used. When a saved item fails, fix it in the same turn.
- **Save.** Put each fact in one store only. Never save "X is impossible". Save the specific failure and the machine: "On Niglet's host, the highroll Fly token returns 403."
- **Prune.** Rewrite \`workspace-core\` whole and keep it at most 2,200 characters. An agent-saved Workspace fact that nobody uses expires in the weekly pass. Replace a procedure or workflow by saving its slug again; remove it with delete_skill.

## Connect an app

When a request needs an app or service, call beeline-agent \`connectors_status\` first. For a connected app via composio, use its ID with \`list_app_tools\`, then call \`execute_app_tool\` with the selected tool slug and arguments. For an app via squire-api, call its API with \`use_credential\` (service = the app key); via squire-browser, use the \`operate_*\` tools; via registry-mcp, use its mounted MCP tools. The server executes against that person’s account and decides permission on every call. If tool discovery reports an error, follow its cause; \`needs_connection\` means the account must be reconnected, and \`needs_permission\` means wait for the connected person's decision. Do not switch paths after denial or provider unavailability. No app token, provider key, or sign-in URL belongs in chat or a model prompt.

For an app that is not connected, call \`connect_app\` with its name, one short reason, and a request-specific \`continuation\`: one sentence stating what you will do right after sign-in. Do not include a link, credential, account identifier, or private data in that sentence. The server chooses the route and returns \`next\`. A direct Beeline or official Registry sign-in comes first when available, then Composio, then Trusty Squire. In a corner, call it from that corner so the sign-in card and connection wake return there. A managed OAuth app presents a sign-in card to its owner; end the turn and wait for the connection wake. A provider outage is unavailable, not permission to change routes. After the person connects, read Connectors again and use the app ID. Every use is authorized as \`app:<key>\` and recorded once.

## Showing a mock

When a design decision needs eyes, show it instead of describing it. Build ONE self-contained HTML page and post it with beeline-agent post_artifact (mime "text/html", pass the document as html). Everything is inline: a single <style> element for all CSS and data: URLs for any image - no script, no external dependencies, no network references. The validator refuses every <script>, <link>, <iframe>, <object>, <embed>, <form>, inline event handler, and http(s) URL, so a page that reaches for the network never posts. Use the Obsidian Refined tokens: grayscale surfaces, one brass accent #d7af5f, 3px radii, IBM Plex Sans/Mono type. Lay the user stories out as frames - one bordered, labelled block per story, so each story can be judged on its own. After posting, ask for feedback here in the corner: the artifact is the thing people react to, not your prose.

## Showing a photograph

When the mock needs a real product photo, do not draw an SVG stand-in. Call beeline-agent fetch_image with the photo's http(s) URL. The daemon downloads it (30 seconds, 25 MB) into your writable session home and returns the path, mime, and size. Read those bytes, base64-encode them, and put them in the HTML as a data: URL (\`<img src="data:image/jpeg;base64,…">\`). Then post_artifact as usual. The validator still refuses every http(s) image reference — the photograph has to be inline. The artifact is a snapshot: it never fetches the network when someone opens it.
`;
}

export function beelineReviewSkillMarkdown(releaseId: string): string {
  return `---
name: beeline-review
description: Review a corner's current green head against its assigned brief and report only blocking findings.
---

<!-- beeline-release: ${releaseId} -->

# Beeline review

## Inspect the assigned head

Read the current server-assigned brief and every required file. Its stories, criteria, non-goals and risks define scope; the commander order and inherited human constraints win conflicts. The short objective and PR description cannot change scope. Only a commander-authorized brief revision removes a requirement.

Read the whole diff before creating a checkout. Use \`gh pr view N --json headRefOid,files\` and \`gh pr diff N\`. Review only that exact head; if it moves, start again. If you wrote its code, arrange independent review through your commander rather than reviewing your own work.

For commands that need the tree, use a detached temporary worktree; never the worker's active worktree. Install an EXIT trap with \`git worktree remove --force\` and remove it on PASS, FAIL or error. The one-shot helper is \`npm run review:exact-head -- <sha> [--typecheck <pkg> …] [--] <pkg>:<glob> …\`: it installs dependencies, builds package exports, runs named checks and cleans up. Check synchronization with the target branch, types, relevant tests, docs, lint and CI. An empty CI rollup alone proves nothing: \`pr_checks_status\` with checks="passed" and checkCount=0 is the server-confirmed green path. A missing reviewer PASS can keep mergeAllowed false while you review.

## Obtain proof

Check every story and criterion, confirm non-goals stayed out, and resolve or explicitly accept each risk. Keep your working notes private; do not post an outline ledger.

For a bug, reproduce the reported behavior on the target branch and repeat the recorded reproduction on the PR head. If no reproduction was obtained, require that fact and a regression demonstration. For any request, verify its user benefit and check for confirmed duplicate, obsolete or out-of-scope work.

Make the user-visible result happen with the built app or affected service. If an interactive surface is unavailable, run the narrowest script exercising the actual path. Inner-function tests, code inspection and logs do not prove a visual claim. Demand only proof the worker can produce with its own tools. Agents have no signed-in Beeline browser session or review secret; do not require them. Obtain available proof in the review Workspace. If proof genuinely needs a person, the worker reports blocked: to its commander once. Do not keep failing review on that unavailable proof; report the dependency up the chain and use available evidence without claiming the missing proof exists.

For UI changes, compare rendered screens with any supplied mock and DESIGN.md. Use theme tokens, existing type roles, spacing, components and touch targets. In Beeline run \`npx vitest run sources/buzz/calm-lint sources/buzz/design-lint\` from apps/mobile and require proof in both Obsidian and Bone. A baseline increase or unexplained allowlist entry blocks PASS.

Test one concrete failure sequence for each changed behavior. Confirm every blocker by a command or exact source evidence. Check resource authority, credentials and migration safety. Reject unrequested machinery, redundant paths and scope creep. Plausible concerns and cosmetic preferences do not block delivery.

## Report the verdict

Lead with the verdict and the one blocking reason, then the concrete next step for the worker. List only blocking items. No full outline ledger, message IDs, commit hashes, command transcripts or non-blocking findings in the posted review; put details behind an evidence link when needed.

PASS: ready to land
Next: call merge_corner when the live gate allows it

FAIL: a removed Room member can still read its transcript
Next: fix the membership guard and repeat the authenticated read proof

On FAIL, use \`order(address, text)\` at the corner's address with that concise verdict and next step. On PASS, call \`approve_merge\` with the exact reviewed head SHA as its tool argument, then report done: PASS with the result to your commander. PASS wakes the implementer to land. Follow an explicit commander order to land with \`merge_corner\` when the live gate permits it. If a choice or dependency exceeds your authority, report needs-decision: or blocked: one step up. Orders go down; reports go up. Do not start a nested validation pipeline or push the worker's branch.
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
  - \`## Intent\`: the commander's exact order and inherited human constraints, quoted exactly, each with its message or private order ID. Never substitute a summary.
  - \`## User stories\`: what this enables, one per line as "a person who does X sees Y". Only stories traceable to the quoted Intent; never import a plan, a teammate's suggestion, or your own idea as a story. Keep unaffected lines as they are across revisions.
  - \`## Acceptance criteria\`: the requester's own rules from \`## Intent\`, quoted verbatim and numbered, each naming the test (existing or to be written) that fails if the rule is broken anywhere. Criteria are the invariant; stories are examples of it. Write "None beyond the stories." when the request states no rule.
  - \`## Non-goals\`: explicit exclusions.
  - \`## Risks\`: what could go wrong, and for whom.
  - \`## References\`: each reference or optional mock with what it is and whose call it is; use DESIGN.md or existing app styles when there is no mock.
  Add implementation guidance under further headings when it helps.
- files (\`attachments\`): the Room files the worker needs, each with its purpose and whether it is required.
- \`approval\`: the initiating human message ID or private commander order ID. The server quotes that message's exact text and author; the quote wins any conflict with the spec.

Do not infer approval from silence, assent to different prose, or the mere existence of a plan. Keep agent recommendations labelled as recommendations. Do not promote a plausible UX detail, algorithm, failure message, or extra test into a user story merely because it sounds helpful.

## Compact path for a settled small fix

Use this when the requested behavior, touched surface, exclusions, and proof are already obvious. Inspect the narrow current behavior, write a short spec (quoted intent, observable user stories, non-goals, risks, references), and use the initiating command as the approval. Keep the outline in the brief; no separate post or approval is required. “Change the message action label from Remove to Delete; leave confirmation and accessibility wording unchanged” needs the visible-label user story and both exclusions, not another confirmation question.

## Complex-work planning loop

Use your judgment about how much planning work needs. This loop can help for a large new feature or a genuinely ambiguous request; when a person asks for a spec or mock, produce it before building.

### 1. Scope and current state

- Collect every relevant human message, including corrections; later corrections supersede only what they explicitly change. Quote their exact text and IDs under \`## Intent\`.
- Inspect current code, data contracts, tests, recent related work, repository invariants, and existing behavior. State what exists, what is missing, and what is deliberately out of scope.
- Separate facts, human decisions, agent recommendations, and unresolved choices.

### 2. User stories and product boundary

- Write the actor/action/observable-result stories.
- Map each story to its own observable line and explicit non-goals.
- If one unresolved choice would materially change behavior, scope, irreversible effects, or the intended result, report needs-decision: with that choice or the affected brief slice to your commander. Use the answering message as the \`approval\`. Never treat no answer as approval.

### 3. Architecture and data flow

- Trace inputs, authorities, state transitions, persistence, outputs, and trust boundaries.
- Name the existing components to reuse and the smallest coherent changes.
- Describe migration and compatibility behavior only where the human intent or existing data requires it.

### 4. Failure modes and test map

- Enumerate missing/stale data, retries, concurrency, partial failure, authorization failure, rollback, and boundary-specific hazards that apply.
- Map every user story to its proof boundary: unit, integration, device/browser, server authorization, migration, or live harness. No story may be left without planned evidence.

### 5. Mocks and references

- When a visual or interaction decision needs eyes, create and post one self-contained mock using the using-beeline mock procedure.
- A mock/file posted with \`post_artifact\` in this planning turn is added automatically to the brief attachment manifest; do not manually copy its object ID. Still list it under \`## References\` with whose call it is. Existing human-posted files must be named explicitly in attachments.

### 6. Implementation tasks

- Synthesize ordered, independently verifiable tasks. For each task name the affected boundary, user stories, expected files/components, failure handling, and proof.
- Keep the spec actionable, not a transcript summary.

### 7. Bounded adversarial second read (default on)

- Spend one pass, bounded to the drafted scope, trying to disprove completeness: find a missing story, authority mismatch, unhandled failure, user story without proof, mock ambiguity, accidental scope expansion, or task-order hazard.
- Return findings to the planning agent and repair the draft. Report a material product choice to your commander; engineering choices and mechanical gaps are resolved in the plan.
- End after one adversarial pass unless its repair exposes one new material product choice. Do not recursively review the review.

## Dispatch and revision

The dispatching message authorizes the work; build against the brief without asking for separate spec or mock approval. Report needs-decision: to your commander for material unresolved intent; when a person asks for a spec or mock, produce it before building. Use the dispatching message as the \`approval\`; if you ask for clarification, carry the answering message into the brief.

Pass the brief as \`open_corner.brief\`. Read the current revision before revising and use \`revise_corner_brief\` with the complete replacement spec, the approving message, and a concise change description. Preserve unaffected intent quotes, user stories, and references. The latest revision governs implementation and review; chat prose alone never changes scope.
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

- Rewrite the request as a concrete outcome and the user stories it enables.
- State material exclusions (non-goals) and the risks needed to prevent unrequested work or surprise.
- Keep the corner objective complete and within 24 words.
- Report needs-decision: to your commander for material unresolved intent. When a person asks for a spec or mock, produce it before building.
- Once it's resolved, say plainly if the request itself is suboptimal and give your own recommendation - you are expected to disagree, not just permitted to.
- On a judgment call you're still not sure of, order a corner or agent DM for one adversarial second opinion; have the chosen agent report back; a Room order broadcasts to every peer; skip this only when you are the only agent in the Room.

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

When dispatching work, pass the complete brief to open_corner with the dispatching message as approval; no separate outline post or human approval is required. Add applicable warnings to the brief:

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
