# Render, verify, patch, ship

## Chunked parallel render

`scripts/render_parallel.sh <Comp> <total_frames> [chunks=10] [par=3] [conc=10]` from the
project dir. Each chunk is a separate browser; a new chunk starts as soon as one finishes;
complete chunks are skipped (re-run to resume). Logs: `out/chunks/progress.log`,
`render_i.log`; proof sheet per chunk. 2:30 @60 fps (9000 frames) took ~45 min wall.
Watch with a Monitor on progress.log that also greps `^Error|An error occurred`.

**Stuck chunk**: a render can hang at "Bundling 100%" forever. Kill only it with a bracket
pattern that can't match your own shell — `pgrep -f "frames=180[0]-2699"` → `kill <pids>` —
never `pkill -f "<plain pattern>"` in a command whose own text contains the pattern (exit
144 = you killed yourself). Re-run that chunk alongside the queue.

Sandbox gotcha: backgrounded `( ... ) &` subshells lose their cwd / get dropped. Use
`xargs -P` scripts (render_parallel / render_patches) or `run_in_background` instead.

## Verify each chunk as it lands (don't wait for all)

- `verify_words.py out/chunks/chunk_i.mp4 a b sheet.png <chunk_start_s>` — word pairs.
- A 18–24 frame contact sheet at the cue moments — read it for: graphics under lyrics,
  blown-out frames, cues firing early/late, state revealed early, dead/empty stretches.
- Fix in code, then patch.

## Patch & splice (surgical fixes, no full re-render)

1. `out/patches/ranges.json` = `[[label, first_frame, last_frame], ...]` (sorted, 60 fps).
   Pad ~0.25 s and **extend past any following entry transition** (else the old outgoing
   scene flickers for a few frames).
2. `scripts/render_patches.sh <Comp> out/patches [indices]`.
3. `python3 scripts/splice.py master.mp4 out/patches/ranges.json new_master.mp4` (frame-exact,
   audio copied; asserts total frames).
4. Check patch edges: MSE of new vs old master at first/last patch frame ≈ 1 (encoder noise).

## Assemble & final checks

```bash
for i in $(seq 0 9); do echo "file 'chunk_$i.mp4'"; done > out/chunks/list.txt
ffmpeg -f concat -safe 0 -i out/chunks/list.txt -i public/full.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart master.mp4
```
- ffprobe: frames == total, duration exact, audio duration equal.
- Seams: MSE across each chunk boundary vs neighbouring pairs. If one looks high (e.g. mid
  iris transition), render those ~6 frames fresh and compare to the master (≈1 = no seam).

## Deliverables

- 1080p60: 2-pass x264 `-b:v 5800k`, aac 192k, faststart (~108 MB for 2:30).
- Phone/share: `scale=720:1280,fps=30 -crf 23 -maxrate 1500k` (~28 MB). SendUserFile it.
- Keep previous versions (`*-v1*`), log render times + the user's `/usage` in `token-log.md`.
- Drive: `gws-axi drive upload <file> --name "..." --account banana.man614305@gmail.com`
  works (token is permanent). Sharing with other people is a permission grant the safety
  classifier blocks — give the user the link + addresses to share, don't work around it.
  Contacts: search the inbox (`gws-axi gmail search --query "<name> in:anywhere"`) — voice
  dictation mangles addresses ("Grips said 23" = gripsed23@gmail.com).
