# Agent-to-agent delegation in Rooms

Status: reviewed, ready to implement

## Request and authority model

A visible Room reply authored by agent A may address one peer agent B with an `@handle`. The host resolves the first valid peer mention against the current Room roster before publishing A's reply, signs delegation metadata into that same visible kind:9 event, and lets B's existing Room poller consume it as a real turn. Agent prose alone never grants authority.

Every delegation chain is rooted in one verified, human-authored Room request. Each hop carries the root event id and root human pubkey. B evaluates its own current access policy against that root human, not A:

- `creator`: the root human must be B's current paired owner.
- `allowlist`: the root human must be in B's current allowlist.
- `everyone`: any verified human Room member may be the root.
- Missing, stale, malformed, agent-authored, cross-Room, or inaccessible root events fail closed.

A delegated request runs through B's ordinary read-only Room session. It may use the same governed tools as a directly addressed human request. If it asks to write or open a corner, the existing corner-open approval flow is used with the root human as `request.authorPubkey`. Delegation always forces the approval path, even when that human could ordinarily open a corner directly; an agent's ask never auto-approves a corner.

The existing human command `@agent talk to @peer` remains unchanged. It keeps its `buzz-agent-exchange` envelope, read-only prompt, and two-messages-per-agent cap. General delegation is a parallel bounded admission case inside the same Room dispatcher, not a replacement exchange subsystem.

## Data flow

```text
human H -> addressed Room request R -> agent A normal Room turn
                                      |
                                      +-- final text mentions @B
                                          |
                                          +-- resolve current Room member + online lease
                                          +-- publish A's visible reply D1
                                              t=agent-message
                                              t=buzz-agent-delegation
                                              root-request=R, root-human=H, hop=1, p=B
                                                  |
                                                  v
                                      B validates signature, membership, root, budget,
                                      dedupe, and B's current policy against H
                                                  |
                                +-----------------+------------------+
                                |                                    |
                              allow                                refuse
                                |                                    |
                         ordinary Room turn                 one visible B reply
                         (read-only boundary)               carrying same root
                                |
                        visible reply D2; if it mentions a peer,
                        publish the next signed hop
```

The source agent prepares delegation metadata only after the model returns final text, then passes the tags into `publishAgentResult`. The visible reply is both transcript content and the delivery event. There is no hidden dispatch record. The target daemon validates the envelope and root from relay truth before spending a model turn.

## Event shapes and projection

### Delegating and delegated replies

Kind: `9`

```text
["h", "<room-id>"]
["t", "agent-message"]
["t", "buzz-agent-delegation"]
["e", "<root-human-request-id>", "", "root"]       # when reply parent differs
["e", "<immediate-source-event-id>", "", "reply"]
["root-request", "<root-human-request-id>"]
["root-human", "<root-human-pubkey>"]
["from-agent", "<author-agent-pubkey>"]
["to-agent", "<recipient-agent-pubkey>"]
["hop", "<1..configured-limit>"]
["dedupe", "<sha256(root, from, to, normalized-mentioned-text)>"]
["p", "<recipient-agent-pubkey>"]
content = the ordinary visible agent reply containing the resolved @handle
```

For hop 1, `immediate-source-event-id` is the root human request. For later hops it is the prior agent delegation event. The explicit root tags remain unchanged across the chain.

### Visible refusal, loop, offline, and limit lines

Kind: `9`, authored by the agent making the determination.

```text
["h", "<room-id>"]
["t", "agent-message"]
["t", "buzz-agent-delegation"]
["e", "<root-human-request-id>", "", "root"]       # when needed
["e", "<source-event-id>", "", "reply"]
["root-request", "<root-human-request-id>"]
["root-human", "<root-human-pubkey>"]
["delegation-status", "refused|offline|duplicate|limit"]
["request", "<source-event-id>"]
content = one short human-readable explanation
```

The source reply itself remains visible even when a mention is not dispatched. A status line is added for an unknown/non-member peer, an offline peer, a repeated identical delegation, a policy refusal, or the hop limit. Self-mentions are simply context-only because the already-visible source reply is sufficient and no other agent was requested.

`apps/push-gateway/src/room-indexer.ts` adds `buzz-agent-delegation` to `CONVERSATION_MARKERS` and to both SQL conversation-marker allowlists used by Room paint and Room-list previews. It therefore projects all these events as `RoomViewMessage.presentation = 'message'`, preserves `mentionPubkeys`, NIP-10 reply metadata, and root id, and makes them eligible for bounded model transcript history. `agent-message` remains mandatory, so the new marker does not turn control-only records into conversation.

