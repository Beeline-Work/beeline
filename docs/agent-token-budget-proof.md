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

The PR repair also runs `R-MCP-PARITY` and `R-MCP-PROCEDURE` in
`rooms-mcp.test.ts`: the connected MCP catalog exposes `load_workspace_skill`,
and both that name and `read(facet:procedure)` load the same saved procedure
with the active turn's authority. The parity exclusions remain unchanged.
TOKEN-WORKFLOW also covers membership removal between prevalidation and the
legacy binding reads. The regression starts with a valid prefixed handle,
bare handle, or identity id, then removes that agent before resolution. All
three previously raised an unexpected error; they now refuse the caller with
HTTP status (400) and write no workflow start card. The later membership check
still rejects removed agents. PGlite serializes transactions, so the regression
models the committed removal between statements on its transaction connection.

Workflow input validation runs before the original start-card binding path,
preserving the locked System-message fingerprints `bb92464a5effd869` and
`2c5f68a0d84e5993`; the lock file is unchanged.

Validation for the split: root typecheck, workspace builds, affected Body and
server suites, and both built MCP and HTTP workflow proofs are required before
marking the PR ready. The corner completion report records their output and
exact PR head.

## Fixed context and native shell follow-up

CTX-ONCE is not a defect report: it is the approved prompt-cost optimization.
Production sessions remain excluded because they run on other machines and would
consume live account context. The replay uses the same saved cases, models,
seeds and sample count as the supplied records: members and memory, Luna and
Sol, three samples per case and arm (twelve samples per model).

The old-prompt baseline at `a0726f8d09a24bef07e7c6966666f88e31ee944b`
completed with no duplicate answers on either model. Its warm arms passed
(six of six) on each model. This selects acceptance criterion (3); the parser
remains strict and rejects multiple answer objects, including identical ones.

The attached patch initially regressed Luna: its warm arm scored only
(one of six), with five answer-format failures. Caching the `workspace-core`
task-start action was incorrect: that instruction must remain on every task.
The corrected implementation retains it on the current turn while caching the
fixed rules, roster, memory and other unchanged context. The final replay
completed with warm pass rates (six of six) on **both** Luna and Sol, matching
the baseline. No parser tolerance, model change, or replay grading change ships.
The original failed candidate result is retained alongside the baseline and
passing result in the delivery attachments.

Verified Claude ACP (`0.97.0`) now joins the existing verified Codex ACP
(`2.3.0`, structured instructions) cache path. Pi checks its own compaction
journal before assembly and conservatively re-sends context when the journal
cannot be read. Native loads, new adapter processes, failed delivery and
compaction restore context. Other adapter versions retain full delivery.
`acp-codex-delivery.test.ts` checks new sessions, warm turns, native loads,
failed resume, compaction and adapter restart; `codex-prompt-delivery.test.ts`
keeps the per-task procedure action outside the cache.

SHELL-CAP exercises a shell command producing (400,011 bytes), through each
installed harness. Claude and Codex use local recorded model providers and
inspect the actual next model request; Cursor uses a fresh native conversation
and observes the native result through its post-tool hook. Full output is read
back and compared byte for byte. The proof commands are:

```sh
npm run build -w @beeline/body
node scripts/prove-native-shell-cap.mjs
node scripts/prove-native-shell-cap.mjs .scratch/shell-permission-baseline --permissions --unhooked
node scripts/prove-native-shell-cap.mjs .scratch/shell-permission-hooked --permissions
node scripts/prove-native-shell-cap.mjs .scratch/native-shell-failure --fail
node scripts/prove-codex-shell-cap.mjs
node scripts/prove-cursor-shell-cap.mjs
```

