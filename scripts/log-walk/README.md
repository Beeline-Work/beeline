# Production log walk

Fly keeps about 100 lines of log history, so three collectors on squire stream
`beeline-server`, `beeline-free-agents` and `beeline-voice-livekit` into daily
files, and a daily walk turns the last 24 hours into a report the fix loop reads.
Findings are heuristics, not proof that an incident is new. Everything runs as
the host user from a dedicated checkout of `main`; no Actions runner, host
command grant or DM script is involved.

| Piece | What it does |
| --- | --- |
| `collect.sh` (`beeline-log-collector@<app>.service`) | Streams one app with `flyctl logs`, reconnecting every 10 minutes. `timeout -k` kills a stream that ignores SIGTERM: on 2026-10-31 flyctl did, and server logs stopped for two days. systemd restarts the loop if it dies. Keeps 8 days. |
| `host-walk.sh` (`beeline-log-walk.timer`, 06:40 America/New_York) | Fetches `main` into `~/.local/share/beeline-log-walk/checkout`, runs `walk.mjs` over the last 24 hours and atomically replaces the out directory with `report.md`, `report.json` and `source-sha`. |
| `walk.mjs` | Node builtins only. Coverage first, then errors/refusals, new or up versus the previous day, gone, steady identity loops, identities, routes and background jobs. |
| `install-host.sh <out-dir>` | One-time operator install: checkout, `~/.config/beeline-log-walk.env`, user units, enable. |

The out directory is the fix-loop agent's own home directory on squire (for
Ruby in issues-triage: `<agent home>/user/log-walk/out`), so the agent reads
the report as a plain file. Raw logs and baselines stay in
`~/.local/share/beeline-log-walk/`, outside the Beeline state directory, which
holds keys no runner or report should touch.

Phone **socket** refusals are not logged at all and HTTP refusals never reach
Sentry, so the walk is the only place repeated refusals (a client stuck on a
denied call) show up. A database count of operation outcomes is the durable
replacement for that signal; until it lands the walk is the source.

## Reading the report (fix loop)

1. Check `report.json` `window.to` is this morning. A missing or stale report is
   reported as missing; never reuse an old reading.
2. Read coverage before findings. Head, tail and interior gaps over ten minutes
   go on the card. Zero lines for an app means the collector or Fly login is
   broken (see `collector.err` next to the raw files), not a quiet night.
   Untimestamped lines count as unseen coverage.
3. Then ask, for each of the top errors and refusals and anything new or up:
   - Which code path produces it? Trace the stack or route to a file.
   - Who is hit: a person, an agent, a background job? How many identities?
   - Is it a client calling something it is refused again and again (a loop or
     poll), a real failure, or expected noise?
   - Did it start or grow with a release (compare with the previous day)?
   - Is it already a problem in `problems/*.json` or an open corner?
4. Carry ranked findings into the fix loop with a stable signature
   (app + normalized pattern). Gone patterns need complete coverage in both
   windows. Never put identity ids or raw log lines in cards or public text.

Collector repair and Fly login recovery are operator tasks.
