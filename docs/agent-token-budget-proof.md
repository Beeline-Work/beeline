# Agent token budget work

This implements the Beebee discovery incident's approved fixture and the
workflow and allowance fixes. It is **not ready to merge**: universal native
tool output enforcement and context delivery for unverified adapters remain
open parts of brief revision (2).

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
- `node scripts/prove-token-output.mjs`: the built MCP facade preserves the
  beginning and end and saves a recoverable original (400,049 bytes); the
  textual response stays within the cap (32,768 bytes). Images and audio
  retain their native representation and are excluded from the text budget.
- `node --import tsx scripts/prove-token-workflow.mjs`: built HTTP start returns
  an input error (400) containing all missing/invalid roles and allowed agents.
- `npx vitest run --root apps/server src/free-agent-model-proxy.test.ts`:
  TOKEN-PAUSE shows real usage, suppresses delivery and claim, and permits them
  after the persisted reset deadline is moved into the past.
- `npx vitest run --root apps/body src/acp-codex-delivery.test.ts
  src/codex-prompt-delivery.test.ts src/pi-session-instructions.test.ts`:
  cold, warm, failed, repaired and compacted conversations retain or restore
  fixed context. Claude's rules arrive through session creation without
  repeating the same rules in the first task prompt.
- The app tools and turn trace suites cover workflow describe, the `arguments`
  alias, concrete tool names, UTF-8 result sizes and original sizes after capping.

The full workflow suite passed (167 tests), and the startup/attention suite
passed (66 tests). Root typecheck, workspace builds, and workflow path checks
passed. The prompt replay runner samples the existing saved member-handle and
memory cases on both nightly models, with paired seeds and unchanged pass rules.
Its artifacts must be assessed separately; an unscored sample is not proof of
unchanged behavior.

Both identical replay runs remained incomplete. All cold samples passed on
both models. The first run left one Luna warm sample unscored; the repeat left
two Luna warm samples unscored. Sol passed every sample in both runs. No unscored
sample is counted as a pass. Combined replay usage was (968,323 tokens) and
cost was ($0.186). The original and repeated result artifacts are attached to
the corner's blocker report. This does not satisfy the required replay gate.

## Remaining boundary

The owned MCP transports can replace tool responses before delivery to a model.
Native tools in Codex, Claude and Cursor execute inside the external harness;
ACP's tool updates report what happened and do not provide a general result
replacement operation. The repository's read-only MCP deliberately has no shell
execution operation. The installed adapter implementations and the owned Cursor
bridge were inspected: changing their diagnostic ACP updates would not cap the
native result seen by the model. Pi exposes a result hook, but that does not
solve the other harnesses. Native tools need adapter middleware or a deliberate
change to expose equivalent Beeline-owned tools before universal enforcement
can be claimed.

Fixed-block delivery is enabled for verified Codex and Claude adapters and Pi's
journal-based compaction detection, for paid and free agents in Rooms and corners.
Unknown adapters keep full context conservatively. Enabling omission without
reliable compaction detection would violate the brief's context-loss constraint.
Cursor and unverified adapters therefore still need a safe retention contract.
