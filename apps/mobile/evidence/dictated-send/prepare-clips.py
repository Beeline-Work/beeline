"""Prepare unmodified LibriSpeech human audio; no synthesis or overlapping cuts."""
import array
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request
import wave

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
source = 'https://www.openslr.org/resources/12/test-clean.tar.gz'
ids = [f'6930-75918-{n:04d}' for n in range(4)]
wanted = {f'{clip}.flac' for clip in ids} | {'6930-75918.trans.txt', 'LICENSE.TXT', 'README.TXT'}
if not all((root / name).exists() for name in wanted):
    with urllib.request.urlopen(source, timeout=60) as response:
        with tarfile.open(fileobj=response, mode='r|gz') as archive:
            for member in archive:
                name = Path(member.name).name
                if member.isfile() and name in wanted:
                    (root / name).write_bytes(archive.extractfile(member).read())
                if all((root / name).exists() for name in wanted):
                    break

rate = 16000
frames = []
for index, clip in enumerate(ids):
    out = root / f'original-{index}.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(root / f'{clip}.flac'), '-ar', str(rate), '-ac', '1', str(out)], check=True)
    with wave.open(str(out)) as wav:
        assert wav.getframerate() == rate and wav.getsampwidth() == 2 and wav.getnchannels() == 1
        frames.append(wav.readframes(wav.getnframes()))

pcm = b''.join(frames)
samples = array.array('h', pcm)
if sys.byteorder != 'little':
    samples.byteswap()
# Locate an actual low-energy pause around each LibriSpeech utterance boundary.
# A fixed 20ms RMS window avoids treating a single zero crossing as silence.
window = rate // 50
silent = [math.sqrt(sum(v*v for v in samples[i:i+window]) / len(samples[i:i+window])) < 200
          for i in range(0, len(samples), window)]
boundaries = []
pauses = []
expected = 0
for data in frames[:-1]:
    expected += len(data) // 2
    middle = expected // window
    candidates = []
    start = None
    for i in range(max(0, middle-25), min(len(silent), middle+26)):
        if silent[i] and start is None:
            start = i
        if not silent[i] and start is not None:
            if i-start >= 5:
                candidates.append((start, i))
            start = None
    if start is not None and min(len(silent), middle+26)-start >= 5:
        candidates.append((start, min(len(silent), middle+26)))
    if not candidates:
        raise RuntimeError('No natural pause near the utterance boundary')
    begin, end = min(candidates, key=lambda pair: abs((pair[0]+pair[1])/2-middle))
    boundary = ((begin+end)//2) * window
    boundaries.append(boundary)
    pauses.append({'startSeconds': begin*window/rate, 'endSeconds': end*window/rate, 'cutSeconds': boundary/rate})

def write(name, data):
    with wave.open(str(root/name), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(data)

write('short.wav', frames[2])
write('continuous.wav', pcm)
limits = [0] + boundaries + [len(samples)]
pieces = [pcm[limits[i]*2:limits[i+1]*2] for i in range(4)]
assert b''.join(pieces) == pcm, 'Piece boundaries must conserve every PCM sample exactly once'
for index, data in enumerate(pieces):
    write(f'piece-{index}.wav', data)
manifest = {
    'source': source, 'attribution': 'LibriSpeech (c) 2014 Vassil Panayotov, CC BY 4.0; public-domain audiobook speech',
    'sourceIds': ids, 'shortSeconds': len(frames[2])/(rate*2), 'longSeconds': len(pcm)/(rate*2),
    'pieceSeconds': [len(data)/(rate*2) for data in pieces], 'naturalPauses': pauses,
    'pcmConserved': True,
    'sha256': {name: hashlib.sha256((root/name).read_bytes()).hexdigest()
               for name in [f'{clip}.flac' for clip in ids] + ['short.wav', 'continuous.wav'] + [f'piece-{n}.wav' for n in range(4)]},
}
(root/'clip-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({key: manifest[key] for key in ['shortSeconds', 'longSeconds', 'pieceSeconds', 'naturalPauses', 'pcmConserved']}, indent=2))
