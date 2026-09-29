#!/bin/bash
# Poll /content/run.log on a Colab VM; print new lines; exit on REMOTE_DONE.
# Usage: tail_remote.sh <session-name>
S=${1:?session name}
seen=0
while true; do
  out=$(printf 'print(open("/content/run.log").read())\n' | timeout 60 colab exec -s "$S" 2>/dev/null) || { echo "poll failed"; sleep 30; continue; }
  n=$(printf '%s\n' "$out" | wc -l)
  if [ "$n" -gt "$seen" ]; then printf '%s\n' "$out" | tail -n +$((seen+1)) | grep -vE '^\+ |^$'; seen=$n; fi
  printf '%s\n' "$out" | grep -q REMOTE_DONE && exit 0
  sleep 30
done