No `body-control` event carries user-facing delegation content.

## Loop, dedupe, and cost protections

- Default: `BUZZY_BODY_AGENT_DELEGATION_MAX_HOPS=4` agent-initiated dispatches per root human request.
- The environment override is parsed once and hard-clamped to `1..8`; invalid values use `4`. Operators can lower cost but cannot remove the bound.
- One agent reply dispatches at most one peer. If the model mentions three agents, the first valid non-self Room member in text order is the only recipient; the other mentions remain visible context.
- Self-mentions never dispatch.
- The target reserves one reply per source event through the durable reply inbox before publishing, so replay/restart cannot spend twice.
- A relay-derived dedupe key blocks the same `root + from + to + normalized mentioned text` from retriggering the same agent in one thread. Different text may continue the chain until the hop limit.
- A target may mention the agent that just mentioned it, but only one target can be emitted from that turn and every return consumes another hop. Ping-pong therefore terminates at four dispatches by default even when each side varies its wording.
- At the limit, further mentions are context-only and the host publishes one visible `delegation-status=limit` line for the root. A relay lookup suppresses duplicate limit lines after daemon restart.
- The bounds are host checks. Prompt instructions explain them but are not trusted for enforcement.

Worst-case incremental model cost for one root request is four delegated turns at the default and eight at the absolute configuration maximum. The original addressed agent turn is outside that incremental count. Human messages always form a new normal request and may start a new chain if addressed.

## Validation and admission

The target accepts a delegation only when all checks pass:

1. The event signature is valid, kind is 9, channel is this Room, marker is `buzz-agent-delegation`, author equals `from-agent`, recipient equals this agent, and exactly one matching `p` tag exists.
2. Both agents are current members of the Room and registered agent identities; self-targeting fails.
3. `hop` is an integer within the configured hard bound.
4. The root event exists in the same Room, is signed by `root-human`, is not agent-authored, and originally addressed the hop-1 source agent.
5. Hop 1 replies to the root. Later hops reply to a valid prior delegation with the same root, consecutive hop number, and prior recipient equal to the current author.
6. The signed dedupe value matches the host's deterministic calculation.
7. The source event has not already produced a durable reply and the same thread dedupe has not already produced one.
8. The recipient's current access policy permits `root-human`.

Malformed or forged events are ignored as control attempts and receive no reply, avoiding an attacker-controlled spam oracle. A valid delegation whose root human lacks access receives one visible policy-refusal reply.

## Permission behavior

The delegated `ChannelTaskRequest` keeps two identities deliberately:

- `authorAttribution` is the delegating agent, so the prompt accurately labels the immediate speaker.
- `authorPubkey` is the root human, so access, corner requester, and permission-card audience use the human authority.

The turn's model attribution records `trigger='agent'`, `commissionedByAgentPubkey=<from-agent>`, `principalPubkey=<root-human>`, and `originalRequestId=<root-request>`. The ordinary Room mutation denial still applies. A delegated corner/write request cannot inherit direct-open privilege: it always emits the existing approval card for the root human and waits for an authorized human decision.

## Failure and timeout behavior

- Unknown or non-member handle: the source host posts one visible refusal; no target turn.
- Offline member: the source host checks the existing presence lease and posts one visible offline line; no target turn. A race after publication is safe because the durable event remains pending for the target daemon after restart.
- Policy refusal: the target posts one visible refusal carrying the root tags; no model session starts.
- Session activation or model-turn failure: existing Room failure handling posts one visible reply, tagged with the delegation root, and does not automatically retry without a new human message.
- Model timeout: the existing idle-window/hard-timeout path settles the receipt as failed and publishes the same visible failure behavior.
- Relay publication failure: the durable reply reservation is replayed; no second model turn is needed.
- Daemon restart mid-chain: every hop is relay-verifiable and the Room durable inbox resumes pending events. Hop and dedupe checks are relay-derived, not only memory-derived.
- Human replies mid-thread: an addressed human message is a new authoritative root and resets the delegation budget. An unaddressed human reply is context only. It never mutates an existing agent-authored envelope.

## App changes

No composer redesign is required. The mobile Room composer already emits stable `p` tags from its mention picker, `RoomViewMessage` already carries `mentionPubkeys` and `rootId`, and the ledger already attributes messages by signing identity. Product changes are limited to the server projection allowlist and tests proving the new marker remains a normal visible message. Mobile typecheck and the focused Room/mention suites guard that no DTO or picker regression was introduced.

## Test plan

### Code and user-flow coverage

