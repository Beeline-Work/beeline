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

The two-failure case asserts the real full-suite command, not any test run:
its matcher requires a mobile-scoped `vitest` or `npm test` invocation and
rejects a command naming a `.test.` file, so `npm --prefix apps/mobile test`,
`npm test --prefix apps/mobile` and `cd apps/mobile && npx vitest run` pass
while `npx vitest run sources/buzz/live-turn-stream.test.ts` does not. The
case grades suite-before-push: it requires the full suite to run and rejects a
`git push` that precedes the first full-suite run. It does not require the
agent to push.

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
| `checks-runs-suite-before-push` | PASS 3/3 | PASS 3/3 |
| `checks-reports-blocked-after-third-failure` | PASS 3/3 | PASS 3/3 |

For `checks-runs-suite-before-push`, every sample in both variants ran the
full mobile suite (`cd apps/mobile && npx vitest run`, or a mobile-scoped
`npm test`) before the first `git push`, so the suite-before-push assertion
held 3/3 with the rule and 3/3 without it. This model already runs the full
suite on its own, so this sample does not separate the two variants; the case
still fixes the required behavior and rejects a single-file run.

`checks-reports-blocked-after-third-failure` passed on both variants: after a
third failure every sample reported `blocked:` naming `live-turn-stream` or
`draft-settle` and none pushed.

## Data limitation

`read(facet:checks)` exposes the current head's rollup only: `checks`,
`checkCount`, `checkStates` (`passed`/`pending`/`failed` counts and up to ten
`pendingNames`/`failedNames`), `headSha`, `pullRequest`, `reviewerWake` and the
merge gate. It does not expose per-suite run history or a count of prior runs,
so an agent counts failures from its own turn history and the corner
transcript. No server feature was added for this rule.
