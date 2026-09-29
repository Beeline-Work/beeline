#!/usr/bin/env python3
"""Build a review sheet for a rendered chunk.

Row 1: evenly spaced frames across the chunk (scene/seam review).
Row 2: before/after pairs for sampled lyric words — the frame 2 frames before the
word's sung start, and the frame 3 frames after (the word should appear between them).
Usage: python3 chunkproof.py chunk.mp4 <first_frame> <out.png>
"""
import json, subprocess, sys, tempfile, os
path, first, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
n = int(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-count_packets','-show_entries','stream=nb_read_packets','-of','csv=p=0',path]).decode().strip().strip(','))
tmp = tempfile.mkdtemp()
def grab(local, name, label):
    p = os.path.join(tmp, name)
    subprocess.run(['ffmpeg','-v','error','-y','-ss',f'{local/60:.4f}','-i',path,'-frames:v','1','-vf',
        f"scale=200:-1,drawtext=text='{label}':x=6:y=6:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.7",p],check=True)
    return p
row1 = [grab(int(n*(i+0.5)/8), f's{i}.png', f'{(first+int(n*(i+0.5)/8))/60:.1f}s') for i in range(8)]
words = [w for w in json.load(open('src/fullTimeline.json'))['words'] if first+8 <= int(w['start']*60) <= first+n-8]
pick = words[:: max(1, len(words)//4)][:4]
row2 = []
for k, w in enumerate(pick):
    f0 = int(-(-w['start']*60//1)) - first
    row2 += [grab(f0-2, f'b{k}.png', f"{w['text']} -2f"), grab(f0+3, f'a{k}.png', f"{w['text']} +3f")]
subprocess.run(['montage',*row1,*row2,'-tile','8x','-geometry','+2+2','-background','#000',out],check=True)
print(out, f'({len(pick)} lyric pairs)')
