"""First-pass word timing for a sung lyric: MMS_FA forced alignment per section window,
cross-checked with whisper word times, snapped to a vocal attack within 90 ms.

Usage: align_words.py --vocals vocals.wav --lyrics lyrics.txt --windows windows.json [--out words_full.json]
windows.json: {"Intro": [0, 5.9], "Verse 1": [5.0, 30.9], "Chorus": [...], "Chorus#2": [...]}
  (repeated section headers get #2, #3; pad each window ~0.5 s; take rough bounds from a
  whisper transcript of the take).
Prints words where aligner and whisper disagree by >150 ms. The aligner is weak on
overlapping lead/backing hooks and repeated shouts — hand-verify those with syllables.py
and chorus-to-chorus offsets (see references/timing.md). Never ship its output unreviewed.
"""
import argparse, json, re
import librosa, numpy as np, torch
from faster_whisper import WhisperModel
from scipy.signal import find_peaks
from torchaudio.pipelines import MMS_FA as bundle

ap = argparse.ArgumentParser()
ap.add_argument('--vocals', required=True)
ap.add_argument('--lyrics', required=True)
ap.add_argument('--windows', required=True)
ap.add_argument('--out', default='words_full.json')
ap.add_argument('--fix', default='{}', help='JSON map of lyric-sheet spellings to display words, e.g. {"DYE-AG-NOSE":"DIAGNOSE"}')
args = ap.parse_args()
WINDOWS = json.load(open(args.windows))
FIX = json.loads(args.fix)

sections, cur, seen = [], None, {}
for line in open(args.lyrics):
    line = line.strip()
    m = re.match(r'\[(.*)\]', line)
    if m:
        name = m.group(1)
        seen[name] = seen.get(name, 0) + 1
        cur = {'name': name if seen[name] == 1 else f'{name}#{seen[name]}', 'words': []}
        sections.append(cur)
        continue
    for tok in re.findall(r"[A-Za-z'\-]+", line):
        cur['words'].append(FIX.get(tok.upper(), tok.upper()))

y, _ = librosa.load(args.vocals, sr=bundle.sample_rate)
model, tokenizer, aligner = bundle.get_model(with_star=False), bundle.get_tokenizer(), bundle.get_aligner()
ctc = lambda w: re.sub(r'[^a-z]', '', w.lower())
out = []
for sec in sections:
    if sec['name'] not in WINDOWS or not sec['words']:
        continue
    a, b = WINDOWS[sec['name']]
    seg = torch.tensor(y[int(a * bundle.sample_rate):int(b * bundle.sample_rate)]).unsqueeze(0)
    with torch.inference_mode():
        em, _ = model(seg)
    spans = aligner(em[0], tokenizer([ctc(w) for w in sec['words']]))
    r = seg.shape[1] / em.shape[1] / bundle.sample_rate
    for w, sp in zip(sec['words'], spans):
        out.append({'text': w, 'section': sec['name'], 'fa': round(a + sp[0].start * r, 3), 'score': round(float(np.mean([x.score for x in sp])), 2)})

wm = WhisperModel('small.en', device='cpu', compute_type='int8', cpu_threads=12)
segs, _ = wm.transcribe(args.vocals, language='en', word_timestamps=True, vad_filter=False)
wh = [(ctc(w.word), w.start) for s in segs for w in s.words if ctc(w.word)]
used = set()
for o in out:
    best = None
    for j, (t, st) in enumerate(wh):
        if j not in used and t == ctc(o['text']) and abs(st - o['fa']) <= 0.35 and (best is None or abs(st - o['fa']) < abs(wh[best][1] - o['fa'])):
            best = j
    if best is not None:
        used.add(best)
        o['wh'] = round(wh[best][1], 3)

ys, sr = librosa.load(args.vocals, sr=22050)
hop = 110
db = 20 * np.log10(librosa.feature.rms(y=ys, frame_length=882, hop_length=hop)[0] + 1e-6)
rise = np.zeros_like(db)
rise[6:-6] = db[12:] - db[:-12]
pk, _ = find_peaks(rise, height=8, distance=12)
onsets = np.arange(len(db))[pk] * hop / sr
for o in out:
    base = o['fa'] if o['score'] >= 0.25 or 'wh' not in o else o['wh']
    near = onsets[np.abs(onsets - base) <= 0.09]
    o['start'] = round(float(near[np.argmin(np.abs(near - base))]) if len(near) else base, 3)
json.dump(out, open(args.out, 'w'), indent=1)
dis = [o for o in out if 'wh' in o and abs(o['wh'] - o['fa']) > 0.15]
print(f"words {len(out)}; low aligner score (<0.25): {sum(o['score'] < 0.25 for o in out)}; aligner/whisper disagree >150 ms: {len(dis)}")
for o in dis:
    print(f"  {o['section']:13s} {o['text']:10s} fa {o['fa']:7.2f} ({o['score']})  wh {o['wh']:7.2f}")
