#!/bin/sh
# The hosted VM owns a private rootfs, runtime directory and cgroup tree.
# Squire installs its broker through this real systemd user manager.
set -eu

: "${XDG_RUNTIME_DIR:?hosted runtime directory is required}"
mkdir -p "$XDG_RUNTIME_DIR" /run/systemd/system
chmod 700 "$XDG_RUNTIME_DIR"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  /lib/systemd/systemd --user --log-target=console >"$XDG_RUNTIME_DIR/manager.log" 2>&1 &
  manager_pid=$!
  attempts=0
  until systemctl --user show-environment >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if ! kill -0 "$manager_pid" 2>/dev/null || [ "$attempts" -ge 50 ]; then
      echo 'free-agent: hosted service manager did not start' >&2
      cat "$XDG_RUNTIME_DIR/manager.log" >&2
      exit 78
    fi
    sleep 0.1
  done
fi
systemctl --user start dbus.socket
