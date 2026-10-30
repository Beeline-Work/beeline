# Subscription tool and prompt tuning

This opt-in experiment uses the existing local Codex ChatGPT login. It never
uses an API key, OpenRouter, Squire grants, or a credential-file argument. It does
not change the nightly command, schedule, saved cases, pass rules, production
prompts or production MCP server. The superseded JSON transport comparison arm is removed from this PR; the
existing nightly runner remains unchanged.

After normal checkout preparation (`npm run corner:prepare`), run:

```sh
node --import tsx scripts/prompt-subscription-replay.mjs \
  --model gpt-6-luna --variants full,r0-deferred --partition tune \
  --out "$HOME/prompt-tool-tuning/round-0/luna"
```

Use `gpt-6.1-sol` for Jellybean's other local arm. Earth runs the identical command
with `gpt-5.6-terra` on chad through its own Codex subscription. Each model uses
one fresh sample per case/variant, with replay seed tag (1000). Codex exec has no
provider seed flag: the fixed partition, order and replay seed tag provide
consistent sampling inputs, not guaranteed deterministic generation. Unsupported
model and subscription-limit errors stop that model and retain the exact error.
No model substitution or paid fallback is allowed.

## Frozen split and configs

`scripts/prompt-variants/split.json` fixes tune (54) and held-out (23) cases. The
seed is `deferred-tools-v4-2026-10-30`; ordering uses SHA-256 of seed + colon +
case ID, with the first rounded (70%) assigned to tuning. The same three browser
cases as nightly remain excluded. Cohort drift fails rather than silently
repartitioning. Only tune expectations/transcript calls selected the round-zero
core: Bash (11), report (7), read (5), app_tool (4), open_corner (3),
no_reply_needed (2). The last tie is alphabetical. Generic scenario fallbacks
and negative assertions are not usage evidence.

A named JSON config stores mode, core names, purpose-line overrides, index word
limit, find_tools description, description word limit, explicit prompt text
replacements and appended rules. `full.json` is the untouched full-definition
baseline; `r0-deferred.json` is the initial deferred variant. Add later configs
only from previous tune-round failures and record the one or two levers changed.
Up to three variants may run per tune round. A config is resolved by name from
the pushed branch so it works identically on each machine.

## Native MCP proof and measurements

The child Codex starts in an empty temporary directory with user config, rules,
hooks, apps, plugins, shell, browser, image, and subagent capabilities disabled.
It retains its existing login and its built-in harness instructions. A local
stdio MCP server advertises the case's real full tool definitions or the core
plus find_tools; the prompt carries the remaining names and short purposes.
The actual saved surface is case-dependent: the canonical ordinary tools plus
the runner/file-read tools and fixture-advertised extras (commonly 29 definitions).
It preserves the nightly case-specific tool exposure rather than inventing tools
for cases that never had them.

Every MCP operation is read-only and closed-world because it is a simulation.
It records attempts and returns only case facts or managed skill contents.
Commands, assignments, messages and browser calls are never executed.
find_tools returns matching definitions, enables them for the sample and sends
`notifications/tools/list_changed`; Codex's `mcp_tool_list_changed` feature is
explicitly enabled. Loaded definitions never carry into another sample. Native
host tool usage, unloaded calls, and calls after terminal boundaries fail;
missing scenario facts remain unscored. The existing `evaluateRule` grades the
calls and reply without changing any saved rule. An independent simulator call
limit (24) bounds runaway native turns; exhaustion is unscored, not a pass.

Codex `turn.completed.usage.input_tokens` includes its own harness prompt and
all tool continuations in every arm. Reports use the median and nearest-rank p90
of these aggregate turn counts; cached tokens are retained without subtracting
them. Codex does not expose an underlying model-request count in this event
stream; `modelRequests` is explicitly null. Search calls and all MCP attempts
are counted exactly, so extra tool calls/search calls per sample can be compared
without inventing model-request counts.

Each run saves its configs, split hash, commit, sample calls, returned facts,
JSONL Codex events, final status and summary in result.json. Per-sample prompt,
fixture, stderr and trace files permit inspection. Existing matching samples
resume without reusing a different model, partition or config. Use a fresh
output directory after implementation changes. `--only <tune-case-id>` is for
smoke proofs and marks the result `smokeOnly`; never pool it into a round.

A real subscription smoke proof on both local assigned models exercised full
and deferred native MCP calls. The deferred proof loaded Read and order using
find_tools, refreshed the native tool list, read canned facts and made the
expected order call to the stub. These setup proofs are not round-zero scores.

## Iteration and held-out guard

Compare raw pass/scored rates with unscored counts exposed; compare variants
on the same behavior-scored paired cohort when incomplete facts differ. For
each variant report per-model rates, mean and worst-model rate, median input
size, and its paired denominator. Never claim that missing/unscored samples
passed. A frontier variant has no alternative with strictly higher mean pass
rate and fewer median input tokens. Reject a variant that loses over five
percentage points on any available model against the full baseline.

Choose at most three variants per round from the previous round's failure groups.
Stop after two consecutive rounds with under three percentage points of mean
accuracy improvement and under (500) median input tokens saved, or after eight
rounds. Persist round choices and reasons before running the next round.

Freeze a final selection file with `phase: "final"` and a `variants` array
containing full plus the selected frontier configs. Only then run held-out:

```sh
node --import tsx scripts/prompt-subscription-replay.mjs \
  --model gpt-6-luna --variants full,<selected-names> --partition heldout \
  --selection <frozen-selection.json> --out <new-heldout-output>
```

Held-out execution refuses an absent selection file or a variant outside it.
Do not use its results for another tuning round. Final reporting includes tune
and held-out tables, the frontier and recommendation, failure causes and extra
calls, and an exact config/prompt diff for a separately authorized production
change. No live prompt/tool change ships from this replay PR.

Validation without subscription use:
`node --import tsx --test scripts/prompt-subscription-replay.test.mjs`.
