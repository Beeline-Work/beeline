# Codex prompt delivery

Beeline sends session rules through `session/new`, then omits unchanged context
blocks from warm turns on the verified Codex ACP path. Codex settings, native
tools, imported skills, and transcript selection/budgeting remain unchanged.

`AcpClient` enables `CodexPromptDelivery` only for `codex-acp` reporting version
`2.3.0` and structured `systemPrompt` support. This installed adapter stores the
append text as developer instructions and emits automatic/manual
`compaction_update` notifications when the client advertises
`session.compaction`. Unknown versions and missing capabilities retain full
turn delivery. This conservative version guard should be expanded only after
measuring a new adapter's instruction and compaction behavior.

Each confirmed conversation has an in-memory hash map. Successful session
creation seeds only the rules already accepted by the adapter. Successful prompt
completion commits staged block hashes. A failed prompt, native load, compaction,
new process, or missing cache restores full block delivery; fresh sessions deliver
rules through session creation rather than repeating them in the first user
prompt. Native loads deliberately do not reuse a previous process's cache.
Compaction invalidates in-flight stages too. Empty replacements explicitly clear
previously delivered blocks.

Cached blocks: rules, members, memory, corners, objective, generated title, brief,
checkout, and available app list. Task, transcript, resume, reviewer target,
workspace-core task-start instruction, and lifecycle instructions remain per-turn.
Follow-up delivery nudges do not participate in the block cache.

## Reproduced

Not a defect report: this is the approved prompt-cost optimization.

Proof `CODEX-ONCE`: create a real Codex ACP conversation with Beeline's assembled
session instructions, then deliver a first task, unchanged warm task, and a task
with one changed memory block. Before the change, the same instructions, members,
memory and corners appear in every turn. The before arm calls the unfiltered
assembler; the after arm uses the production ACP delivery cache. Both use the
same inherited Codex configuration, default model, native harness and fixture.
There is no Codex settings rewrite or tool-surface restriction.

The fixture uses a disposable cwd, one owner, and stable example corners. It is
a real model/session proof of the affected ACP path, not a production daemon
restart or a comparison against Ruby's original roster. The referenced owner-DM
measurement was inaccessible from this corner (message access denied).

## Demonstrated

Run from the repository root using the current agent's own inherited login:

```sh
BEELINE_CODEX_PROOF_OUTPUT=/tmp/codex-proof-prompts.jsonl \
  node --import tsx apps/body/scripts/prove-codex-prompt-delivery.ts
```

The optional output file contains only generated fixture prompts, for structural
token counting. The script prints actual model input/cache usage from its own
session journal and ACP; it asserts the correct retained proof word on unchanged
turns and a new word after the memory update. It also requests real `/compact`,
requires the adapter's compaction notification, asserts full block restoration,
and checks the model still answers with the updated word.

Measured on squire on October 30, 2026 with Codex ACP (`2.3.0`). Session
rules contain (1,225) structural tokens in both arms.

| Turn | Before Beeline tokens | After Beeline tokens | Before model input | After model input |
| --- | ---: | ---: | ---: | ---: |
| first | (1,685) | (460) | (17,416) | (16,191) |
| warm | (1,685) | (19) | (22,293) | (19,402) |
| changed | (1,685) | (32) | (23,990) | (19,446) |

After real compaction, all blocks returned (1,685 structural tokens),
and Codex answered `COBALT` with reported input (19,378) tokens.
The unchanged warm payload contains only the task; the changed warm payload
contains memory and task. The first-turn totals including session rules are
(2,910) before and (1,685) after.

The measured rows are retained in [the proof record](codex-prompt-delivery-proof.json).

Input tokens include retained conversation and native Codex overhead; they are
not just the newly appended Beeline text. Cache-hit counts vary between runs.
Structural counts use `o200k_base` over the exact emitted Beeline strings and
count the session rules once at startup. They are a payload measure, not a billing
claim. No latency claim is made by this proof.

## Regression checks

`codex-prompt-delivery.test.ts` covers full cache misses, first-turn rules delivered
once, unchanged warm turns, one changed block, failed delivery, compaction during
a prompt, and empty-block removal. `acp-codex-delivery.test.ts` exercises the real
stdio client against a controlled adapter: negotiated compaction, actual prompt
wire text, native load cache misses, failed resume fallback, and unknown-version
full delivery. Existing Room/corner retention, native resume, ACP, prompt assembly,
and prompt-layer tests cover unchanged lifecycle and transcript behavior.
