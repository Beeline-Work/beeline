# MVP: the merge you hold from your phone

## Thesis
From your phone you direct an agent to make a code change, and the merge to
`main` is gated by **your signed approval** — the agent physically cannot merge
without it, the relay enforces it, and it runs on infrastructure you own. That
one property is the product; everything else is borrowed.

## The loop (mobile is the control surface; the agent runs on a machine you own)
1. A **repo channel** on Buzz, bound to a git repo, you're a member. *(exists)*
2. On your phone you talk to an **agent that is read-only in the channel** — it
   reads the repo, plans, discusses, but cannot write. Conversation mode.
3. You say "make this change." The agent forks a **worktree on its body** (a
   machine running `buzz-agent`) and opens an **execution view** on your phone.
   You watch and answer permission prompts. *(Happy session surface, forked)*
4. The agent finishes, pushes its branch, and **requests a merge to `main`**.
5. You tap **Approve**. That signs a merge-approval with your key. The relay
   accepts the merge **only because** it carries your signature. A summary posts
   to the repo channel; the execution view archives read-only.

**Money shot:** the agent merges without your approval → the relay rejects it.
Not the app — the relay. Provable, un-bypassable by the agent.

## Gate mechanics — COMPOSED from shipped primitives (D1)
The gate is NOT new receive-pack code. It composes two shipped, tested pieces:
- **Branch protection** (`git_perms.rs`, `buzz-protect` on `kind:30617`): `main`
  is push-restricted. The agent is NOT in `push-allowed`, so it physically
  cannot push `main` — un-bypassable at the git layer. *(exists)*
- **Workflow human-approval gate** (`buzz-workflow/executor.rs:459`,
  `RequestApproval` → `StepResult::Suspended`; kinds 46010/46011/46012): the
  only identity authorized to land `main` is a workflow whose merge step
  suspends until a human grants approval. *(exists)*
- **Approve** on the phone emits the workflow-approval grant (signed, key never
  leaves the phone) against the suspended step's `approval_token`; the workflow
  then performs the merge as its authorized identity.
- Agent acts under **NIP-OA** delegation (scoped, revocable; owner key never on
  the body).
- New code = a **merge workflow-action** + the phone **Approve** button. No new
  security-critical transport code.
- NOTE corrected from v1: `kind:46011` is `KIND_WORKFLOW_APPROVAL_GRANTED`, a
  workflow kind — NOT a git-merge kind; and `require-approval` is not parsed or
  enforced in the git policy today. The receive-pack gate was the wrong,
  higher-blast-radius place to build.
- Residual risk: the guarantee depends on branch-protection config being correct
  (agent absent from `push-allowed`), not enforced-by-construction in transport.

