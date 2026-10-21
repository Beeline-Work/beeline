# Free-agent token admission and Pi instruction proof

Reproductions `SUB0ZERO-admission` and `SUB0ZERO-Pi-prefix`, measured 2026-10-21.
No customer content is retained in this document, the tests or the replay.

## Production cause

SUB0ZERO received a daily refusal at 2026-10-20 14:56:48.657482 UTC with
2,135,302 settled tokens and 864,698 of its 3M allowance remaining. Its 77
`model_usage` events reconcile with `free_agent_usage`:

```
599,874 uncached + 5,726,204 cached * 0.25 + 103,877 completion = 2,135,302
```

Read-only reconstruction with the Machine's installed Pi message converter,
excluding the last zero-usage refusal response, produced 171 messages and
2,719,303 UTF-8 JSON bytes. No data URLs or encrypted-reasoning entries were
present. There were 31,901 `reasoning.text` fragments with 244,809 text bytes;
serialized `reasoning_details` occupied 2,377,146 bytes. Repeated fragment
metadata dominated the transport size.

The old message-only estimate is `ceil(2,719,303 / 3) + 256 = 906,691`, already
greater than 864,698 remaining before adding the unavailable historical system
prompt and schemas. The image hypothesis was not confirmed. Cache reads already
settled at 0.25; the issue was admission's wire-size estimate.

## Admission replay

`apps/server/src/free-agent-model-proxy.test.ts` drives the real HTTP proxy
against an isolated migrated PGlite database and a deterministic upstream.
Its customer-content-free stand-in has the same total message bytes, reasoning
fragment count and reasoning-text bytes. This is a size/shape reconstruction,
not the original request: the exact historical system/schema payload was never
recorded, and original user data may not be retained.

The old estimator refuses that shape with 864,698 remaining. The new admission
path returns the upstream reply, forwards reasoning fragments unchanged, and
settles a fixture report of 170,000 input / 165,000 cached / 500 completion to
exactly 46,750 additional allowance tokens (new balance 2,182,052). These fixture
usage values demonstrate settlement arithmetic, not an actual provider replay.
A second HTTP test verifies a matching observed warm prefix receives the 0.25
weight and an ensuing complete cache miss still settles exactly. Parallel calls
share a 32,768-token maximum outstanding admission uncertainty pool per owner/day.
Binary image blocks/data URLs and encrypted reasoning fail validation before any
reservation. Cold or unverified prefixes cannot claim a cache hit.

Run:

```sh
npm run test -w @beeline/server -- src/free-agent-prompt-budget.test.ts src/free-agent-model-proxy.test.ts --maxWorkers=2 --minWorkers=1
```

## Instruction replay

`scripts/prove-free-agent-instructions.ts` runs the real `AcpClient` over stdio
with an isolated deterministic harness, current-main Room/free-agent instructions,
neutral retained context and SUB0ZERO's measured 16-turn / 78-call shape. It counts
full before/after model-context strings using **tiktoken o200k_base**, not the
DeepSeek native tokenizer. This table therefore measures a synthetic session of
comparable size, not historical native input counts or actual task quality.

Only exact repeated instruction blocks and their separating whitespace differ.
The proof asserts that all task/tool-result history is identical after removing
those copies, restores instructions after compaction, and preserves an attached
image block at the ACP boundary. New session, failed/repaired session, changed
instructions, each new compaction and unreadable journal behavior also have
unit regressions. No history-compaction feature is introduced.

Run (Python needs tiktoken; `TOKENIZER_PYTHONPATH` can select an isolated install):

```sh
node --import tsx scripts/prove-free-agent-instructions.ts
```

