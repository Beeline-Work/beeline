# Production raw log collectors

Fly keeps about 100 lines of log history. Three collectors on squire stream
`beeline-server`, `beeline-free-agents` and `beeline-voice-livekit` into daily
files. The daily report walk has been retired; these collectors remain live.

Run `bash scripts/log-walk/install-host.sh` as the host user for a one-time
install. It prepares a dedicated checkout of `main` at
`~/.local/share/beeline-log-walk/checkout`, writes the collector environment,
and installs and enables only `beeline-log-collector@<app>.service` units.

Raw logs land at
`~/.local/share/beeline-log-walk/raw/<app>/<UTC date>.log`.
`collector.err` next to each app's daily files records stream errors.
These paths retain their historical names and stay outside Beeline state.

`collect.sh` reconnects `flyctl logs` every ten minutes, forcibly terminating
streams that ignore SIGTERM. systemd restarts the collector if it dies.
Collectors keep eight days of logs. Collector repair and Fly login recovery
are operator tasks.
