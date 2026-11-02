# Agent token budget proof

PR 3248 ships compact app-tool discovery, recoverable MCP text-result caps,
the `arguments` alias for `args`, workflow describe and aggregated input
errors, allowance pause fences, and trace result-size/concrete-name diagnostics.
The human-approved split is recorded in brief revision (3), from lunchboxfortwo's
message `e10f3e15058297305cd02709beddc083569aacc60334466e03400256a4459d52`.

## Reproduced

Production replay was excluded by the brief: it would consume live account
context on another machine. TOKEN-CATALOG uses the provider discovery path
with a schema-heavy catalog (1,000 tools). The original implementation returned
every schema, matching the recorded oversized discovery.

TOKEN-OUTPUT uses a model-facing MCP reply containing a large UTF-8 body.
The original facade forwarded the response unchanged.

TOKEN-WORKFLOW supplies an unknown handle, a person, and an omitted role in
one start. Previously validation stopped at the first omitted role.

TOKEN-PAUSE submits an oversized request with settled usage (1.41M of 3M),
then reads and claims queued work. Previously the refusal claimed exhaustion
and did not fence subsequent commands.

## Demonstrated

- `npx vitest run --root apps/server src/composio-apps.test.ts`: bare discovery
  omits schemas and stays within the byte budget (24,000); a query returns schemas.
- `npm run prove:token-output`: the built MCP facade preserves the
  beginning and end and saves a recoverable original (400,049 bytes); the
  textual response stays within the cap (32,768 bytes). Images and audio
  retain their native representation and are excluded from the text budget.
- `npm run prove:token-workflow`: built HTTP start returns
  an input error (400) containing all missing/invalid roles and allowed agents.
- `npx vitest run --root apps/server src/free-agent-model-proxy.test.ts`:
  TOKEN-PAUSE shows real usage, suppresses delivery and claim, and permits them
  after the persisted reset deadline is moved into the past.
- The app tools suite exercises workflow describe before start and the
  `arguments` alias. The trace suite checks concrete tool names, UTF-8 output
  sizes and original sizes supplied by capped MCP results.

Validation for the split: root typecheck, workspace builds, affected Body and
server suites, and both built MCP and HTTP workflow proofs are required before
marking the PR ready. The corner completion report records their output and
exact PR head.

## Deferred items

- Fixed context once per session and its Luna replay check. The follow-up must
  first test whether the old prompt also duplicates answer objects. Removed
  work is preserved at local branch `agent-context-once`, head
  `634ddc4b408188e56e4a83caf760bb732807ef75`. The branch has not been pushed:
  this session's standing developer instruction restricts pushes to
  `feature/corner-f03a7bed9460`. The shipping PR contains none of its new
  context-delivery changes or replay runner. No follow-up PR was opened.
- Native shell output capping in Claude Code, Codex and Cursor. This PR caps
  owned MCP text results only; it makes no native-harness output changes.
