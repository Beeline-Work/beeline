#!/bin/sh
# Free starter agent Machine entry point. Runs on every cold boot; a resumed
# (suspended) Machine continues the running helper instead.
set -u
export PATH="$HOME/.local/bin:$PATH"
launcher="$HOME/.local/bin/beeline"

# Install or refresh the published helper bundle. A failed refresh keeps the
# installed one; with nothing installed there is nothing to run.
refresh() {
  if ! BEELINE_LAB=1 /bin/sh /opt/beeline/install.sh; then
    echo "free-agent: helper install failed" >&2
    [ -x "$launcher" ] || exit 1
  fi
}

child=
stop() {
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null && wait "$child"
  exit 0
}
trap stop INT TERM

# The helper never updates itself here: when it exits (for example because
# the server requires a newer helper), refresh and start it again.
while :; do
  refresh
  "$launcher" free-agent &
  child=$!
  wait "$child"
  status=$?
  child=
  echo "free-agent: helper exited with status $status; restarting" >&2
  sleep 2
done
