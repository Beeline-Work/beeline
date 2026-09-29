"""Syllable-start events on an isolated vocal stem: level onsets, >=1-semitone pitch steps
inside voiced runs, and level dips between legato syllables.
Usage: syllables.py vocals.wav [out.json]   ->  [[t, 'on'|'pitch'|'dip', note], ...]
Print a window with:  python3 -c "import json;print([e for e in json.load(open('syllables.json')) if 30<e[0]<44])"
"""
import json, sys
import librosa, numpy as np

ys, sr = librosa.load(sys.argv[1], sr=22050)
hop = 441
f0, _, _ = librosa.pyin(ys, fmin=110, fmax=1000, sr=sr, hop_length=hop, frame_length=2048)
S = np.abs(librosa.stft(ys, n_fft=1024, hop_length=hop))
db = 20 * np.log10(librosa.feature.rms(S=S, frame_length=1024)[0] + 1e-6)
n = min(len(db), len(f0))
ev, prev_on, prev_midi = [], False, None
for i in range(n):
    t = i * hop / sr
    on = db[i] > -33
    midi = librosa.hz_to_midi(f0[i]) if not np.isnan(f0[i]) else None
    if on and not prev_on:
        ev.append([round(t, 2), 'on', librosa.midi_to_note(round(midi)) if midi else '-'])
    elif on and midi is not None and prev_midi is not None and abs(midi - prev_midi) >= 1.0:
        ev.append([round(t, 2), 'pitch', librosa.midi_to_note(round(midi))])
    prev_on, prev_midi = on, (midi if on else None)
for i in range(2, n - 2):
    if db[i] > -33 and db[i] < db[i - 2] - 6 and db[i] < db[i + 2] - 6:
        ev.append([round(i * hop / sr + 0.02, 2), 'dip', '-'])
ev.sort()
json.dump(ev, open(sys.argv[2] if len(sys.argv) > 2 else 'syllables.json', 'w'))
print(len(ev), 'events')
