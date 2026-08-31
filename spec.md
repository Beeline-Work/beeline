# Buzzy — watch a coding agent work, together

A good Buzz mobile client that does the one thing today's Buzz clients can't:
let several people watch and steer a coding agent as it actually works. That's
the whole product. Everything below is how it differs from an ordinary Buzz
mobile client.

## The shape
- **Top-level channels (TLCs)** a user provisions. Some wrap a **git repo** —
  either specified by the user when the channel is created, or created by the
  agent in the course of its work.
- In a TLC the agent is **read-only**: it converses, ideates, and plans with the
  members in normal chat. It cannot touch files here.
- When the agent is about to **create or change files**, a **subchannel** opens
  under the TLC — a coding session that looks like a Happy session, except the
  **same members from the parent channel are all in it**, watching the agent and
  sending it comments and commands.
- The subchannel is backed by a **git worktree**. Edit-mode exists only there.
- The **merge is the parent channel owner's call** (whoever Buzz designates —
  relay owner or channel owner; we defer to Buzz's permission model). The agent
  does not merge itself.
- On merge: the worktree merges into the parent repo, a **summary of the agent's
  work posts to the parent channel**, and the subchannel is **archived read-only**
  as the historical record.
- **The subchannel *is* the PR.** The whole multiuser session — the conversation,
  the agent's actions, the diffs, the merge — is the pull request.

## Why Buzz, not a standalone Happy fork
Multi-member channels, signed identities, and git hosting are already Buzz. We
fork **Happy's mobile client** (`slopus/happy`, Expo/RN, MIT) for its polished
session/permission surface — but Happy is single-user, so the core work is making
a session belong to a **channel**, not one account, so every member sees and
drives it. The merge being a human's call, relay-enforced, is Buzz's — we use
Buzz's primitives, we don't build merge enforcement.

Buzz's own mobile app isn't viable (no push notifications, agent surface is just
transcript-in-thread).

## Read-only → edit is a real boundary, not a prompt
In the TLC the agent's write tools are **disabled**. A request to create or mutate
files is exactly what opens the subchannel + worktree. The permission boundary is
the mode boundary.

## Build order — client-first, on real Buzz from line one
The spine is already proven (P0 gate ran live: agent can't push the protected
branch, human approval lands it). So the remaining unknown is the client. Build
it against **real Buzz** — the local relay-stack + real `buzz-agent` — never a
fake backend. Real Buzz only speaks channels, keys, and async approval, so it's
impossible to bake in single-user assumptions; the backend *is* the seam.

- **P1 — the forge surface, on real Buzz.** Fork Happy's mobile client. Join a
  channel **with a key**, converse with a read-only agent in a TLC, open a
  **subchannel + worktree** when the agent goes to edit files, watch it work, and
  have **multiple participants** send it commands in that subchannel. Identity +
  transport + channel-scoped sessions are real from the start because you can't
  join a channel without them. Discipline to the ~10 methods Buzz backs; stub
  terminals (no live PTY).
- **P2 — merge controls + provenance + onboarding.** Surface the (already-proven)
  merge gate in the UI: the parent-owner **Approve** action, the "sent for
  approval → merged/rejected" async states, the summary-to-parent + subchannel
  archive. Attribution/provenance of who (which key) did what. Onboarding flows
  for humans and agents into a channel.
- **P3 — beyond coding.** Content, video editing, other modality pipelines. Note:
  needs a non-git artifact+merge model — "subchannel = PR" assumes git today.
- **Throughout — push notifications + the failure-mode tests below.**

## Out of scope
Formal roles/reviewers beyond parent-owner-merges, workflow pipelines,
multi-agent, applets, desktop, auto-deployed remote agents.

## Google-first identity binding security invariants

Google/OIDC is an onboarding and account-discovery proof around a Nostr key;
it is not a second authorization system. The binding service may learn only a
public key and signed events. It never receives, stores, derives, or remotely
controls the user's Nostr secret.

- OIDC never authorizes relay HTTP or WebSocket access, membership, roles, or
  merges. Relay HTTP remains NIP-98, relay WebSockets remain connection-bound
  NIP-42, and mutations and approvals remain signed Nostr events.
- An identity link is keyed by `(community, normalized issuer,
  client/audience, sub)`. Community is resolved from the request Host by
  trusted tenant configuration, never supplied by a request body. Email is
  non-authoritative metadata and is never an identity key.
- A normal bind is create-once and idempotent only for the same public key. An
  existing identity mapping cannot move to another public key without a
  separately specified, explicit recovery ceremony.
- The merge gate checks the self-signed registered-agent identity registry
  before checking Room roles and fails closed if that lookup fails. Binding an
  OIDC identity to an agent key does not make it human and cannot make it
  merge-eligible.
- A merge-capable human key is held on that person's device. Managed,
  custodial, or remotely controllable keys are ineligible as trusted reviewers;
  introducing one requires a separate non-custodial approval credential and a
  new security review.

## Honest risks
- **Still needs a computer** — the agent's body. Someone runs `buzz-agent` and
  pairs the phone (same "bring your own substrate" as Happy).
