# Weekly architecture audit (scheduled agent prompt)

Schedule this as a weekly wake for the auditing agent in the Beeline Room
that owns this repository:

```
wake(action: "create", trigger: "schedule", title: "Architecture audit",
  cadence: { kind: "cron", expression: "0 9 * * 1", timeZone: "UTC" },
  prompt: "Run the weekly architecture audit in architecture/weekly-audit.md.")
```

## Prompt

1. List the PRs merged into `main` in the last 7 days
   (`gh pr list --state merged --search "merged:>=<date 7 days ago>" --json number,title,files`).
2. Read `architecture/invariants.json` and `architecture/README.md`.
3. For each merged PR, look for:
   - a new second home for something a module already owns: a second creator,
     writer, registry, dispatcher or definition of a state (duplication);
   - a pattern that bypasses an owner file, such as a raw SQL write, a raw
     notify, a raw timer, a raw merge call or a hand-written membership join
     (anti-pattern).
4. For each finding, prefer a rule that is a pattern plus owner files, with a
   `total` equal to today's count, and a `fix` that names the one compliant
   call. Check it by running `node scripts/check-architecture.mjs`; it must
   pass on `main` with the new rule.
5. Also lower any `total` that is above today's count.
6. Open one PR with only tightening changes: new rules and lower totals. It
   merges without owner review. Never raise a total or widen a rule in this
   PR.
7. If an existing rule is wrong, so that following its `fix` would break
   behaviour, open a separate relaxing PR. Then ask the owner in the Room,
   naming the PR URL and head commit. That PR waits for the owner's yes.
8. Report: the PRs reviewed, each finding with file:line, the tightening PR
   URL, and any relaxing PR URL waiting on the owner.
