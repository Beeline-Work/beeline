#!/bin/sh
# Free starter agent Machine entry point. Runs on every cold boot; a resumed
# (suspended) Machine continues the running helper instead.
set -u
export PATH="$HOME/.local/bin:$PATH"
launcher="$HOME/.local/bin/beeline"
# One budget across refreshes and failed launches, not a new budget per retry.
BEELINE_FREE_AGENT_START_DEADLINE=$(($(date +%s) + 300))
BEELINE_FREE_AGENT_READY_FILE=$(mktemp)
rm -f "$BEELINE_FREE_AGENT_READY_FILE"
export BEELINE_FREE_AGENT_START_DEADLINE BEELINE_FREE_AGENT_READY_FILE
check_deadline() {
  if [ ! -f "$BEELINE_FREE_AGENT_READY_FILE" ] &&
    [ "$(date +%s)" -ge "$BEELINE_FREE_AGENT_START_DEADLINE" ]; then
    echo "free-agent: startup deadline exhausted; stopping this boot" >&2
    exit 78
  fi
}

# Install or refresh the published helper bundle. A failed refresh keeps the
# installed one; with nothing installed there is nothing to run.
refresh() {
  BEELINE_LAB=1 timeout --kill-after=5 120 /bin/sh /opt/beeline/install.sh &
  child=$!
  installer_group=$child
  wait "$child"
  install_status=$?
  installer_group=
  child=
  if [ "$install_status" -ne 0 ]; then
    echo "free-agent: helper install failed" >&2
    [ -x "$launcher" ] || exit 1
  fi
}

child=
installer_group=
stop() {
  trap - INT TERM USR1
  stop_signal=TERM
  if [ "${1:-0}" -eq 78 ]; then
    stop_signal=KILL
    # timeout owns a separate process group; stop its download children too.
    [ -z "$installer_group" ] || /bin/kill -KILL -- "-$installer_group" 2>/dev/null || :
  fi
  [ -n "$child" ] && kill -"$stop_signal" "$child" 2>/dev/null && wait "$child"
  rm -f "$BEELINE_FREE_AGENT_READY_FILE"
  exit "${1:-0}"
}
trap stop INT TERM
trap 'echo "free-agent: startup watchdog expired; stopping this boot" >&2; stop 78' USR1
parent=$$
# Covers a failed download falling back to an old helper without its own timer.
# Give the current helper ten seconds to report its own deadline first.
(
  while [ ! -f "$BEELINE_FREE_AGENT_READY_FILE" ] &&
    [ "$(date +%s)" -lt "$((BEELINE_FREE_AGENT_START_DEADLINE + 10))" ]; do
    sleep 1
  done
  [ -f "$BEELINE_FREE_AGENT_READY_FILE" ] || kill -USR1 "$parent"
) &
watchdog=$!
trap 'kill "$watchdog" 2>/dev/null || :; rm -f "$BEELINE_FREE_AGENT_READY_FILE"' EXIT

# Persistent rootfs may contain a helper from any earlier release. Reconcile
# before supervision, including when its old socket never reached the server.
refresh

# The helper never updates itself here: when it exits (for example because
# the server requires a newer helper), refresh and start it again.
while :; do
  check_deadline
  [ -x "$launcher" ] || refresh
  "$launcher" free-agent &
  child=$!
  wait "$child"
  status=$?
  child=
  # Startup watchdog failure is terminal for this boot, not another retry.
  [ "$status" -eq 78 ] && exit 78
  check_deadline
  echo "free-agent: helper exited with status $status; restarting" >&2
  refresh
  sleep 2
done
