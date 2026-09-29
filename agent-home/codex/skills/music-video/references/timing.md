# Timing: every word, every hit — verified, not guessed

The user notices 150–300 ms errors ("the words come on a little later than the music";
"the swipe animation is out of sync"). Lyrics must switch on the sung syllable and every
graphic cue must land on its word or a real instrumental hit.

## Pipeline

1. **Stems**: `python -m demucs -n htdemucs --two-stems=vocals -o stems song.wav`
   (analysis venv: `/home/alan/projects/beeline-song/analysis/.venv` has librosa,
   faster-whisper, demucs, torch/torchaudio CPU).
2. **Music map**: `scripts/music_map.py no_vocals.wav song.wav` → beats (grid corrected by
   the measured offset; librosa's grid runs ~20 ms late), big hits, **gaps** (music drops
   out → a cappella moments). Arrangements differ between choruses even when the vocal is
   identical — get gaps per chorus.
3. **First pass**: `scripts/align_words.py --vocals ... --lyrics ... --windows windows.json`
   (MMS_FA per section + whisper cross-check + onset snap). Windows come from a whisper
   transcript of the take (segment start times per line).
4. **Syllable track**: `scripts/syllables.py vocals.wav` → level onsets, pitch steps, dips.
   This is the ground truth for legato lines and for anything the aligner scored < 0.35.
5. **Hand-verify** (this is where the quality comes from):
   - **Choruses are usually the same performance.** Compute the offset between chorus 1 and
     chorus 2 on well-aligned words (it was +43.92 s, all attacks within 30 ms); derive
     chorus 2 from chorus 1, and use the pair to settle ambiguous syllables in either.
     The final chorus's first lines matched chorus 1 + 81.565 s.
   - **Hooks with lead + echo** ("Test Atlas! (Test Atlas!)") collapse the aligner: place
     each word on the syllable events using the chorus-pair consistency.
   - **The singer deviates from the sheet**: an extra "run" in "run it back", a held
     3-second "reassess" instead of the "Assess! Diagnose!" chant, repeated outro shouts.
     Transcribe the window alone (medium.en with a lyric prompt) and follow what is sung.
     Hold a held note's word for the whole note (set its `end`).
   - **Legato lines** have no level dips — use pitch steps; attack-snapping alone put
     Beeline's "while I sleep" one syllable late and "nothing ships" one syllable early.
6. **Timeline**: a `build_timeline.py` (see `examples/build_timeline_testatlas.py`) writes
   `src/fullTimeline.json` = {duration, bpm, beats, hits, gaps, words[{text,start,end}],
   sections{..., drop}}. `sections.drop` sets the downbeat phase. Mark unverified words and
   refuse to render until none remain.

## Verification (after every render)

`scripts/verify_words.py video.mp4 a b sheet.png [video_start_s]` → for every word a frame
2 frames **before** (must show the previous word) and 3 frames **after** (must show this
word). Read the sheet image; a single wrong pair means the timeline is wrong there.