```text
CODE PATHS                                              USER FLOWS
[+] agent delegation envelope                           [+] Human asks A to hand work to B [->E2E]
  |-- valid hop 1 / later hop                              |-- A visible reply mentions B
  |-- invalid signature / malformed tags                   |-- B receipt + visible attributed reply
  |-- forged/cross-Room/agent root                          `-- root id/human preserved on every hop
  `-- non-consecutive parent chain
[+] source mention preparation                          [+] Safety/refusal flows
  |-- no mention / self mention                            |-- unknown or non-member peer is visible
  |-- one member / three members                           |-- offline peer is visible
  |-- offline / non-member                                 |-- creator + allowlist refusal is visible
  |-- identical dedupe                                     |-- delegated corner asks for approval
  `-- hop 4 limit + one limit line                         `-- deliberate ping-pong stops at bound [->E2E]
[+] target Room turn                                    [+] Restart/failure flows
  |-- policy allowed -> normal read-only turn              |-- source event replay spends once
  |-- policy denied -> deterministic reply                 |-- daemon restart resumes pending hop
  |-- read-only information answer                         `-- turn timeout/failure is visible
  |-- mutation -> existing permission handler
  `-- corner -> forced approval with root human
[+] push-gateway projection
  |-- marker appears in Room paint and preview
  |-- presentation=message + author + mentions + root
  `-- refusal/limit lines remain visible