Claude and Cursor capture output inside their native
`PreToolUse`/`preToolUse` hooks before native truncation can discard it.
The hook rewrites input without setting a permission decision.
SHELL-CAP-PERMISSION checks the installed Claude CLI with default permissions
and no bypass flag: the same approval-required command stays blocked both
without the hook and with it. The cap/recovery proofs explicitly opt into
execution permission for their isolated recorded-provider commands.
Claude must capture before execution: its successful-only `PostToolUse` event
never runs for a failed Bash command. The installed-CLI regression uses a local
recorded provider for both success and failure (exit status 7), and checks the
actual next model request for failure status, bounded output, head and tail,
and a recovery file matching the entire original output. The original shell language, stdin and exit status
are preserved; combined output is archived under the isolated session's temp
directory, then streamed as a bounded head and tail with its recovery path.
The preview ceiling is (16,384 bytes); the capture path starts shortening at
(1,024 bytes) to leave room for encoding and the recovery notice. Native shell
invocations remain separate processes; this adds no shell-state persistence.
The archive lives with the session's existing temporary storage retention.
Hooks are provisioned on POSIX hosts; Windows capture is not enabled.

Codex currently cannot apply the permission-neutral command rewrite (see the
blocking result below). The earlier passing cap measurements used an explicit
allow decision and are superseded. Codex receives only the generated hook through its adapter's session flags.
Before creating or loading a session, the built ACP client verifies the script
against its shipped content, lists that exact command and matcher, and records
trust for its current hash. It never trusts repository or plugin hooks. The
Codex native proof exercises this production trust path without a global trust
bypass. Cursor's proof uses the generated isolated user configuration from
`prepareRoomAgentHome`.

The native results received by the model were Claude (2,196 bytes on success;
2,208 bytes on failure), Codex
(2,301 bytes), and Cursor (2,228 bytes), all with complete recovery. Exact byte
counts include each harness's native framing and can vary with temporary paths.
The latest native CLIs already have their own truncation: the historical claim
that every native result reaches the model in full is not true on these
installed versions. The missing guarantee was a Beeline-owned cap with recovery
before lossy native truncation, particularly on Codex. The unhooked command and
controlled native-provider observations are the stand-in, not a claim about
production sessions or older harness binaries.

Replay commands (the exchange directory is served by sealed OpenRouter calls):

```sh
node --import tsx scripts/prove-fixed-context-baseline.mjs <baseline-output-dir>
node --import tsx scripts/prove-fixed-context-replay.mjs <candidate-output-dir>
```

## Server CI repair

The failing checks at head `521b9b95c7d79036325ea5a55c64f75f765e8500`
were the MCP catalog parity case and the System-message fingerprint lock in
server shard (3). The `SERVER SUITE` and `SERVER INTEGRATION` jobs inherited
that shard's failure; its integration batches themselves passed. The repair
restores procedure-tool parity and the original locked workflow wording,
without changing either exclusion lists or the lock. Membership-race refusals
remain aggregated caller errors.

Main integration resolves the MCP reply overlap by applying the recoverable
cap after the existing owed-mention wrapper. Wake deadlines use the current
`room_access` view and continue excluding infinite allowance pauses. Neither
change adds fixed-context caching or native shell output capping. The exact
head and current CI verdict belong to the completion report.

### Approval-preserving repair: Codex blocked

SHELL-CAP-PERMISSION reproduces the approval bypass on the previous PR head.
The generated hook now emits only command modifications, with no permission
or approval decision in Claude, Codex or Cursor output. Installed Claude
default-permission runs refuse both the original and hooked command; isolated
execution-enabled runs retain bounded output and byte-exact recovery on success
and failure. Cursor recovery still passes.

Codex capping is **blocked**, using the brief's explicit per-harness fallback.
The installed Codex CLI (0.165.0) ignores updatedInput without an allow decision.
Its [versioned parser](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/output_parser.rs#L162-L170)
only retains the rewrite when permissionDecision is Allow. The post-tool parser
only supports feedback/additional context, without replacing shell output.
The permission-neutral native replay receives (10,215 bytes) of native-truncated
output with no recovery notice; prove-codex-shell-cap.mjs fails its recovery-path
assertion. This supersedes the earlier Codex success claim. The shared hook
remains permission-neutral; Codex retains native truncation until upstream
supports a rewrite without an approval decision. No native proof is loosened.