| Turn | Call | Before input | After input | Saved |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 101847 | 101847 | 0 |
| 1 | 2 | 101859 | 101859 | 0 |
| 1 | 3 | 101871 | 101871 | 0 |
| 1 | 4 | 101883 | 101883 | 0 |
| 1 | 5 | 101895 | 101895 | 0 |
| 1 | 6 | 101907 | 101907 | 0 |
| 1 | 7 | 101919 | 101919 | 0 |
| 1 | 8 | 101931 | 101931 | 0 |
| 1 | 9 | 101943 | 101943 | 0 |
| 1 | 10 | 101955 | 101955 | 0 |
| 1 | 11 | 101967 | 101967 | 0 |
| 1 | 12 | 101979 | 101979 | 0 |
| 2 | 1 | 103837 | 102000 | 1837 |
| 2 | 2 | 103849 | 102012 | 1837 |
| 3 | 1 | 105707 | 102033 | 3674 |
| 3 | 2 | 105719 | 102045 | 3674 |
| 4 | 1 | 107577 | 102066 | 5511 |
| 5 | 1 | 109435 | 102087 | 7348 |
| 6 | 1 | 111293 | 102108 | 9185 |
| 6 | 2 | 111305 | 102120 | 9185 |
| 6 | 3 | 111317 | 102132 | 9185 |
| 6 | 4 | 111329 | 102144 | 9185 |
| 6 | 5 | 111341 | 102156 | 9185 |
| 6 | 6 | 111353 | 102168 | 9185 |
| 6 | 7 | 111365 | 102180 | 9185 |
| 6 | 8 | 111377 | 102192 | 9185 |
| 6 | 9 | 111389 | 102204 | 9185 |
| 6 | 10 | 111401 | 102216 | 9185 |
| 7 | 1 | 113259 | 102237 | 11022 |
| 7 | 2 | 113271 | 102249 | 11022 |
| 7 | 3 | 113283 | 102261 | 11022 |
| 7 | 4 | 113295 | 102273 | 11022 |
| 7 | 5 | 113307 | 102285 | 11022 |
| 8 | 1 | 115165 | 102306 | 12859 |
| 8 | 2 | 115177 | 102318 | 12859 |
| 8 | 3 | 115189 | 102330 | 12859 |
| 8 | 4 | 115201 | 102342 | 12859 |
| 9 | 1 | 117059 | 102363 | 14696 |
| 10 | 1 | 118917 | 102384 | 16533 |
| 10 | 2 | 118929 | 102396 | 16533 |
| 10 | 3 | 118941 | 102408 | 16533 |
| 10 | 4 | 118953 | 102420 | 16533 |
| 10 | 5 | 118965 | 102432 | 16533 |
| 10 | 6 | 118977 | 102444 | 16533 |
| 10 | 7 | 118989 | 102456 | 16533 |
| 10 | 8 | 119001 | 102468 | 16533 |
| 11 | 1 | 120859 | 102489 | 18370 |
| 11 | 2 | 120871 | 102501 | 18370 |
| 11 | 3 | 120883 | 102513 | 18370 |
| 11 | 4 | 120895 | 102525 | 18370 |
| 11 | 5 | 120907 | 102537 | 18370 |
| 11 | 6 | 120919 | 102549 | 18370 |
| 11 | 7 | 120931 | 102561 | 18370 |
| 11 | 8 | 120943 | 102573 | 18370 |
| 11 | 9 | 120955 | 102585 | 18370 |
| 11 | 10 | 120967 | 102597 | 18370 |
| 11 | 11 | 120979 | 102609 | 18370 |
| 11 | 12 | 120991 | 102621 | 18370 |
| 11 | 13 | 121003 | 102633 | 18370 |
| 11 | 14 | 121015 | 102645 | 18370 |
| 11 | 15 | 121027 | 102657 | 18370 |
| 11 | 16 | 121039 | 102669 | 18370 |
| 11 | 17 | 121051 | 102681 | 18370 |
| 11 | 18 | 121063 | 102693 | 18370 |
| 12 | 1 | 122921 | 102714 | 20207 |
| 13 | 1 | 124779 | 102735 | 22044 |
| 14 | 1 | 126637 | 102756 | 23881 |
| 14 | 2 | 126649 | 102768 | 23881 |
| 14 | 3 | 126661 | 102780 | 23881 |
| 14 | 4 | 126673 | 102792 | 23881 |
| 14 | 5 | 126685 | 102804 | 23881 |
| 14 | 6 | 126697 | 102816 | 23881 |
| 15 | 1 | 128555 | 102837 | 25718 |
| 16 | 1 | 130413 | 102858 | 27555 |
| 16 | 2 | 130425 | 102870 | 27555 |
| 16 | 3 | 130437 | 102882 | 27555 |
| 16 | 4 | 130449 | 102894 | 27555 |
| 16 | 5 | 130461 | 102906 | 27555 |

Total: **9,034,168 → 7,985,241 input tokens**, saving **1,048,927 (11.6%)**
across 78 synthetic model-call contexts, or 65,558 tokens per turn. No model
completion was generated for this token comparison. Real-model task quality
is not proven by this deterministic transport replay.
