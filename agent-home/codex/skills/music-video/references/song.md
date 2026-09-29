# Song: concept → lyrics → previews → full take

## 1. Concept (read the product first)

- Read the product repo: `PRODUCT.md`/`DESIGN.md`/README, the landing-page copy (grep the
  landing components for long strings), brand tokens (CSS `--*` vars), fonts (index.html
  Google Fonts link), the logo/mark (public/, favicon.svg).
- Pull the *hooks the product already has*: taglines, the core mechanism (e.g. "Assess.
  Diagnose. Drill. Reassess."), the payoff moment (e.g. "The score moved. Here's the
  receipt."), concrete details (e.g. "poison words: always / never / every").
- Pitch 2 directions to the user (e.g. stadium stomp-clap hype vs hyperpop/chiptune) plus a
  draft chorus, and flag guardrails: no specific outcome claims (no "+200 points"), no
  competitor/trademark names except descriptive use, no prices in lyrics.

## 2. Lyrics — the bar the user holds

The user rejected a first draft as "nothing rhymes, not catchy, just stitched-together
words". Rules that produced an approved lyric:

- Write a real song: verse → pre-chorus → chorus → verse → pre → chorus → bridge → final
  chorus → outro. Every couplet rhymes (way/away, again/been, out/doubt, good/could).
- The chorus needs a chantable hook built on the *brand name* and ideally wordplay
  ("Test **At-las** … I cracked it **at last**").
- Concrete, visual lines in the verses (cold coffee, highlighter, battery running on no
  rest, "show your mom the receipt") — every line should suggest an image; the video is
  built from them.
- Crowd shouts in parentheses: `(Hey!)`, `(Show 'em, show 'em!)`. ACE-Step sings these as
  backing vocals.
- Respell hard words so they're sung cleanly: `Dye-ag-nose`, `Re-assess`.
- **Brand names: write them plainly** ("Atlas"). Hyphenated/phonetic respellings ("At-las",
  "AT-liss", "At-lus") were sung as "at last" or garbage; plain "Atlas" was heard as Atlas.
  Test 3–4 spellings as 16 s snippets in the same GPU job before the full take.
- Fit the length: at ~150 BPM a verse of 8 lines ≈ 25 s, chorus of 8 lines ≈ 25 s. For
  2:30 shorten verse 2 / the second pre-chorus / the final chorus.

## 3. Generation: ACE-Step 1.5 on a free Colab T4 (Apache-2.0, commercial OK)

Scripts: `scripts/colab/gen_jobs.py` (loads models once, runs a jobs list),
`scripts/colab/remote_run.sh` (installs ACE-Step at a pinned commit, patches the DiT to
fp32, downloads the main model **and** `acestep-5Hz-lm-0.6B`, runs the jobs),
`scripts/colab/tail_remote.sh <session>`.

```bash
BROWSER=echo timeout 300 colab new --gpu T4 -s <name> < /dev/null     # no re-auth needed once granted
for f in gen_jobs.py remote_run.sh jobs.json lyrics.txt caption.txt; do colab upload -s <name> $f /content/$f; done
printf 'import subprocess\nsubprocess.Popen("nohup bash /content/remote_run.sh --jobs jobs.json --lm acestep-5Hz-lm-0.6B --backend pt --fp32 --no-offload --no-cot > /content/run.log 2>&1 &", shell=True)\n' | colab exec -s <name>
tail_remote.sh <name>        # then: colab download -s <name> /content/versions/X.wav local/X.wav
colab stop -s <name>         # free the quota when done
```

jobs.json: `[{"name","caption","lyrics","bpm","duration","seeds":[...]}]` (paths relative
to /content). Timings on T4: models load ~85 s; a 20 s take ~10 s; a 150 s take ~69 s.

Hard-won T4 facts: fp16 → NaN latents / 0 audio codes (hence DiT fp32 patch +
`ACESTEP_DIT_FP32=1`); the 1.7B LM OOMs; offloading OOMs the 12 GB RAM; the 0.6B LM is not
in the default download. **Free tier = one GPU session at a time** (a second `colab new`
is refused) and idle sessions are reclaimed within ~30 min. First-time OAuth needs the user
in manual-permission mode to approve.

Captions: `examples/caption_hyperpop.txt` (the chosen style for both products),
`examples/caption_stomp_clap.txt`. Keep under ~500 chars, use `--no-cot`.

## 4. Previews and picking takes

- Previews: the pre-chorus chant + chorus only, `duration` ~20–26 s, 3 seeds per style.
  Same lyric for every style so the user compares style only.
- Score every take (`scripts/score_takes.py --lyrics ... --brand atlas`): lyric-match %,
  brand heard count, where the music ends (takes are shorter than `duration`; trim there).
- Trim + fade + loudness-match before sending (`loudnorm=I=-14:TP=-1`), send with
  SendUserFile, label A/B/A2 with what each does well/badly. You can't listen — say so, the
  user's ear decides.
- Full song: 3 seeds × each spelling variant; prefer the seed the user liked in preview.
  Read the transcript: reject takes that skip a verse or change the hook.
- Whisper can't separate near-homophones ("Atlas"/"at last"); CTC forced-alignment scoring
  of both transcripts was inconclusive. Point the user to exact hook timestamps instead.
- The box is often heavily loaded (load ~50): score with `small.en` or on the Colab GPU.