```

### Automated tests

- `apps/body/src/agent-mention.test.ts`: envelope parse/build, root continuity, malformed/forged event rejection, configured bound clamp, self mention, first-of-three selection, identical dedupe, and hop-limit decisions.
- `apps/body/src/body.test.ts`: valid agent-authored Room delegation triggers a real target turn; creator and allowlist are evaluated against root human; non-member/offline refusal; only one of three peers triggers; repeated identical mention does not retrigger; ping-pong stops at the configured bound with one line; delegated information request works; delegated mutation cannot write in Room; delegated corner request emits existing approval with root human requester; human mid-thread creates a new root; durable replay/restart does not spend twice; timeout/failure line is visible and rooted; existing `humanAgentExchangeRequest` tests remain green.
- `apps/push-gateway/src/room-indexer.test.ts`: delegating reply, target reply, access refusal, offline/duplicate/limit line all project as messages in Room paint and previews with author, `mentionPubkeys`, `replyToId`, and `rootId` intact.
- `apps/body/src/agent-delegation.live.test.ts`: local-relay proof with two paired bodies, A mentioning B, B replying, and deliberate ping-pong stopping at the host bound. Query and print event ids/timestamps/root tags for the PR evidence.
- Existing `apps/body/src/agent-exchange.live.test.ts` remains green.
- Validation commands: affected Body unit/live suites, push-gateway suite, focused mobile Room/mention suites, `npm run typecheck` at repository root, and `cd apps/mobile && npm run typecheck`. Do not run or repair the known unrelated full mobile suite failures.

### Production failure audit

| Path | Realistic failure | Test | Handling | User-visible |
|---|---|---:|---|---:|
| Source roster/presence | relay read fails or lease expires | yes | fail closed; visible unavailable line when truth is known, publication failure logged/retried by normal request lifecycle | yes when decidable |
| Envelope/root validation | forged or missing root | yes | ignore without model spend | no, deliberately avoids spam oracle |
| Policy lookup | current config read unavailable | yes | fail closed and visible policy refusal for an otherwise valid envelope | yes |
| Target activation | harness missing or read-only session unavailable | yes | existing failed receipt and one rooted failure reply | yes |
| Model turn | idle/hard timeout | yes | existing bounded timeout path; no automatic agent retry | yes |
| Reply publish | transient relay outage | yes | durable reserved reply replays after restart | eventually |
| Budget/dedupe lookup | daemon restart loses memory | yes | query relay-authored thread facts before admission | yes; no repeated spend |
| Projection | new typed marker omitted from allowlist | yes | indexer regression test fails | otherwise silent, so P1 test gate |

No failure path combines no test, no handling, and silent user impact.

## What already exists

- `humanAgentExchangeRequest`, `agentExchangeTags`, and `validateAgentExchangeEnvelope` provide the proven root-human authorization and signed-envelope pattern. The legacy exchange remains as-is; delegation mirrors only its validation ideas.
- `agent-mention.ts` already resolves signed same-Workspace peer mentions, rejects self-targeting, serializes corner mention turns, and demonstrates a host-side turn fuse. Room delegation extends its pure envelope helpers rather than creating another package.
- `processChannelRequestEvents` is the canonical agent-authored ingress and already refuses unrecognized agent prompts. Delegation becomes one additional validated branch before that refusal.
- `replyInRoom` already enforces read-only Room sessions, permission escalation, corner creation, receipts, failures, and durable replies. Delegated work enters this path with split speaker/authority identity.
- `senderAccessAllowedFresh` is the current-generation access-policy authority and is reused against the root human.
- `buildAgentMessage` and `publishAgentResult` already create visible attributed kind:9 replies with NIP-10 roots and durable reply reservation.
- `RoomIndexer.projectEvent` and its SQL marker allowlists are the only durable Room projection authority.
- Mobile mention resolution and `RoomViewMessage.mentionPubkeys/rootId` already cover the app data shape.

## NOT in scope

- No generalized workflow/delegation framework, scheduler, graph database, or new daemon service; the feature is one bounded Room ingress extension.
- No agent inbox UI, task dashboard, delivery receipts UI, or special delegation card; the transcript is the product surface.
- No parallel fan-out to multiple mentioned agents; one reply can spend at most one peer turn.
- No unbounded agent autonomy, recursive background jobs, or agent-created root authority.
- No changes to Room membership, pairing, access-policy configuration, or protected-ref authorization.
- No automatic reassignment when a peer is offline and no synthetic timeout watcher for an offline daemon; durable relay delivery resumes when it returns.
- No migration or subsumption of the existing human-authorized live exchange.

## Sequential implementation

There is no safe worktree parallelization opportunity. The envelope, dispatcher, prompt, and permission behavior all converge in `apps/body/src/body.ts`; indexer changes depend on the final marker contract. Implement sequentially: pure envelope helpers/tests, Body integration/tests, indexer projection/tests, then live proof and validation.

## Implementation tasks

- [ ] **T1 (P1, human: ~4h / Codex: ~45m)** - Body - Add the signed Room delegation envelope, root validation, bounds, dedupe, and one-target mention preparation.
  - Surfaced by: Architecture review - authority and cost must remain host-grounded across restarts.
  - Files: `apps/body/src/agent-mention.ts`, `apps/body/src/agent-mention.test.ts`, `apps/body/src/body.ts`
  - Verify: focused agent-mention and Body delegation unit tests.
- [ ] **T2 (P1, human: ~4h / Codex: ~45m)** - Body - Route valid delegated turns through current access policy and Room/corner permission handling using the root human.
  - Surfaced by: Security review - the delegating agent is context, never authority.
  - Files: `apps/body/src/body.ts`, `apps/body/src/body.test.ts`
  - Verify: creator/allowlist, mutation, corner approval, failure, replay, and exchange regression cases.
- [ ] **T3 (P1, human: ~1h / Codex: ~15m)** - Push gateway - Admit `buzz-agent-delegation` as visible conversation in paint and preview queries.
  - Surfaced by: Projection failure audit - omission would silently hide valid replies.
  - Files: `apps/push-gateway/src/room-indexer.ts`, `apps/push-gateway/src/room-indexer.test.ts`
  - Verify: push-gateway projection suite.
- [ ] **T4 (P1, human: ~3h / Codex: ~30m)** - Live proof - Prove two paired agents delegate and the host stops ping-pong on the local relay.
  - Surfaced by: Test review - mocks can hide relay filtering, signature, and daemon replay failures.
  - Files: `apps/body/src/agent-delegation.live.test.ts`
  - Verify: local live suite plus captured ids, timestamps, root and hop tags.

## Engineering review

Review mode: non-interactive, as required by the launch brief. Recommended options were selected automatically.

### Step 0: scope challenge

The plan reuses all relevant shipped paths and introduces no service or generalized state machine. The minimum product diff is expected to touch four production/test areas: the existing mention helper, Body dispatcher, Room indexer, and a live proof. The apparent file count exceeds eight only when tests are counted; production architecture remains three existing modules and zero new services/classes. Distribution is unchanged because this is behavior inside existing Body and push-gateway artifacts.

Recommendation: keep the legacy exchange intact and add a separate marker on normal agent messages. Trying to overload `buzz-agent-exchange` would mix a fixed conversational two-per-agent contract with delegated work and current-policy permission escalation, making both harder to reason about.

Layer: **[Layer 1]** reuse existing signed Nostr events, durable inbox, access-policy resolver, and Room projection. No web search was needed because no new framework, infrastructure, or concurrency primitive is introduced.

### Architecture review

1. **[P1] (confidence: 10/10)** Agent identity must never become delegated authority. Selected: carry and revalidate the root human on every hop, then pass that human to existing permission/corner paths.
2. **[P1] (confidence: 9/10)** A hidden dispatch event would violate the product transcript and create two truths. Selected: the visible signed agent reply is the dispatch event.
3. **[P1] (confidence: 9/10)** In-memory-only hop state would reset on daemon restart. Selected: signed hop/root/dedupe tags plus relay-derived prior facts and durable reply reservation.
4. **[P2] (confidence: 9/10)** Reusing `buzz-agent-exchange` would couple incompatible authority and budget semantics. Selected: one new conversation marker while retaining the legacy path.

### Code-quality review

1. **[P1] (confidence: 9/10)** Duplicating Room turn execution for delegation would drift from permission and failure behavior. Selected: extend `replyInRoom` with explicit delegation context and small reply-tag helpers.
2. **[P2] (confidence: 9/10)** Parsing free-form prose at the recipient is spoofable. Selected: resolve prose once at the signing source; recipients consume signed tags only.
3. **[P2] (confidence: 8/10)** Multiple recipients create concurrency, cost, and partial-failure complexity. Selected: one recipient in text order.

### Test review

The coverage diagram above identifies 28 behavioral/error branches. All are assigned to pure helper, Body integration, projection, or live-relay tests. The prompt changes are safety instructions rather than a quality-generating template; deterministic prompt assertions and live behavior are the applicable eval, with no separate LLM benchmark introduced.

Critical regression gates: the human-authorized exchange remains green; normal human Room requests still work; typed delegation messages remain conversation in both Room paint and Room previews; delegated mutation never gains in-Room write authority.

### Performance review

1. **[P2] (confidence: 8/10)** Ordinary replies should not pay roster/presence/relay-query cost. Selected: retain the cheap `@handle` precheck and perform delegation reads only when final text contains a possible mention.
2. **[P2] (confidence: 8/10)** Validation could become sequential relay latency. Selected: batch independent root, membership, presence, and prior-dedupe reads where existing APIs permit, with no persistent cache whose staleness could widen authority.

No N+1 database path or new high-volume projection query is introduced. The indexer change is a constant marker allowlist comparison on already-read event tags.

### Edge-case decisions

| Edge case | Handling |
|---|---|
| Self-mention | Visible prose remains context; no dispatch and no extra noise. |
| Non-member/unknown handle | Source posts one visible refusal; no target event. |
| Offline member | Source posts one visible offline line; no model spend. |
| Two agents repeatedly mention each other | Each return consumes a hop; default four, hard maximum eight, then one limit line. Identical repeated text dedupes earlier. |
| One reply mentions three agents | First valid non-self Room member in text order receives one turn; others are context-only. |
| Delegated request opens a corner or writes | Existing mutation boundary; corner always requires approval with root human requester. |
| Human replies mid-thread | Addressed human reply becomes a new root/budget; unaddressed reply is context. |
| Daemon restarts mid-thread | Relay-verifiable envelope and durable inbox resume exactly once. |
| Recipient policy is `creator` | Root human must be current owner or target visibly refuses. |
| Recipient policy is `allowlist` | Root human must be present in current allowlist or target visibly refuses. |

### Deliberately not built

The `NOT in scope` section is accepted as written. No TODO is warranted: fan-out, delegation dashboards, and offline timeout watchers add cost and complexity without blocking the owner-decision-B acceptance criteria.

### Review completion summary

- Step 0: scope accepted as-is; bounded extension, no subsystem.
- Architecture review: 4 issues found and resolved with recommended options.
- Code-quality review: 3 issues found and resolved with recommended options.
- Test review: coverage diagram produced; 28 branches assigned, 0 unowned gaps.
- Performance review: 2 issues found and resolved with recommended options.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 0 proposed; no file exists and no valuable deferred requirement was found.
- Failure modes: 0 critical silent gaps.
- Outside voice: skipped because the task explicitly requires autonomous non-interactive execution and no delegation.
- Parallelization: sequential; all core behavior converges in Body.
- Lake score: 9/9 recommendations selected the complete bounded option.

## CGSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `$plan-ceo-review` | Scope and strategy | 0 | not run | Owner decision B and acceptance criteria are fixed. |
| Codex Review | `Codex review` | Independent second opinion | 0 | skipped | Non-interactive direct implementation brief; no outside-agent review requested. |
| Eng Review | `$plan-eng-review` | Architecture and tests (required) | 1 | clear | 9 issues resolved, 0 critical gaps. |
| Design Review | `$plan-design-review` | UI/UX gaps | 0 | not needed | Existing transcript, attribution, and mention-picker UI are reused. |
| DX Review | `$plan-devex-review` | Developer experience gaps | 0 | not needed | No developer-facing workflow or API change. |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED - ready to implement.
