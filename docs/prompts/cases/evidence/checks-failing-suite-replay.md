# Repeated-failing-suite replay evidence

Two prompt cases measure the checks-turn rule added to `turn.checks`:
after two failed CI runs on the same suite, run that suite locally before
pushing again; after a third, report `blocked:` naming the failing tests.

## Reproduced

Not a defect report. Reproduction `repeated-failing-suite-replay` is a
measurement: two cases, replayed with and without the rule, three independent
samples per variant (12 samples). The independent replay used Claude Code
2.1.301 with `--model opus`, against the two case prompts exported by
`npm run prompt-cases -- --export`. The "without rule" variant used
`--source` pointed at a clean checkout of `main` (the same commit this branch
starts from), so only the `turn.checks` text differs between the two variants.
Raw transcripts are retained with this corner's report; they are not copied
into this public repository.

Commands:

```
npm run prompt-cases -- --only checks-runs-suite-before-push,checks-reports-blocked-after-third-failure --export /tmp/replay/with
npm run prompt-cases -- --source <main-checkout> --only checks-runs-suite-before-push,checks-reports-blocked-after-third-failure --export /tmp/replay/without
claude -p --tools "" --strict-mcp-config --model opus < <dir>/<id>.prompt.md > <dir>/<id>.<n>.json
npm run prompt-cases -- --grade <dir>
```

## Demonstrated

| Case | With rule | Without rule |
| --- | --- | --- |
| `checks-runs-suite-before-push` | PASS 3/3 | FAIL 0/3 |
| `checks-reports-blocked-after-third-failure` | PASS 3/3 | PASS 3/3 |

With the rule, every sample ran the mobile suite locally and only then pushed
the committed fix, so `checks-runs-suite-before-push` passed 3/3. On the
same case without the rule, every sample ran the mobile suite but stopped and
reported `blocked:` instead of pushing the committed fix, so the ordered
suite-then-push assertion failed 0/3.

`checks-reports-blocked-after-third-failure` passed on both variants: after a
third failure every sample reported `blocked:` naming `live-turn-stream` or
`draft-settle` and none pushed. This model already stops after three failures,
so this case documents the required behavior rather than separating the two
variants.

## Data limitation

`read(facet:checks)` exposes the current head's rollup only: `checks`,
`checkCount`, `checkStates` (`passed`/`pending`/`failed` counts and up to ten
`pendingNames`/`failedNames`), `headSha`, `pullRequest`, `reviewerWake` and the
merge gate. It does not expose per-suite run history or a count of prior runs,
so an agent counts failures from its own turn history and the corner
transcript. No server feature was added for this rule.
