#!/bin/bash
# Render a ~20 s approval sample straight from the FULL composition (so it is exactly what
# the full render will produce), as 3 parallel parts, then mux the matching audio slice.
# Usage (from the Remotion project dir): render_sample.sh <Composition> <start_s> <end_s> <audio.wav> [out.mp4]
COMP=${1:?}; S0=${2:?}; S1=${3:?}; AUDIO=${4:?}; OUT=${5:-out/sample.mp4}
A=$(python3 -c "print(round($S0*60))"); B=$(python3 -c "print(round($S1*60)-1)")
N=3; SIZE=$(( (B - A + N) / N ))
mkdir -p out/sample; rm -f out/sample/progress.log
one() {
  i=$1; a=$((A + i*SIZE)); b=$((a + SIZE - 1)); [ $b -gt $B ] && b=$B
  npx remotion render $COMP out/sample/part_$i.mp4 --frames=$a-$b --muted --concurrency=8 --codec=h264 --crf=18 > out/sample/render_$i.log 2>&1
  echo "PART $i frames $a-$b exit $?" >> out/sample/progress.log
}
export -f one; export A B SIZE COMP
seq 0 $((N-1)) | xargs -P 3 -I{} bash -c 'one {}'
printf "file 'part_0.mp4'\nfile 'part_1.mp4'\nfile 'part_2.mp4'\n" > out/sample/list.txt
ffmpeg -v error -y -f concat -safe 0 -i out/sample/list.txt -ss $S0 -t $(python3 -c "print(($B-$A+1)/60)") -i "$AUDIO" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart "$OUT"
echo "SAMPLE_DONE $OUT" >> out/sample/progress.log