## Build vs borrow vs defer
**Build (load-bearing):** a merge workflow-action (an agent/action performs the
merge as the workflow's authorized identity); the mobile **Approve** action
emitting the workflow-approval grant; and the **Happy transport adapter** — a
`RigTransport` implementation against Buzz's relay + `buzz-agent` (D2).

**Borrow / reuse (ships in Buzz or forkable):** branch protection
(`push-allowed`/`no-force-push`), the workflow human-approval gate, repo↔channel
binding, git hosting + npub-signed pushes, `buzz-agent`, the relay APNS gateway.
Fork **Happy's mobile client** (Expo/RN) for its push + session/permission/
terminal surface — it has a clean `RigTransport` seam; you swap the transport,
keep the UI (D2). Buzz mobile is not viable: no push wiring in `mobile/lib`,
agent surface is transcript-in-thread only.

**Defer:** differentiated reviewer (owner approves for now), workflows, seats
beyond owner/driver, multi-agent, applets, desktop, auto-deployed remote agents.

## Honest risks
- **Mobile-only still needs a computer** — the agent's body. Someone runs
  `buzz-agent` on a machine and pairs the phone through the relay (same friction
  Happy has: "you bring the substrate"). Cannot be designed away.
- **The gate enforcement is the real engineering** — the receive-pack approval
  check is new relay code and it is security-critical (a bypass defeats the
  entire thesis). It must fail closed on every path.
- **The read-only→execution boundary must be a real tool-permission boundary**,
  not a prompt: in conversation mode the agent's write tools are disabled; a
  write request is what forks the worktree.

## Done =
On a phone: direct an agent, watch it work, approve the merge with a signature,
see it land — and see an unapproved merge blocked (the agent cannot push `main`).

## What already exists in Buzz (reuse, don't rebuild)
- Git hosting (smart HTTP + NIP-34), npub-signed pushes — `api/git/`.
- Branch protection: `push-allowed`, `no-force-push` — `git_perms.rs`,
  `api/git/policy.rs`. (`require-approval` is NOT parsed/enforced — don't rely on it.)
- Repo↔channel binding — `api/git/binding.rs`.
- Workflow engine with a **human-approval gate** — `buzz-workflow/executor.rs`
  (`RequestApproval` / suspend-until-granted; kinds 46010/46011/46012).
- Agent harness — `buzz-agent` (ACP) + `buzz-dev-mcp` (shell/str_replace).
- NIP-OA scoped, revocable agent delegation.
- Relay APNS push gateway — `buzz-push-gateway` (mobile app just doesn't wire it).

## NOT in scope (deferred, with reason)
- Receive-pack `require-approval` enforcement — composed from branch-protection +
  workflow gate instead (D1); lower blast radius.
- Differentiated reviewer, workflows-with-seats — owner approves for MVP.
- Multi-agent, applets, desktop, auto-deployed remote agents.
- Fixing Buzz's mobile app — forking Happy's client instead (D2).

## Failure modes (each new codepath)
- **Branch-protection misconfig** (agent in `push-allowed`): gate silently
  bypassed — the whole thesis dies quietly. MUST have a test asserting an
  unauthorized identity's push to `main` is rejected, and a provisioning check
  that the agent is never in `push-allowed`. **Critical gap if untested.**
- **Workflow performs merge before approval lands** (race/bug): unapproved code
  merges. Test: suspended step does not merge until a valid grant arrives.
- **Approval replay / wrong-target grant**: a grant for merge A accepted for
  merge B. Grant must bind to the exact target (branch tip + repo); test it.
- **Happy transport adapter semantic gaps**: a `@slopus/rig` session/permission
  concept with no Buzz equivalent → dead UI or silent no-op. Spike the mapping.

## Happy `RigTransport` adapter — MVP method list (spike result)
Implement these ~10 against a Buzz backing; stub the rest. Grounded in
`rigTransport.ts` and `buzz-acp/src/acp.rs`.

**Session lifecycle**
- [ ] `sessionCreate(input)` → `buzz-acp session_new` (acp.rs:662). Opens the agent on the body.
- [ ] `sessionsRead()` → list active sessions scoped to the repo channel / open worktrees.
- [ ] `sessionRead(id)` → reconstruct from `sessionEventsBackfill` + current run state.
- [ ] `sessionArchive(id)` → `session_cancel` + archive the worktree.

**Messaging**
- [ ] `messageSubmit(id, text, idempotencyKey)` → `buzz-acp session_prompt` (acp.rs:725).
- [ ] `runAbort(id)` → `buzz-acp session_cancel` (acp.rs:818).

**Realtime + permissions (the "watch it work / answer prompts" surface)**
- [ ] `sessionEventsSubscribe(id, observer)` → subscribe to ACP `session/update`
      notifications (acp.rs:1217); project to `RigSessionEvent` (assistant deltas,
      `permission_review`, `permission_mode_changed`).
- [ ] `sessionEventsBackfill(id)` → replay stored session events from channel history.
- [ ] permission respond → answer `session/request_permission` (acp.rs:1223) grant/deny.

**Worktrees (the edit-mode trigger)**
- [ ] `worktreeCreate(projectId, input)` → create git worktree + branch on the body; open a session in it.
- [ ] `worktreeArchive(projectId, worktreeId)` → remove worktree (on merge / close).

**Files (diff view)**
- [ ] `changedFileRead` / `workspaceFilesRead` → git diff via `api/git`; `changedFilesRevert` → checkout.

**Buzz-specific action (the differentiator — not in stock RigTransport)**
- [ ] **Approve merge** → emit the workflow-approval grant against the suspended
      merge step's `approval_token` (signed on device). This is the whole product.

**STUB (hide UI, defer):** `terminalCreate` / `terminalStop` / `terminalConnect`
(no live PTY on the Buzz side — out of MVP scope). **DEFER:** `sessionFork`,
`sessionReset`, `rewind`, `compact`, `messageSteer`, slots/applets, `projectCompute`.

## Build sequence — prove the gate first, client last
Ordering principle: the differentiator is the merge gate. Prove it end-to-end
**headless** before spending a day on any client, so if the D1 composition
can't hold you find out on day one, not after forking a mobile app. The client
is the wrapper around a thing that's already proven, so it comes last.

**Phase 0 — Prove the gate (no agent, no client, scripts only). THE money shot.**
- Repo on Buzz; `main` protected so only the workflow identity is in `push-allowed`.
- Build the one new piece: a **merge workflow-action** (performs the merge as the
  workflow identity) whose step suspends on `RequestApproval`.
- Demo, all via relay scripts (the pattern used all session):
  1. Push a branch. Attempt to merge `main` as a non-authorized key → **rejected**.
     ← this IS the review's CRITICAL test; write it first.
  2. Run the merge workflow → it suspends, awaiting approval.
  3. Emit the signed approval grant → workflow merges → `main` advances.
- Exit: an unapproved merge is impossible; an approved one lands. Thesis proven.

**Phase 1 — Agent drives the loop (still headless).**
- `buzz-agent` in a worktree on a body: make a change, push the branch, trigger
  the merge workflow. Enforce the read-only→write boundary (writable checkout
  exists ONLY in the worktree). Agent runs under NIP-OA delegation, not in
  `push-allowed`.
- Exit: an agent takes it from "make this change" to a suspended merge gate.

**Phase 2 — Human approves from a device (thin surface).**
- The signed **Approve** action as the smallest possible surface first (CLI or a
  one-page web app emitting the grant). A human approves; the merge lands.
- Exit: full human-in-the-loop loop works before any mobile investment.

**Phase 3 — Fork Happy + the `RigTransport` adapter (the real client).**
- Implement the ~10 MVP methods above against `buzz-acp` + git API; stub
  terminals. Session, watch (`session/update`), permission prompts, worktree
  create, diff, and the Approve action, in Happy's polished surface.
- Can start scaffolding in PARALLEL with Phase 1–2 (separate codebase: Happy TS
  vs Buzz Rust) once the buzz-acp surface is pinned.
- Exit: the Phase 2 loop, now driven from Happy's mobile UI.

**Phase 4 — Make it real.**
- Wire push to the relay APNS gateway. Failure-mode tests: approval replay /
  wrong-target grant bound to exact (branch tip + repo); workflow does not merge
  before the grant; branch-protection provisioning check (agent never in
  `push-allowed`).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | 2 architecture decisions resolved; 1 critical test gap flagged |

- **VERDICT:** ENG reviewed — 2 load-bearing decisions made (D1 gate location →
  compose shipped primitives; D2 mobile → fork Happy + `RigTransport` adapter).
  Spec corrected (46011 is a workflow kind, not git; receive-pack gate dropped).
  One CRITICAL test requirement: prove an unauthorized push to `main` is
  rejected and the agent is never in `push-allowed` — the gate's whole guarantee
  rests on it. Ready to implement once that test is in the plan.

NO UNRESOLVED DECISIONS
