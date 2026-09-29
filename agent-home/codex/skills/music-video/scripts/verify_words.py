"""Proof sheet: for every word starting in [a, b), a frame 2 frames before and 3 after
its start, labelled with the word that should be on screen. Usage:
  python3 verify_words.py video.mp4 a b out.png [video_start_seconds]
"""

import json
import subprocess
import sys
import tempfile

video, a, b, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
offset = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
FPS = 60
words = [w for w in json.load(open('src/fullTimeline.json'))['words'] if a <= w['start'] < b]
tmp = tempfile.mkdtemp()
tiles = []
for i, w in enumerate(words):
    f0 = round(w['start'] * FPS)
    for tag, f in (('pre', f0 - 2), ('post', f0 + 3)):
        p = f'{tmp}/{i:03d}_{tag}.png'
        label = f"{w['text']} {w['start']:.2f} {tag}".replace("'", '').replace(':', '')
        subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{f / FPS - offset:.4f}', '-i', video, '-frames:v', '1',
                        '-vf', f"scale=216:384,drawtext=text='{label}':x=4:y=360:fontsize=16:fontcolor=white:box=1:boxcolor=black", p], check=True)
        tiles.append(p)
cols = 12
rows = (len(tiles) + cols - 1) // cols
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-pattern_type', 'glob', '-i', f'{tmp}/*.png',
                '-vf', f'tile={cols}x{rows}', '-frames:v', '1', out], check=True)
print(out, len(words), 'words')
