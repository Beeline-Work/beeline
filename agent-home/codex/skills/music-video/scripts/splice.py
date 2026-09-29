#!/usr/bin/env python3
"""Splice re-rendered segments into the master video, frame-exact.

Usage: python3 splice.py <master.mp4> <ranges.json> <out.mp4>
ranges.json: [[label, first_frame, last_frame], ...] with patch_<i>.mp4 beside it.
The master's audio is copied untouched; only video is re-encoded.
"""
import json
import os
import subprocess
import sys

master, ranges_path, out = sys.argv[1:4]
ranges = sorted(json.load(open(ranges_path)), key=lambda r: r[1])
base = os.path.dirname(ranges_path)
total = int(subprocess.check_output(
    ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', master]).decode().strip().strip(','))

inputs = ['-i', master]
chains, labels, cursor = [], [], 0
for i, (label, a, b) in enumerate(ranges):
    patch = os.path.join(base, f'patch_{i}.mp4')
    n = int(subprocess.check_output(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', patch]).decode().strip().strip(','))
    assert n == b - a + 1, f'{label}: patch has {n} frames, expected {b - a + 1}'
    inputs += ['-i', patch]
    chains.append(f'[0:v]trim=start_frame={cursor}:end_frame={a},setpts=PTS-STARTPTS[m{i}]')
    chains.append(f'[{i + 1}:v]setpts=PTS-STARTPTS[p{i}]')
    labels += [f'[m{i}]', f'[p{i}]']
    cursor = b + 1
chains.append(f'[0:v]trim=start_frame={cursor}:end_frame={total},setpts=PTS-STARTPTS[mend]')
labels.append('[mend]')
graph = ';'.join(chains) + ';' + ''.join(labels) + f'concat=n={len(labels)}:v=1:a=0[v]'
cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', graph, '-map', '[v]', '-map', '0:a',
       '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '60', '-c:a', 'copy', '-movflags', '+faststart', out]
subprocess.run(cmd, check=True)
got = int(subprocess.check_output(
    ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).decode().strip().strip(','))
print(f'spliced {len(ranges)} segments; frames {got}/{total}')
assert got == total
