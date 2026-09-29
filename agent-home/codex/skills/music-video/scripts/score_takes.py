"""Score generated takes: lyric intelligibility, brand-name recognition, where the music ends.

Usage: score_takes.py --lyrics lyrics.txt --brand atlas [--model small.en] [--out scores.jsonl] take1.wav take2.wav ...
Appends one JSON line per take. Use small.en when the box is loaded (it is often
shared with heavy jobs); medium.en is more accurate. On a GPU pass --device cuda.
"""
import argparse, difflib, json, re
import librosa, numpy as np
from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument('takes', nargs='+')
ap.add_argument('--lyrics', required=True)
ap.add_argument('--brand', default='', help='lowercase brand word to count, e.g. atlas')
ap.add_argument('--model', default='small.en')
ap.add_argument('--device', default='cpu')
ap.add_argument('--threads', type=int, default=8)
ap.add_argument('--out', default='scores.jsonl')
args = ap.parse_args()
m = WhisperModel(args.model, device=args.device, compute_type='int8' if args.device == 'cpu' else 'float16', cpu_threads=args.threads)

def norm(s):
    return [w for w in re.sub(r"[^a-z' ]", ' ', s.lower().replace('-', ' ')).split() if w]

ref = norm(re.sub(r'\[.*?\]|\(.*?\)', ' ', open(args.lyrics).read()))
for f in args.takes:
    y, sr = librosa.load(f, sr=22050)
    db = np.array([20 * np.log10(np.sqrt(np.mean(y[int(i * sr / 2):int((i + 1) * sr / 2)] ** 2)) + 1e-9) for i in range(int(len(y) / sr * 2))])
    end = float((np.where(db > -40)[0].max() + 1) / 2) if (db > -40).any() else 0.0
    segs, _ = m.transcribe(f, language='en', beam_size=5, vad_filter=False)
    txt = ' '.join(s.text.strip() for s in segs)
    match = sum(b.size for b in difflib.SequenceMatcher(None, ref, norm(txt)).get_matching_blocks())
    row = {'take': f, 'music_end_s': end, 'lyric_match_pct': round(100 * match / max(1, len(ref))), 'brand_heard': len(re.findall(rf'\b{args.brand}', txt.lower())) if args.brand else None, 'text': txt}
    print(json.dumps(row), flush=True)
    open(args.out, 'a').write(json.dumps(row) + '\n')
