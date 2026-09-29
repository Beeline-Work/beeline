#!/bin/bash
# Render fix patches listed in <dir>/ranges.json ([[label, first, last], ...]) as <dir>/patch_i.mp4, in parallel.
# Usage: render_patches.sh <Composition> <dir> [indices, default all] ; then: python3 splice.py master.mp4 <dir>/ranges.json out.mp4
# Extend a patch past any entry transition (0.18 s) that follows it, or the old outgoing scene flickers back.
COMP=${1:?composition}; DIR=${2:?patch dir}; ONLY=${3:-}
one() {
  read -r i a b <<< "$1"
  npx remotion render $COMP $DIR/patch_$i.mp4 --frames=$a-$b --muted --concurrency=6 --codec=h264 --crf=18 > $DIR/render_$i.log 2>&1
  echo "PATCH $i frames $a-$b exit $?" >> $DIR/progress.log
}
export -f one; export COMP DIR
python3 -c "import json,sys;only=[int(x) for x in sys.argv[1].split(',') if x];[print(i,a,b) for i,(l,a,b) in enumerate(json.load(open('$DIR/ranges.json'))) if not only or i in only]" "$ONLY" | xargs -P 3 -I{} bash -c 'one "{}"'
