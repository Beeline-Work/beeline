#!/bin/bash
# Render a Remotion composition in N chunks, PAR at a time (each its own browser), with a
# proof sheet per chunk as it lands. Complete chunks are skipped, so re-running resumes.
# Usage (from the Remotion project dir): render_parallel.sh <Composition> <total_frames> [chunks=10] [par=3] [concurrency=10]
COMP=${1:?composition id}; TOTAL=${2:?total frames}; N=${3:-10}; PAR=${4:-3}; CONC=${5:-10}
SIZE=$(( (TOTAL + N - 1) / N ))
SKILL=$(dirname "$(readlink -f "$0")")
mkdir -p out/chunks
date +%s > out/chunks/start
one() {
  i=$1; a=$((i*SIZE)); b=$(( (i+1)*SIZE - 1 )); [ $b -ge $TOTAL ] && b=$((TOTAL-1))
  have=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 out/chunks/chunk_$i.mp4 2>/dev/null | tr -d ,)
  if [ "$have" = "$((b-a+1))" ]; then echo "CHUNK $i already complete" >> out/chunks/progress.log; return; fi
  t0=$(date +%s)
  npx remotion render $COMP out/chunks/chunk_$i.mp4 --frames=$a-$b --muted --concurrency=$CONC --codec=h264 --crf=18 > out/chunks/render_$i.log 2>&1
  echo "CHUNK $i frames $a-$b done in $(( $(date +%s)-t0 ))s (exit $?)" >> out/chunks/progress.log
  python3 $SKILL/chunkproof.py out/chunks/chunk_$i.mp4 $a out/chunks/proof_$i.png >> out/chunks/progress.log 2>&1
}
export -f one; export TOTAL SIZE COMP CONC SKILL
seq 0 $((N-1)) | xargs -P $PAR -I{} bash -c 'one {}'
for i in $(seq 0 $((N-1))); do echo "file 'chunk_$i.mp4'"; done > out/chunks/list.txt
echo "ALL_CHUNKS_DONE in $(( $(date +%s) - $(cat out/chunks/start) ))s" >> out/chunks/progress.log
