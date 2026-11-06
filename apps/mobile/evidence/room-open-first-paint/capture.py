"""Capture native Room/Tray navigation using the temporary profile.py hooks.

Select an emulator you own with ROOM_OPEN_DEVICE. Only the fixed Play Review
Workspace/Room is exercised. No controller, message send, or phone polling is
added to the application. All files stay in the current worktree.
"""
import argparse
import gzip
import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from analyze import analyze_sample

ROOM = 'bee11e00-0000-4000-8000-000000000103'
WORKSPACE = 'bee11e00-0000-4000-8000-000000000105'
REPO = Path(__file__).resolve().parents[4]
DEVICE = os.environ.get('ROOM_OPEN_DEVICE', '')


def adb(*args):
    return subprocess.check_output(['adb', '-s', DEVICE, *args], text=True,
                                   stderr=subprocess.STDOUT, timeout=60)


def open_list():
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d',
        'beeline://beeline/channels', '-p', 'app.usebeeline')


def target(identifier):
    adb('shell', 'uiautomator', 'dump', '/sdcard/room-open.xml')
    tree = ET.fromstring(adb('exec-out', 'cat', '/sdcard/room-open.xml'))
    if identifier != 'chat-back':
        assert any(node.get('resource-id') == 'workspace-active-' + WORKSPACE
                   for node in tree.iter('node')), 'The proof Workspace must be selected'
    for node in tree.iter('node'):
        if node.get('resource-id') == identifier:
            x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds', '')))
            assert x2 > x1 and y2 > y1, 'Target must be visible'
            return ((x1+x2)//2, (y1+y2)//2)
    raise RuntimeError('Missing proof UI target: ' + identifier)


def capture(label, kind, sample):
    if kind == 'cold':
        adb('shell', 'am', 'force-stop', 'app.usebeeline')
        open_list()
        time.sleep(4)
    else:
        open_list()
        time.sleep(1.8)
    point = target('workspace-tray' if kind == 'tray' else 'room-' + ROOM)
    if kind == 'back':
        adb('shell', 'input', 'tap', *map(str, point))
        time.sleep(2)
        point = target('chat-back')
    time.sleep(.5)
    adb('logcat', '-c')
    adb('shell', 'dumpsys', 'gfxinfo', 'app.usebeeline', 'reset')
    shell_start = float(adb('shell', 'cat', '/proc/uptime').split()[0]) * 1000
    adb('shell', 'input', 'tap', *map(str, point))
    time.sleep(1.5)
    gfx = adb('shell', 'dumpsys', 'gfxinfo', 'app.usebeeline', 'framestats')
    time.sleep(.6)  # Flush the buffered diagnostic log, outside the native window.
    log = adb('logcat', '-d', '-v', 'epoch', '-s', 'ReactNativeJS:V')
    safe = '\n'.join(line for line in log.splitlines() if any(
        '[' + tag + '] ' in line for tag in ('ROOM_PROFILE', 'ROOM_OPEN', 'LATENCY_FRAME')))
    return {'arm': label, 'kind': kind, 'sample': sample, 'shellStartMs': shell_start,
            'hostLoad': os.getloadavg(), 'log': safe, 'gfx': gfx}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label')
    parser.add_argument('--samples', type=int, default=10)
    parser.add_argument('--cases', default='cold,warm,tray,back')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'emulator-\d+', DEVICE):
        parser.error('Set ROOM_OPEN_DEVICE to your owned emulator serial.')
    if not 1 <= args.samples <= 50 or not re.fullmatch(r'[a-zA-Z0-9_-]+', args.label):
        parser.error('Use 1–50 samples and a simple label.')
    cases = args.cases.split(',')
    if set(cases) - {'cold', 'warm', 'tray', 'back'}:
        parser.error('Cases: cold,warm,tray,back')
    output = args.output.resolve()
    if not output.is_relative_to(REPO) or output.exists():
        parser.error('Choose a new output directory inside this worktree.')
    if adb('shell', 'getprop', 'ro.kernel.qemu').strip() != '1':
        parser.error('A disposable Android emulator is required.')
    output.mkdir(parents=True)
    records = []
    for kind in cases:
        for sample in range(args.samples):
            raw = capture(args.label, kind, sample)
            records.append(raw)
            stem = output / f'{kind}-{sample}'
            stem.with_suffix('.log').write_text(raw['log'])
            stem.with_suffix('.gfx').write_text(raw['gfx'])
            stem.with_suffix('.meta.json').write_text(json.dumps({key: value for key, value in raw.items()
                                                                if key not in ('log', 'gfx')}, indent=2))
            (output / 'raw-records.json.gz').write_bytes(gzip.compress(
                json.dumps(records).encode(), mtime=0))
            print(args.label, kind, sample, analyze_sample(raw)['nativeFrameMs'], flush=True)
