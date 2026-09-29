---
name: music-video
description: |
  End-to-end hype music video for a product: read the repo, write a catchy original song,
  generate it free on a Colab T4 with ACE-Step 1.5, time every sung word, build a
  lyric-synced animated vertical video in Remotion, render it in parallel chunks, verify
  every word and seam, patch, and ship 1080p60 + phone versions. Use when the user asks for
  a song, jingle, hype/promo music video, lyric video, or animated video for a product
  (built for Beeline and Test Atlas).
---

# Product hype music video (song → synced animated video)

Two finished examples to copy from: Test Atlas `/home/alan/projects/testatlas-song/`
(`video-full/` is the full-song project) and Beeline `/home/alan/projects/beeline-song/`.
Scripts are in `scripts/`, the Remotion engine template in `engine/`, details in
`references/` — read the reference for each phase before doing it.

## User preferences (standing)

- Progress logging on every render; report render times and ask the user to run `/usage`
  before/after — log both in `token-log.md`.
- Show a short **sample before the full thing** (15–20 s audio previews; a 20 s video
  sample cut from the full composition).
- "Make sure it's fixed before you send me the final product": verify in the rendered
  output (frame sheets you actually read), across the whole affected span ±1 s.
- Parallelize: 3 render chunks at a time, continuous queue.
- Deliver: file path on chad (65.109.30.58, user alan) + SendUserFile a phone copy.

## Workflow and checkpoints

1. **Concept** (`references/song.md` §1): read the product repo; pitch 2 styles + a draft
   chorus; state guardrails (no outcome claims, no competitor names, no prices).
   → *User picks direction.*
2. **Lyrics** (§2): real song, rhymed couplets, brand-name hook, one image per line, crowd
   shouts in parens, brand name spelled plainly. Show them.
   → *User approves; expect pushback if it isn't catchy — rewrite properly.*
3. **Previews** (§3–4): Colab T4, 3 seeds × each style, same chorus lyric, score, trim,
   loudness-match, send A/B/A2. → *User picks a style/take.*
4. **Full song**: fit lyrics to the target length (≈2:30); test brand spellings as 16 s
   snippets in the same job; 3+ full takes; score; read transcripts; recommend one, send it
   plus an alt. `colab stop` after. → *User picks.*
5. **Timing** (`references/timing.md`): demucs → `music_map.py` → `align_words.py` →
   `syllables.py` → hand-verify (chorus-pair offsets, hooks, deviations, legato) →
   `build_timeline.py` → `src/fullTimeline.json` with zero unverified words.
6. **Video build** (`references/video.md`): copy `engine/`, re-skin palette/fonts/mark to
   the brand, write scenes one image per phrase, every cue on a word or hit, obey the
   transition/lyric-band rules, run `checkshots.tsx`, look-dev stills.
7. **Sample**: `scripts/render_sample.sh` on the hardest ~20 s (a pre-chorus into a chorus
   drop); verify words + cue sweep; send. → *User approves direction.*
8. **Full render** (`references/render.md`): `render_parallel.sh`; verify each chunk as it
   lands (word sheet + contact sheet); fix via patches; assemble; splice; check seams and
   patch edges; encode 1080p60 + share; send + paths; log.
9. **Feedback rounds**: diagnose from frames/data first, fix only the named span as a
   patch, re-verify the whole affected span, send.

## Non-negotiables (each one cost a round of user feedback)

- Words switch on the sung syllable — verify with before/after frame pairs, never trust a
  single automated aligner (attack-snapping was a syllable off in legato lines).
- No graphic cue inside a 0.18 s entry transition; nothing drawn under the lyric band.
- Descriptive lyrics get their own imagery — no 5 s stretches of one static prop.
- On-screen state never runs ahead of the lyric.
- Kill processes only with bracketed `pgrep -f` patterns; use `xargs -P` scripts, not
  `( ) &` subshells.
- Don't grant Drive access to others yourself; upload, then give the user link + addresses.