- **Happy's re-plumb is the real work** — single-user session → channel session
  is a rebuild, not a transport swap.
- **The merge guarantee rests on Buzz config** — the agent must be excluded from
  push-rights to the protected branch; add a provisioning check + test.

---

# Appendix — build reference

## What already exists in Buzz (reuse, don't rebuild)
- Git hosting (smart HTTP + NIP-34), npub-signed pushes — `api/git/`.
- Branch protection: `push-allowed`, `no-force-push` — `git_perms.rs`,
  `api/git/policy.rs`. **`require-approval` is NOT parsed/enforced — don't rely on it.**
- Repo↔channel binding — `api/git/binding.rs`.
- Workflow engine with a human-approval gate — `buzz-workflow/executor.rs:459`
  (`RequestApproval` / suspend-until-granted; kinds 46010/46011/46012). This is
  how "parent owner approves the merge" is implemented without new relay code.
- Agent harness — `buzz-agent` (ACP) + `buzz-dev-mcp` (shell/str_replace).
- NIP-OA scoped, revocable agent delegation.
- Relay APNS push gateway — `buzz-push-gateway` (Happy wires this; Buzz mobile doesn't).

## The merge, concretely (composed from the above — no new enforcement code)
- The agent isn't in `push-allowed`, so it physically can't push the protected
  branch (`git_perms.rs`).
- The only identity that lands the branch is a workflow whose merge step suspends
  on `RequestApproval` until it gets a grant signed by a **human** key (the parent
  owner, per Buzz's roles).
- **Approve** on the owner's phone emits that signed grant; the workflow merges,
  posts the summary, and archives the subchannel.

## Gotchas (hard-won — do not re-learn)
- **`kind:46011` is `KIND_WORKFLOW_APPROVAL_GRANTED`, a workflow kind — NOT a
  git-merge kind.** `require-approval` is not enforced in the git policy at all, so
  the merge is *composed* from branch-protection + the workflow gate, not built as
  new receive-pack code.
- **An accepted publish is not proof of effect.** A Buzz group-management event
  whose side effect fails is still stored and still OK-true'd. Assert on state, not
  the ack.
- If channel-scoped group-management events come into play: the **`h` tag must be
  a UUID** (Buzz drops non-UUIDs), and a **role rides in a separate `["role", …]`
  tag**, not NIP-29's `["p", pk, role]` slot. Both fail silently.

## Happy `RigTransport` adapter — the ~10 MVP methods
Against `buzz-acp/src/acp.rs` + git API; **every one scoped to channel membership,
not one account** (that scoping is the shared-session feature).

- **Sessions:** `sessionCreate` → `session_new` (acp.rs:662); `sessionsRead` →
  active sessions scoped to the TLC's membership; `sessionRead` → reconstruct from
  backfill + run state; `sessionArchive` → `session_cancel` + archive worktree.
- **Messaging:** `messageSubmit` → `session_prompt` (acp.rs:725); `runAbort` →
  `session_cancel` (acp.rs:818).
- **Realtime + permissions:** `sessionEventsSubscribe` → ACP `session/update`
  (acp.rs:1217), project to assistant deltas + `permission_review`;
  `sessionEventsBackfill` → replay from channel history; permission respond →
  answer `session/request_permission` (acp.rs:1223).
- **Worktrees (the edit-mode trigger = subchannel open):** `worktreeCreate` → git
  worktree + branch on the body, open a session in it; branch deletion after a
  merge/abandonment archives the corner and removes a clean worktree.
- **Files (diff view):** `changedFileRead` / `workspaceFilesRead` → git diff via
  `api/git`; `changedFilesRevert` → checkout.
- **The merge action:** the corner agent uses ordinary `gh` only when the human
  asks it to merge; branch deletion is observed mechanically and posts the Room
  summary before archive.

**Stub (hide UI):** `terminalCreate/Stop/Connect` (no live PTY on the Buzz side).
**Defer:** `sessionFork`, `sessionReset`, `rewind`, `compact`, `messageSteer`, slots/applets.

## Failure modes → each needs a test
- **Agent can write in the parent** (read-only boundary broken): assert the
  agent's write tools are inert in a TLC; only a subchannel worktree is writable.
- **Research escalates into work**: analysis, explanation, summary, and other
  information-only requests must answer in the Room with inspection-only tools;
  an agent-requested mutation must not project ALLOW or open a corner.
- **GitHub is unreachable:** keep chat available, render lifecycle truth as
  unknown/degraded, and never archive from a failed read.
- **Incomplete branch:** one idle fact-turn names the worst completion rung:
  dirty/uncommitted, unpushed, or pushed without a PR.
- **Red checks:** project one concise failing-checks status line and clear it
  when checks recover.
- **Two participants, one subchannel** (the multiuser proof): both attached, both
  receive `session/update`, both can submit a command.
- **On branch deletion:** the summary actually posts to the parent and the
  subchannel is archived — assert both, plus clean worktree removal and dirty
  worktree preservation.
