# Production log walk

Repository code reads the existing collector files on squire. It never executes
Ruby's DM script or changes collectors, Fly login, grants or approval policy.
The original DM file is unavailable in a corner; this implementation reconstructs
the sections from the saved `log-walk` procedure. Findings are heuristics, not
proof that an incident is new. The fixture exercises the actual CLI and both
report files, baseline comparison, loops and head/tail/interior coverage behavior.

The private `Production log walk` workflow runs near 06:40 America/New_York and
also accepts dispatches on main. The two UTC cron slots cover daylight saving;
only the slot in the local morning hour reads logs. GitHub can delay scheduled
jobs. Its own concurrency group and short timeout bound runner use. Node builtins
stream lines without installing project dependencies. Baselines live outside the
checkout at `/home/lunchbox/.local/state/beeline/log-walk-reviewed/state`.
The collector raw directory is read only. No human script read or host grant is
part of this path. The workflow requires the normal independent review and merge
before any production execution.

## Replacement `log-walk` procedure for Ruby

During the 07:00 feedback-triage pull step, download the latest private Actions
report instead of running a host command. From the linked Beeline checkout:

```sh
gh api 'repos/Beeline-Work/beeline/actions/artifacts?per_page=100' \
  --jq '[.artifacts[] | select(.expired == false and .workflow_run.head_branch == "main" and (.name | startswith("log-walk-")))] | sort_by(.created_at) | last | {run: .workflow_run.id, name, created_at}'
gh run download <run> --repo Beeline-Work/beeline --name <name> --dir <fresh-local-directory>
```

Read `report.md` first; use `report.json` only to drill down. Check `window.to`
is today's morning and covers the intended 24 hours. If no fresh artifact exists,
report the missing reading and inspect the workflow failure; do not reuse an old
reading as today's. Recovery after merge: `gh workflow run log-walk.yml --ref main
--repo Beeline-Work/beeline`. No host command grant is needed.

Read coverage before findings. Head, tail and interior gaps over ten minutes
must appear in the card. Zero free-agent traffic needs independent confirmation
that machines were suspended; the walk does not assume that. Untimestamped lines
are counted as unseen coverage. Minute buckets make gap estimates conservative
by up to a minute. Incomplete coverage must never become “nothing found.”

Then read errors/refusals, new or up vs baseline, gone, loops, heaviest identities,
busiest routes and background job counts. The first run has no baseline; same-day
reruns continue comparing with the prior saved day. Gone patterns need complete
coverage in both windows before interpretation. Dedupe against `problems/*.json`
and `digests/*.md` in beeline-insights, trace top findings to code, classify them
as broken/friction/waste and carry ranked `source: "log"` groups into triage.
Resolve flagged identities through the approved database connection as needed.
Never put identity ids or raw log lines in cards or public text. Report artifacts
remain in the private repository and expire after fourteen days.

Collector repair and login recovery remain a separate authorized operator task;
this report-download procedure does not run or restart collectors. The 10:00
loops writer downloads the same artifact instead of reading the old DM output.
