"""Map the instrumental: beat grid (+ its offset vs the drums), big hits, and the gaps
where the music drops out (a cappella moments). Usage: music_map.py no_vocals.wav full_mix.wav [out.json]
Beat times in the output are already corrected by the measured grid offset (librosa runs ~20 ms late).
"""
import json, sys
import librosa, numpy as np
from scipy.signal import find_peaks

m, sr = librosa.load(sys.argv[1], sr=22050)
y, _ = librosa.load(sys.argv[2], sr=22050)
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units='time')
_, yp = librosa.effects.hpss(m)
env = librosa.onset.onset_strength(y=yp, sr=sr, hop_length=64)
te = librosa.times_like(env, sr=sr, hop_length=64)
offs = []
for b in beats:
    i0, i1 = np.searchsorted(te, [b - 0.12, b + 0.12])
    if i1 - i0 < 3:
        continue
    j = np.argmax(env[i0:i1])
    if env[i0 + j] > np.percentile(env, 90):
        offs.append(te[i0 + j] - b)
off = float(np.median(offs)) if offs else 0.0
hop = 110
db = 20 * np.log10(librosa.feature.rms(y=m, frame_length=882, hop_length=hop)[0] + 1e-6)
tt = np.arange(len(db)) * hop / sr
rise = np.zeros_like(db)
rise[6:-6] = db[12:] - db[:-12]
pk, _ = find_peaks(rise, height=14, distance=40)
gaps, s = [], None
for i, q in enumerate(db < -38):
    if q and s is None:
        s = i
    if not q and s is not None:
        if tt[i] - tt[s] > 0.4:
            gaps.append([round(float(tt[s]), 2), round(float(tt[i]), 2)])
        s = None
out = {'tempo': float(np.atleast_1d(tempo)[0]), 'grid_offset': off, 'beats': [round(float(b) + off, 3) for b in beats],
       'hits': [round(float(tt[p]), 3) for p in pk], 'gaps': gaps}
json.dump(out, open(sys.argv[3] if len(sys.argv) > 3 else 'music_full.json', 'w'))
print(f"tempo {out['tempo']:.1f}, grid offset {1000*off:+.0f} ms, {len(out['hits'])} hits, gaps {gaps}")
