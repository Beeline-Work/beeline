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
5. Also lower any `total`, `bootstrapTotal` or `unusedTotal` that is above today's count.
6. Bloat pass. Challenge every storage entry, setting and state/flag added
   this week, and as many `existing before the registry` entries as time
   allows. For each, ask: is it derivable from other stored facts? A
   duplicate of another column or key? A workaround for a bug that should be
   fixed instead? Check production usage read-only (always null, constant,
   never read; `scripts/check-architecture.mjs` lists columns with no reader
   or writer). Then:
   - replace a bootstrap reason with a real one when the entry earns its
     place;
   - open a tightening PR that derives the value or stops writing and reading
     it.
   Dropping a column or deleting production rows waits for the owner: ask in
   the Room with the evidence.
7. Open a PR for needed changes. Candidate invariants must be green. Approved
   rule changes, including relaxations, need no new merge gate.
8. Review all merged invariant and guard changes, the System phrase catalog diff,
   and `docs/corner-state-reference.md` with the owner in this weekly batch.
   Include the PR URLs, reasons and any behavior changes. Review is after the fact;
   neither invariant changes nor new System phrases block CI for approval.
9. Report the PRs reviewed, each finding with file:line, the new PR URL, and the
   week's invariant, phrase and corner reference changes.
